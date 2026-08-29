import { describe, expect, it } from "vitest";
import { createDocument } from "zod-openapi";

import {
	ConversationSseMessageV1Schema,
	framePilotSseMessageV1,
	HeartbeatSignalV1Schema,
	PersistedConversationEventV1Schema,
	pilotBrowserSseOpenApiPathsV1,
	resolvePilotReplaySelectorV1,
} from "../../src/pilot/sse.js";

const baseEvent = {
	schemaVersion: 1,
	kind: "event",
	eventId: "event-11",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sequence: 11,
	conversationCursor: "cursor-conversation-1-11",
	occurredAt: "2026-08-28T10:00:00Z",
} as const;

describe("Pilot SSE contracts", () => {
	it("requires stable event identity, ordering fields, and typed payloads", () => {
		const event = {
			...baseEvent,
			type: "text.delta",
			payload: { text: "done" },
		};
		expect(PersistedConversationEventV1Schema.parse(event)).toEqual(event);
		expect(framePilotSseMessageV1(event)).toEqual({
			id: event.eventId,
			data: event,
		});
		expect(
			PersistedConversationEventV1Schema.safeParse({
				...event,
				eventId: undefined,
			}).success,
		).toBe(false);
		expect(
			PersistedConversationEventV1Schema.safeParse({
				...event,
				sequence: 0,
			}).success,
		).toBe(false);
		expect(
			PersistedConversationEventV1Schema.safeParse({
				...event,
				type: "vendor.native-event",
			}).success,
		).toBe(false);
		expect(
			ConversationSseMessageV1Schema.safeParse({
				...event,
				schemaVersion: 2,
			}).success,
		).toBe(false);
	});

	it("defines heartbeat, reload, and authorization controls outside persisted events", () => {
		const heartbeat = {
			schemaVersion: 1,
			kind: "control",
			type: "heartbeat",
			occurredAt: "2026-08-28T10:00:00Z",
		};
		const reload = {
			schemaVersion: 1,
			kind: "control",
			type: "timeline.reload",
			reason: "cross_conversation_cursor",
			resumeCursor: "cursor-conversation-1-latest",
		};
		const crossConversationEvent = {
			...reload,
			reason: "cross_conversation_event_id",
		};
		const revoked = {
			schemaVersion: 1,
			kind: "control",
			type: "authorization.revoked",
			error: {
				schemaVersion: 1,
				code: "AUTHORIZATION_REVOKED",
				message: "Conversation access is no longer available",
				retryable: false,
				traceId: "trace-1",
			},
		};
		expect(HeartbeatSignalV1Schema.parse(heartbeat)).toEqual(heartbeat);
		expect(framePilotSseMessageV1(heartbeat)).toEqual({ data: heartbeat });
		expect(ConversationSseMessageV1Schema.parse(heartbeat)).toEqual(heartbeat);
		expect(
			PersistedConversationEventV1Schema.safeParse(heartbeat).success,
		).toBe(false);
		expect(ConversationSseMessageV1Schema.parse(reload)).toEqual(reload);
		expect(
			ConversationSseMessageV1Schema.parse(crossConversationEvent),
		).toEqual(crossConversationEvent);
		expect(ConversationSseMessageV1Schema.parse(revoked)).toEqual(revoked);
		expect(
			ConversationSseMessageV1Schema.safeParse({
				...revoked,
				error: { ...revoked.error, retryable: true },
			}).success,
		).toBe(false);
	});

	it("publishes cursor and Last-Event-ID replay through the browser OpenAPI", () => {
		const document = createDocument({
			openapi: "3.1.0",
			info: { title: "Pilot SSE", version: "1.0.0" },
			paths: pilotBrowserSseOpenApiPathsV1,
		});
		const operation =
			document.paths?.["/api/v1/conversations/{conversationId}/events"]?.get;
		expect(operation?.operationId).toBe("streamConversationEvents");
		expect(operation?.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ in: "header", name: "Last-Event-ID" }),
				expect.objectContaining({ in: "query", name: "cursor" }),
			]),
		);
		expect(operation?.responses?.["200"]).toHaveProperty(
			"content.text/event-stream",
		);
		expect(operation?.responses?.["503"]).toHaveProperty(
			"content.application/json",
		);
		expect(operation).toHaveProperty("x-agent-infra-sse-framing", {
			controlId: null,
			persistedEventId: "eventId",
		});
		expect(operation).toHaveProperty("x-agent-infra-replay-selector", {
			header: "Last-Event-ID",
			mode: "at-most-one",
			query: "cursor",
		});
		expect(resolvePilotReplaySelectorV1({ cursor: "cursor-1" })).toEqual({
			kind: "cursor",
			value: "cursor-1",
		});
		expect(resolvePilotReplaySelectorV1({ lastEventId: "event-1" })).toEqual({
			kind: "last-event-id",
			value: "event-1",
		});
		expect(() =>
			resolvePilotReplaySelectorV1({
				cursor: "cursor-1",
				lastEventId: "event-1",
			}),
		).toThrow("Replay selector is ambiguous");
	});
});
