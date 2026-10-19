import { SkillHubReviewQueuePageV1Schema } from "@agent-infra/contracts/pilot";
import { useQuery } from "@tanstack/react-query";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import { listSkillHubReviewQueueV1 } from "../../pilot/generated-v2/sdk.gen.js";
import type {
	ListSkillHubReviewQueueV1Errors,
	ListSkillHubReviewQueueV1Responses,
	SkillHubReviewQueueItemV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	type CollectionReadUnavailable,
	collectionReadFailure,
} from "../collection-read-failure.js";

export type SkillReviewQueueReadState =
	| { kind: "ready"; items: SkillHubReviewQueueItemV1[] }
	| CollectionReadUnavailable;

const maximumPages = 50;

/** 可重试失败交给 react-query 的 error 状态，页面据此显示「重新读取」。 */
function failure(state: CollectionReadUnavailable): CollectionReadUnavailable {
	if (state.retryable)
		throw Object.assign(new Error("Skill review queue is unavailable"), {
			retryable: true as const,
		});
	return state;
}

/** 读完整个待审队列再显示，避免只显示前几页时把剩余版本当作不存在。 */
export async function loadSkillReviewQueue(
	client?: Client,
	signal?: AbortSignal,
): Promise<SkillReviewQueueReadState> {
	const items: SkillHubReviewQueueItemV1[] = [];
	const cursors = new Set<string>();
	let cursor: string | null = null;
	for (let page = 0; page < maximumPages; page += 1) {
		signal?.throwIfAborted();
		const result: Awaited<
			RequestResult<
				ListSkillHubReviewQueueV1Responses,
				ListSkillHubReviewQueueV1Errors,
				false
			>
		> = await listSkillHubReviewQueueV1<false>({
			client,
			query: cursor === null ? { limit: 100 } : { limit: 100, cursor },
			signal,
			responseStyle: "fields",
			throwOnError: false,
		});
		signal?.throwIfAborted();
		const status = result.response?.status;
		if (status !== 200) return failure(collectionReadFailure(status));
		const parsed = SkillHubReviewQueuePageV1Schema.safeParse(result.data);
		if (!parsed.success)
			return failure({
				kind: "unavailable",
				retryable: false,
				reason: "invalid-response",
			});
		items.push(...parsed.data.items);
		cursor = parsed.data.nextCursor;
		if (cursor === null) return { kind: "ready", items };
		if (cursors.has(cursor))
			return failure({
				kind: "unavailable",
				retryable: false,
				reason: "invalid-response",
			});
		cursors.add(cursor);
	}
	return failure({ kind: "unavailable", retryable: false });
}

/** 只有系统管理员读取；查询键带身份，切换账号不复用上一个人的队列。 */
export function useSkillReviewQueue({
	identityKey,
	enabled,
	client,
}: {
	identityKey: string;
	enabled: boolean;
	client?: Client;
}) {
	return useQuery({
		queryKey: ["skill-hub", "review-queue", identityKey],
		queryFn: ({ signal }) => loadSkillReviewQueue(client, signal),
		enabled: enabled && Boolean(identityKey),
		retry: false,
	});
}
