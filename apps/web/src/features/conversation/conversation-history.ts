import { OpaqueCursorV1Schema, OpaqueIdV1Schema } from "@agent-infra/contracts";
import {
	ConversationPageV1Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import type { Client } from "../../pilot/generated/client/index.js";
import { listConversations } from "../../pilot/generated/sdk.gen.js";
import type { ListConversationsResponse } from "../../pilot/generated/types.gen.js";
import { ConversationReadError, httpFailure } from "./execution-detail.js";

export type ConversationHistoryPage = ListConversationsResponse;

/** The server resolves the subject and Web channel. The lifecycle key never
 * enters this request, and untrusted error bodies never enter the Query cache. */
export async function loadConversationHistoryPage({
	agentId,
	cursor = null,
	signal,
	client,
}: {
	agentId: string;
	cursor?: string | null;
	signal: AbortSignal;
	client?: Client;
}): Promise<ConversationHistoryPage> {
	signal.throwIfAborted();
	if (
		!OpaqueIdV1Schema.safeParse(agentId).success ||
		(cursor !== null && !OpaqueCursorV1Schema.safeParse(cursor).success)
	)
		throw new ConversationReadError({ kind: "invalid" });
	try {
		const result = await listConversations({
			client,
			path: { agentId },
			query: { limit: 50, ...(cursor === null ? {} : { cursor }) },
			signal,
			responseStyle: "fields",
			throwOnError: false,
		});
		// A fetch implementation may ignore cancellation and still return data.
		signal.throwIfAborted();
		if (!result.data || result.response?.status !== 200) {
			const error = PilotProtocolErrorV1Schema.safeParse(result.error);
			if (
				error.success &&
				["AUTHENTICATION_REQUIRED", "AUTHORIZATION_REVOKED"].includes(
					error.data.code,
				)
			)
				throw new ConversationReadError({ kind: "authorization" });
			throw new ConversationReadError(httpFailure(result.response?.status));
		}
		const parsed = ConversationPageV1Schema.safeParse(result.data);
		if (
			!parsed.success ||
			parsed.data.items.length > 50 ||
			parsed.data.items.some((item) => item.agentId !== agentId) ||
			(parsed.data.nextCursor !== null && parsed.data.nextCursor === cursor)
		)
			throw new ConversationReadError({ kind: "invalid" });
		return parsed.data;
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof ConversationReadError) throw error;
		throw new ConversationReadError({ kind: "network" });
	}
}
