import { describe, expect, it } from "vitest";
import { createDocument } from "zod-openapi";

import {
	ConversationSseMessageV1Schema,
	PersistedConversationEventV1Schema,
	pilotBrowserSseOpenApiPathsV1,
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
	});

	it("defines reload and current-authorization signals separately from persisted events", () => {
		const reload = {
			schemaVersion: 1,
			kind: "control",
			type: "timeline.reload",
			reason: "cross_conversation_cursor",
			resumeCursor: "cursor-conversation-1-latest",
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
		expect(ConversationSseMessageV1Schema.parse(reload)).toEqual(reload);
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
	});
});
