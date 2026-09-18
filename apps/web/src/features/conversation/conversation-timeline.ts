import {
	ConversationDetailProjectionV2Schema,
	ConversationSseMessageV2Schema,
} from "@agent-infra/contracts/pilot";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import { client as defaultClient } from "../../pilot/generated-v2/client.gen.js";
import {
	getConversationV2,
	streamConversationEventsV2,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	ConversationDetailProjectionV2,
	PersistedConversationEventV2,
} from "../../pilot/generated-v2/types.gen.js";
import {
	ConversationReadError,
	type ConversationReadFailure,
	responseFailure,
} from "./execution-detail.js";

export type ConversationTimelineState = {
	conversationId: string | null;
	status:
		| "idle"
		| "loading"
		| "ready"
		| "disconnected"
		| "unavailable"
		| "denied";
	/** Original persisted projection; render the merged timeline from events. */
	history: ConversationDetailProjectionV2 | null;
	events: readonly PersistedConversationEventV2[];
	failure: ConversationReadFailure | null;
};

type ReadingSession = {
	conversationId: string;
	historyRequest?: AbortController;
	stream?: AbortController;
	cursor: string | null;
	needsHistory: boolean;
	reloadCursor?: string;
};

function emptyState(): ConversationTimelineState {
	return {
		conversationId: null,
		status: "idle",
		history: null,
		events: [],
		failure: null,
	};
}

// Preserve the server's order and original V1/V2 facts; cursors are opaque and
// execution sequence numbers cannot order events from different executions.
function reduceTimelineEvents(
	current: readonly PersistedConversationEventV2[],
	incoming: readonly PersistedConversationEventV2[],
): readonly PersistedConversationEventV2[] {
	const seen = new Set(current.map((event) => event.eventId));
	const added = incoming.filter((event) => {
		if (seen.has(event.eventId)) return false;
		seen.add(event.eventId);
		return true;
	});
	return added.length === 0 ? current : [...current, ...added];
}

/** Read-only, per-page consumer. Abort on unmount or identity changes. Reconnect
 * is explicit and only resumes reads; it never replays an execution command. */
export function createConversationTimeline({
	client = defaultClient,
}: {
	client?: Client;
} = {}) {
	let state = emptyState();
	let current: ReadingSession | undefined;
	const listeners = new Set<() => void>();

	function publish(next: ConversationTimelineState) {
		state = next;
		for (const listener of listeners) listener();
	}

	function stop() {
		const previous = current;
		current = undefined;
		previous?.historyRequest?.abort();
		previous?.stream?.abort();
	}

	function fail(session: ReadingSession, failure: ConversationReadFailure) {
		if (current !== session) return;
		if (failure.kind === "authorization" || failure.kind === "invalid") {
			stop();
			publish({
				...emptyState(),
				conversationId: session.conversationId,
				status: failure.kind === "authorization" ? "denied" : "unavailable",
				failure,
			});
			return;
		}
		publish({ ...state, status: "unavailable", failure });
	}

	async function readHistory(session: ReadingSession) {
		if (current !== session) return;
		session.stream?.abort();
		session.historyRequest?.abort();
		const request = new AbortController();
		session.historyRequest = request;
		session.needsHistory = true;
		publish({ ...state, status: "loading", failure: null });
		let result: Awaited<ReturnType<typeof getConversationV2>>;
		try {
			result = await getConversationV2({
				client,
				path: { conversationId: session.conversationId },
				signal: request.signal,
				responseStyle: "fields",
				throwOnError: false,
			});
		} catch (error) {
			if (current !== session || request.signal.aborted) return;
			fail(
				session,
				error instanceof ConversationReadError
					? error.failure
					: { kind: "network" },
			);
			return;
		}
		if (current !== session || request.signal.aborted) return;
		if (!result.data || result.response?.status !== 200) {
			fail(session, responseFailure(result.error, result.response?.status));
			return;
		}
		const parsed = ConversationDetailProjectionV2Schema.safeParse(result.data);
		if (
			!parsed.success ||
			parsed.data.conversation.conversationId !== session.conversationId ||
			parsed.data.events.some(
				(event) => event.conversationId !== session.conversationId,
			)
		) {
			fail(session, { kind: "invalid" });
			return;
		}
		const history = parsed.data;
		session.cursor =
			history.conversation.lastConversationCursor ??
			history.events.at(-1)?.conversationCursor ??
			session.reloadCursor ??
			null;
		session.needsHistory = false;
		publish({
			...state,
			status: "ready",
			history,
			events: reduceTimelineEvents([], history.events),
			failure: null,
		});
		void readStream(session);
	}

	async function readStream(session: ReadingSession) {
		if (current !== session) return;
		session.stream?.abort();
		const request = new AbortController();
		session.stream = request;
		const active = () => current === session && !request.signal.aborted;
		let streamFailure: ConversationReadFailure | undefined;
		try {
			const { stream } = await streamConversationEventsV2({
				client,
				path: { conversationId: session.conversationId },
				query: session.cursor === null ? undefined : { cursor: session.cursor },
				signal: request.signal,
				// The generated parser retries internally and drops HTTP status.
				// One attempt lets this consumer enforce terminal authorization and
				// reconnect with only the last successfully consumed cursor.
				sseMaxRetryAttempts: 1,
				fetch: async (input, init) => {
					const fetcher = client.getConfig().fetch ?? globalThis.fetch;
					const streamRequest = new Request(input, init);
					// A shared client's previous replay header must not compete with
					// this conversation's explicit cursor selector.
					streamRequest.headers.delete("Last-Event-ID");
					const response = await fetcher(streamRequest);
					if (!response.ok) {
						let error: unknown;
						try {
							error = await response.json();
						} catch {
							error = undefined;
						}
						throw new ConversationReadError(
							responseFailure(error, response.status),
						);
					}
					if (!response.body)
						throw new ConversationReadError({ kind: "invalid" });
					return response;
				},
				onSseError: (error) => {
					streamFailure =
						error instanceof ConversationReadError
							? error.failure
							: { kind: "network" };
				},
			});
			for await (const input of stream) {
				if (!active()) return;
				const parsed = ConversationSseMessageV2Schema.safeParse(input);
				if (!parsed.success)
					throw new ConversationReadError({ kind: "invalid" });
				const message = parsed.data;
				if (message.kind === "control") {
					if (message.type === "authorization.revoked") {
						fail(session, { kind: "authorization" });
						return;
					}
					if (message.type === "timeline.reload") {
						session.reloadCursor = message.resumeCursor;
						request.abort();
						await readHistory(session);
						return;
					}
					continue;
				}
				if (message.conversationId !== session.conversationId) {
					throw new ConversationReadError({ kind: "invalid" });
				}
				const events = reduceTimelineEvents(state.events, [message]);
				if (events === state.events) continue;
				session.cursor = message.conversationCursor;
				publish({ ...state, status: "ready", events, failure: null });
			}
			if (!active()) return;
			if (streamFailure) fail(session, streamFailure);
			else publish({ ...state, status: "disconnected" });
		} catch (error) {
			if (active()) {
				fail(
					session,
					error instanceof ConversationReadError
						? error.failure
						: { kind: "network" },
				);
			}
		} finally {
			request.abort();
		}
	}

	return {
		getSnapshot: () => state,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async open(conversationId: string) {
			stop();
			const session: ReadingSession = {
				conversationId,
				cursor: null,
				needsHistory: true,
			};
			current = session;
			publish({ ...emptyState(), conversationId, status: "loading" });
			await readHistory(session);
		},
		async refresh() {
			const session = current;
			if (session) await readHistory(session);
		},
		async reconnect() {
			const session = current;
			if (!session) return;
			if (session.needsHistory) await readHistory(session);
			else {
				publish({ ...state, status: "ready", failure: null });
				void readStream(session);
			}
		},
		disconnect() {
			const session = current;
			if (!session) return;
			session.historyRequest?.abort();
			session.stream?.abort();
			publish({
				...state,
				status: "disconnected",
				failure: { kind: "network" },
			});
		},
		rejectRead(failure: ConversationReadFailure) {
			if (current) fail(current, failure);
		},
		abort() {
			stop();
			publish(emptyState());
		},
	};
}
