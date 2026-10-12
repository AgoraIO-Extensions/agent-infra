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
		| "reconnecting"
		| "disconnected"
		| "unavailable"
		| "denied";
	/** Original persisted projection; render the merged timeline from events. */
	history: ConversationDetailProjectionV2 | null;
	events: readonly PersistedConversationEventV2[];
	failure: ConversationReadFailure | null;
	hasEarlier: boolean;
	beforeCursor: string | null;
	earlierLoading: boolean;
	earlierFailure: ConversationReadFailure | null;
};

type ReadingSession = {
	conversationId: string;
	historyRequest?: AbortController;
	stream?: AbortController;
	cursor: string | null;
	seenCursors: Set<string>;
	needsHistory: boolean;
	reloadCursor?: string;
	earlierRequest?: AbortController;
	/** Automatic reconnects since the stream last proved healthy (#1606). */
	reconnectAttempts?: number;
	reconnectTimer?: ReturnType<typeof setTimeout>;
};

/** Delays of automatic stream reconnects after a transient end (#1606). */
const defaultReconnectDelaysMs: readonly number[] = [
	500, 1_000, 2_000, 4_000, 8_000,
];
/** A stream the server accepted and kept open this long was healthy; its end
 * starts the automatic attempts afresh. */
const defaultHealthyStreamMs = 10_000;

function emptyState(): ConversationTimelineState {
	return {
		conversationId: null,
		status: "idle",
		history: null,
		events: [],
		failure: null,
		hasEarlier: false,
		beforeCursor: null,
		earlierLoading: false,
		earlierFailure: null,
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

function prependTimelineEvents(
	current: readonly PersistedConversationEventV2[],
	incoming: readonly PersistedConversationEventV2[],
): readonly PersistedConversationEventV2[] {
	const seen = new Set(current.map((event) => event.eventId));
	const added = incoming.filter((event) => {
		if (seen.has(event.eventId)) return false;
		seen.add(event.eventId);
		return true;
	});
	return added.length === 0 ? current : [...added, ...current];
}

/** Read-only, per-page consumer. Abort on unmount or identity changes. A
 * transient stream end reconnects automatically a bounded number of times, then
 * reconnect is explicit; both only resume reads and never replay a command. */
export function createConversationTimeline({
	client = defaultClient,
	reconnectDelaysMs = defaultReconnectDelaysMs,
	healthyStreamMs = defaultHealthyStreamMs,
}: {
	client?: Client;
	reconnectDelaysMs?: readonly number[];
	healthyStreamMs?: number;
} = {}) {
	let state = emptyState();
	let current: ReadingSession | undefined;
	const listeners = new Set<() => void>();

	function publish(next: ConversationTimelineState) {
		state = next;
		for (const listener of listeners) listener();
	}

	function cancelReconnect(session: ReadingSession | undefined) {
		if (!session?.reconnectTimer) return;
		clearTimeout(session.reconnectTimer);
		session.reconnectTimer = undefined;
	}

	/** Schedules the next automatic stream read; false once the delays are spent. */
	function scheduleReconnect(session: ReadingSession) {
		const attempt = session.reconnectAttempts ?? 0;
		const delay = reconnectDelaysMs[attempt];
		if (delay === undefined) return false;
		session.reconnectAttempts = attempt + 1;
		publish({ ...state, status: "reconnecting", failure: null });
		session.reconnectTimer = setTimeout(() => {
			session.reconnectTimer = undefined;
			if (current === session) void readStream(session);
		}, delay);
		return true;
	}

	function stop() {
		const previous = current;
		current = undefined;
		cancelReconnect(previous);
		previous?.historyRequest?.abort();
		previous?.stream?.abort();
		previous?.earlierRequest?.abort();
	}

	function fail(session: ReadingSession, failure: ConversationReadFailure) {
		if (current !== session) return;
		if (
			failure.kind === "authorization" ||
			failure.kind === "http" ||
			failure.kind === "invalid"
		) {
			stop();
			if (failure.kind === "http") {
				current = {
					conversationId: session.conversationId,
					cursor: null,
					seenCursors: new Set(),
					needsHistory: true,
				};
			}
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
		cancelReconnect(session);
		session.stream?.abort();
		session.historyRequest?.abort();
		session.earlierRequest?.abort();
		session.earlierRequest = undefined;
		const request = new AbortController();
		session.historyRequest = request;
		session.needsHistory = true;
		publish({
			...state,
			status: "loading",
			failure: null,
			earlierLoading: false,
			earlierFailure: null,
		});
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
		const beforeCursor = history.eventWindow?.beforeCursor ?? null;
		session.cursor =
			history.conversation.lastConversationCursor ??
			history.events.at(-1)?.conversationCursor ??
			session.reloadCursor ??
			null;
		session.seenCursors = new Set(
			session.cursor === null ? [] : [session.cursor],
		);
		session.needsHistory = false;
		session.reconnectAttempts = 0;
		publish({
			...state,
			status: "ready",
			history,
			events: reduceTimelineEvents([], history.events),
			failure: null,
			hasEarlier:
				history.eventWindow?.hasEarlier === true && beforeCursor !== null,
			beforeCursor,
			earlierLoading: false,
			earlierFailure: null,
		});
		void readStream(session);
	}

	async function loadEarlier(session: ReadingSession) {
		if (
			current !== session ||
			state.earlierLoading ||
			!state.hasEarlier ||
			!state.beforeCursor
		)
			return;
		const request = new AbortController();
		session.earlierRequest?.abort();
		session.earlierRequest = request;
		const beforeCursor = state.beforeCursor;
		publish({ ...state, earlierLoading: true, earlierFailure: null });
		let result: Awaited<ReturnType<typeof getConversationV2>>;
		try {
			result = await getConversationV2({
				client,
				path: { conversationId: session.conversationId },
				query: { beforeCursor },
				signal: request.signal,
				responseStyle: "fields",
				throwOnError: false,
			});
		} catch (error) {
			if (current !== session || request.signal.aborted) return;
			session.earlierRequest = undefined;
			const failure =
				error instanceof ConversationReadError
					? error.failure
					: ({ kind: "network" } as const);
			if (failure.kind === "authorization" || failure.kind === "invalid") {
				fail(session, failure);
				return;
			}
			publish({
				...state,
				earlierLoading: false,
				earlierFailure: failure,
			});
			return;
		}
		if (current !== session || request.signal.aborted) return;
		session.earlierRequest = undefined;
		if (!result.data || result.response?.status !== 200) {
			const failure = responseFailure(result.error, result.response?.status);
			if (failure.kind === "authorization" || failure.kind === "invalid") {
				fail(session, failure);
				return;
			}
			publish({
				...state,
				earlierLoading: false,
				earlierFailure: failure,
			});
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
		const eventWindow = parsed.data.eventWindow;
		const nextBeforeCursor = eventWindow?.beforeCursor ?? null;
		publish({
			...state,
			events: prependTimelineEvents(state.events, parsed.data.events),
			hasEarlier: eventWindow?.hasEarlier === true && nextBeforeCursor !== null,
			beforeCursor: nextBeforeCursor,
			earlierLoading: false,
			earlierFailure: null,
		});
	}

	async function readStream(session: ReadingSession) {
		if (current !== session) return;
		cancelReconnect(session);
		session.stream?.abort();
		const request = new AbortController();
		session.stream = request;
		// Set once the server accepts the stream; a request that is slow to fail
		// never counts as a healthy stream (#1606).
		const opened: { at?: number } = {};
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
					opened.at = performance.now();
					// The server accepted the reconnect after re-authorizing it.
					if (active() && state.status === "reconnecting")
						publish({ ...state, status: "ready", failure: null });
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
				const cursor = message.conversationCursor;
				const events = reduceTimelineEvents(state.events, [message]);
				if (events === state.events) continue;
				if (!cursor || session.seenCursors.has(cursor))
					throw new ConversationReadError({ kind: "invalid" });
				session.seenCursors.add(cursor);
				session.cursor = cursor;
				// A delivered event proves the stream healthy again.
				session.reconnectAttempts = 0;
				publish({ ...state, status: "ready", events, failure: null });
			}
			if (!active()) return;
			if (streamEnded(session, opened.at, streamFailure)) return;
			if (streamFailure) fail(session, streamFailure);
			else publish({ ...state, status: "disconnected" });
		} catch (error) {
			if (active()) {
				const failure =
					error instanceof ConversationReadError
						? error.failure
						: ({ kind: "network" } as const);
				if (!streamEnded(session, opened.at, failure)) fail(session, failure);
			}
		} finally {
			request.abort();
		}
	}

	/**
	 * A stream closed by the server without revocation, a network drop or a
	 * temporarily unavailable service reconnects from the last consumed cursor.
	 * Authorization, HTTP and invalid-data failures never do.
	 */
	function streamEnded(
		session: ReadingSession,
		acceptedAt: number | undefined,
		failure: ConversationReadFailure | undefined,
	) {
		if (failure && failure.kind !== "network" && failure.kind !== "service")
			return false;
		if (
			acceptedAt !== undefined &&
			performance.now() - acceptedAt >= healthyStreamMs
		)
			session.reconnectAttempts = 0;
		return scheduleReconnect(session);
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
				seenCursors: new Set(),
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
			cancelReconnect(session);
			session.reconnectAttempts = 0;
			if (session.needsHistory) await readHistory(session);
			else {
				publish({ ...state, status: "ready", failure: null });
				void readStream(session);
			}
		},
		async loadEarlier() {
			const session = current;
			if (session) await loadEarlier(session);
		},
		disconnect() {
			const session = current;
			if (!session) return;
			cancelReconnect(session);
			session.historyRequest?.abort();
			session.stream?.abort();
			session.earlierRequest?.abort();
			publish({
				...state,
				status: "disconnected",
				failure: { kind: "network" },
				earlierLoading: false,
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
