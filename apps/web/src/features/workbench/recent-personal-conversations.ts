import { OpaqueCursorV1Schema } from "@agent-infra/contracts";
import { RecentPersonalConversationPageV2Schema } from "@agent-infra/contracts/pilot";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import { listRecentPersonalConversationsV2 } from "../../pilot/generated-v2/sdk.gen.js";
import type { ListRecentPersonalConversationsV2Response } from "../../pilot/generated-v2/types.gen.js";
import {
	type CollectionReadUnavailable,
	collectionReadFailure,
} from "../collection-read-failure.js";

export class RecentPersonalConversationsError extends Error {
	constructor(readonly state: CollectionReadUnavailable) {
		super("Personal recent conversations could not be read");
	}
}

export const invalidRecentPage = (): RecentPersonalConversationsError =>
	new RecentPersonalConversationsError({
		kind: "unavailable",
		retryable: false,
		reason: "invalid-response",
	});

/** 共享读取的默认页大小：对话页「最近对话」面板每页 50 条；工作台按需传更小的值。 */
export const recentPersonalConversationsPageLimit = 50;

/** Identity, Web channel and global ordering are resolved by the producer. */
export async function loadRecentPersonalConversationsPage({
	cursor = null,
	signal,
	client,
	limit = recentPersonalConversationsPageLimit,
}: {
	cursor?: string | null;
	signal: AbortSignal;
	client?: Client;
	/** 1–50 的整数；响应条数超过它视为无效响应。 */
	limit?: number;
}): Promise<ListRecentPersonalConversationsV2Response> {
	signal.throwIfAborted();
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > recentPersonalConversationsPageLimit
	)
		throw new RangeError("Recent conversation page limit must be 1–50");
	if (cursor !== null && !OpaqueCursorV1Schema.safeParse(cursor).success)
		throw invalidRecentPage();
	try {
		const result = await listRecentPersonalConversationsV2({
			client,
			query: { limit, ...(cursor === null ? {} : { cursor }) },
			signal,
			responseStyle: "fields",
			throwOnError: false,
		});
		signal.throwIfAborted();
		if (result.response?.status !== 200)
			throw new RecentPersonalConversationsError(
				collectionReadFailure(result.response?.status),
			);
		// 渠道资格无法确认的 Agent 只列在 unavailableAgentIds，不让整页失败（#3379）。
		const page = RecentPersonalConversationPageV2Schema.safeParse(result.data);
		if (
			!page.success ||
			page.data.items.length > limit ||
			(page.data.nextCursor !== null && page.data.nextCursor === cursor)
		)
			throw invalidRecentPage();
		return page.data;
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof RecentPersonalConversationsError) throw error;
		throw new RecentPersonalConversationsError(
			collectionReadFailure(undefined),
		);
	}
}
