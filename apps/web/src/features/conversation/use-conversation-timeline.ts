import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useSyncExternalStore,
} from "react";
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
		const offline = () => session.reader.disconnect();
		window.addEventListener("offline", offline);
		void session.reader.open(conversationId);
		if (!navigator.onLine) offline();
		return () => {
			window.removeEventListener("offline", offline);
			unsubscribe();
			session.reader.abort();
			clearDetails();
		};
	}, [session, queryClient, conversationId]);

	const executionRevision = timeline.events.findLast(
		(event) =>
			event.executionId === executionId &&
			(event.type === "execution.status" ||
				event.type === "execution.operation" ||
				event.type === "execution.detail" ||
				event.type === "conversation.error"),
	)?.eventId;
	const execution = useQuery({
		queryKey: [
			...session.queryScope,
			executionId ?? null,
			executionRevision ?? null,
		],
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
	const refresh = useCallback(async () => {
		if (!navigator.onLine) {
			session.reader.disconnect();
			return;
		}
		await session.reader.refresh();
		const state = session.reader.getSnapshot();
		if (state.status !== "ready" || !state.history) return;
		await queryClient.invalidateQueries(
			{ queryKey: session.queryScope, refetchType: "active" },
			{ cancelRefetch: false },
		);
	}, [session, queryClient]);
	const reconnect = useCallback(async () => {
		if (!navigator.onLine) {
			session.reader.disconnect();
			return;
		}
		await session.reader.reconnect();
	}, [session]);

	return {
		timeline,
		execution,
		refresh,
		reconnect,
		abort: session.reader.abort,
	};
}
