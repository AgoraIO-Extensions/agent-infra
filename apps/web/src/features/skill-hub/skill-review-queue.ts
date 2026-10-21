import {
	SkillHubReviewContentV1Schema,
	SkillHubReviewQueuePageV1Schema,
} from "@agent-infra/contracts/pilot";
import { useQuery } from "@tanstack/react-query";
import type {
	Client,
	RequestResult,
} from "../../pilot/generated-v2/client/index.js";
import {
	listSkillHubReviewQueueV1,
	readSkillHubReviewContentV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	ListSkillHubReviewQueueV1Errors,
	ListSkillHubReviewQueueV1Responses,
	SkillHubReviewContentV1,
	SkillHubReviewQueueItemV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	type CollectionReadUnavailable,
	collectionReadFailure,
} from "../collection-read-failure.js";

export type SkillReviewQueueReadState =
	| { kind: "ready"; items: SkillHubReviewQueueItemV1[] }
	| CollectionReadUnavailable;

/** 审阅弹窗读取的待审正文；不可读时保留状态码对应的原因（无权、已不在队列、响应无效）。 */
export type SkillReviewContentReadState =
	| { kind: "ready"; content: SkillHubReviewContentV1["content"] }
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

/**
 * 审核正文（#3046）：只读一个待审版本；系统管理员身份与版本是否仍在队列都由服务端判定，
 * 页面只提交版本 ID。可重试失败交给 react-query 的 error 状态。
 */
export async function loadSkillReviewContent(
	skillVersionId: string,
	client?: Client,
	signal?: AbortSignal,
): Promise<SkillReviewContentReadState> {
	signal?.throwIfAborted();
	const result = await readSkillHubReviewContentV1<false>({
		client,
		path: { skillVersionId },
		signal,
		responseStyle: "fields",
		throwOnError: false,
	});
	signal?.throwIfAborted();
	const status = result.response?.status;
	if (status !== 200) return failure(collectionReadFailure(status));
	const parsed = SkillHubReviewContentV1Schema.safeParse(result.data);
	if (!parsed.success || parsed.data.skillVersionId !== skillVersionId)
		return failure({
			kind: "unavailable",
			retryable: false,
			reason: "invalid-response",
		});
	return { kind: "ready", content: parsed.data.content };
}

/**
 * 只在审阅弹窗打开时读取；查询键带身份，切换账号不复用上一个人的结果。
 * gcTime 为 0：弹窗关闭、内容组件卸载后正文不留在缓存里，再次打开重新读取。
 */
export function useSkillReviewContent({
	identityKey,
	skillVersionId,
	client,
}: {
	identityKey: string;
	skillVersionId: string;
	client?: Client;
}) {
	return useQuery({
		queryKey: ["skill-hub", "review-content", identityKey, skillVersionId],
		queryFn: ({ signal }) =>
			loadSkillReviewContent(skillVersionId, client, signal),
		enabled: Boolean(identityKey),
		retry: false,
		gcTime: 0,
	});
}
