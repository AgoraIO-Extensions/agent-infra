import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import { createConversationTimeline } from "./conversation-timeline.js";
import {
	ConversationReadError,
	loadExecutionDetail,
} from "./execution-detail.js";

/** identityKey is a cache lifecycle key, never a wire identity. Change it on
 * login, logout, or principal changes, including a new login by the same user. */
export function useConversationTimeline({
	conversationId,
	executionId,
	identityKey,
	client,
}: {
	conversationId: string;
	executionId?: string;
	identityKey: string;
	client?: Client;
}) {
	const queryClient = useQueryClient();
	const instanceId = useId();
	const session = useMemo(
		() => ({
			reader: createConversationTimeline({ client }),
			queryScope: [
				"conversation-execution-detail",
				instanceId,
				identityKey,
				conversationId,
			],
		}),
		[client, instanceId, identityKey, conversationId],
	);
	const timeline = useSyncExternalStore(
		session.reader.subscribe,
		session.reader.getSnapshot,
		session.reader.getSnapshot,
	);

	useEffect(() => {
		const clearDetails = () => {
			void queryClient.cancelQueries({ queryKey: session.queryScope });
			queryClient.removeQueries({ queryKey: session.queryScope });
		};
		const unsubscribe = session.reader.subscribe(() => {
			const state = session.reader.getSnapshot();
			if (
				state.status === "denied" ||
				state.status === "idle" ||
				state.failure?.kind === "invalid"
			)
				clearDetails();
		});
		void session.reader.open(conversationId);
		return () => {
			unsubscribe();
			session.reader.abort();
			clearDetails();
		};
	}, [session, queryClient, conversationId]);

	const execution = useQuery({
		queryKey: [...session.queryScope, executionId ?? null],
		queryFn:
			timeline.history && executionId
				? async ({ signal }) => {
						try {
							return await loadExecutionDetail({
								conversationId,
								executionId,
								signal,
								client,
							});
						} catch (error) {
							if (
								!signal.aborted &&
								error instanceof ConversationReadError &&
								(error.failure.kind === "authorization" ||
									error.failure.kind === "invalid")
							) {
								session.reader.rejectRead(error.failure);
							}
							throw error;
						}
					}
				: skipToken,
		retry: false,
		placeholderData: undefined,
		gcTime: 0,
		staleTime: 0,
	});

	return {
		timeline,
		execution,
		reconnect: session.reader.reconnect,
		abort: session.reader.abort,
	};
}
