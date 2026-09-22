import {
	ConversationDetailProjectionV2Schema,
	ConversationSseMessageV2Schema,
	ExecutionDetailProjectionV2Schema,
	PersistedConversationEventV2Schema,
} from "@agent-infra/contracts/pilot";
import type { PersistedConversationEventV2 } from "../../pilot/generated-v2/types.gen.js";

export const timestamp = "2026-09-15T10:00:00Z";

export function event(sequence: number, conversationId = "conversation-1") {
	return PersistedConversationEventV2Schema.parse({
		schemaVersion: 1,
		kind: "event",
		eventId: `${conversationId}-event-${sequence}`,
		conversationId,
		executionId: "execution-1",
		sequence,
		conversationCursor: `${conversationId}-cursor-${sequence}`,
		occurredAt: timestamp,
		type: "text.delta",
		payload: { text: `output ${sequence}` },
	});
}

export function history(
	conversationId = "conversation-1",
	events: PersistedConversationEventV2[] = [event(1, conversationId)],
) {
	return ConversationDetailProjectionV2Schema.parse({
		schemaVersion: 2,
		conversation: {
			schemaVersion: 1,
			conversationId,
			agentId: "agent-1",
			title: "Test conversation",
			status: "active",
			selectedModelOptionId: null,
			selectedReasoningLevel: null,
			lastConversationCursor: events.at(-1)?.conversationCursor ?? null,
			createdAt: timestamp,
			updatedAt: timestamp,
		},
		messages: [],
		events,
	});
}

export function execution(
	conversationId = "conversation-1",
	executionId = "execution-1",
) {
	return ExecutionDetailProjectionV2Schema.parse({
		schemaVersion: 2,
		conversationId,
		executionId,
		status: "unknown",
		error: null,
		startedAt: timestamp,
		finishedAt: null,
		processSummary: [],
		events: [{ ...event(1, conversationId), executionId }],
	});
}

export function deferred<T>() {
	let resolve: (value: T) => void = () => {
		throw new Error("Deferred promise is not initialized");
	};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export function sse() {
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	const raw = (text: string) =>
		controller.enqueue(new TextEncoder().encode(text));
	return {
		response: new Response(body, {
			headers: { "content-type": "text/event-stream" },
		}),
		send(...messages: unknown[]) {
			raw(
				messages
					.map((input) => {
						const message = ConversationSseMessageV2Schema.parse(input);
						return `${message.kind === "event" ? `id: ${message.eventId}\n` : ""}data: ${JSON.stringify(message)}\n\n`;
					})
					.join(""),
			);
		},
		raw,
		disconnect() {
			controller.error(new TypeError("Test network disconnection"));
		},
		close() {
			controller.close();
		},
	};
}

export function reload(resumeCursor = "reload-cursor") {
	return ConversationSseMessageV2Schema.parse({
		schemaVersion: 1,
		kind: "control",
		type: "timeline.reload",
		reason: "cursor_expired",
		resumeCursor,
	});
}

export function route(request: Request) {
	const path = new URL(request.url).pathname;
	if (path.endsWith("/events")) return "stream";
	if (path.includes("/executions/")) return "execution";
	return "history";
}
