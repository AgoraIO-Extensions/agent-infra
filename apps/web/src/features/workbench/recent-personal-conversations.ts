import { OpaqueCursorV1Schema } from "@agent-infra/contracts";
import { ConversationPageV1Schema } from "@agent-infra/contracts/pilot";
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

/** Identity, Web channel and global ordering are resolved by the producer. */
export async function loadRecentPersonalConversationsPage({
	cursor = null,
	limit = 5,
	signal,
	client,
}: {
	cursor?: string | null;
	limit?: number;
	signal: AbortSignal;
	client?: Client;
}): Promise<ListRecentPersonalConversationsV2Response> {
	signal.throwIfAborted();
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
		const page = ConversationPageV1Schema.safeParse(result.data);
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
