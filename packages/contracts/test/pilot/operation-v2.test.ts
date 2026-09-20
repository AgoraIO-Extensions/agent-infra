import { describe, expect, it } from "vitest";
import { createDocument } from "zod-openapi";

import { ExecutionDetailProjectionV1Schema } from "../../src/pilot/browser.js";
import {
	ConversationSseMessageV2Schema,
	ExecutionDetailProjectionV2Schema,
	ExecutionOperationEventV2Schema,
	framePilotSseMessageV2,
	PersistedConversationEventV2Schema,
	pilotOperationOpenApiPathsV2,
	pilotOperationSchemasV2,
} from "../../src/pilot/operation-v2.js";
import {
	ConversationSseMessageV1Schema,
	framePilotSseMessageV1,
} from "../../src/pilot/sse.js";
import { RuntimeOperationFactV2Schema } from "../../src/runtime/events-v2.js";

const original = {
	schemaVersion: 1,
	kind: "event",
	eventId: "original-text",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sequence: 1,
	conversationCursor: "cursor-1",
	occurredAt: "2026-09-14T12:00:00Z",
	type: "text.delta",
	payload: { text: "Original output" },
} as const;
const operation = {
	...original,
	schemaVersion: 2,
	eventId: "operation-event",
	sequence: 2,
	conversationCursor: "cursor-2",
	type: "execution.operation",
	payload: {
		kind: "model",
		operationRef: "operation-1",
		attemptRef: "attempt-1",
		phase: "unknown",
		failureCode: "response_incomplete",
		model: {
			configVersion: "config-1",
			modelOptionId: "option-1",
			modelId: "model-1",
		},
	},
} as const;

describe("Pilot mixed-version operation contracts", () => {
	it("reuses the public Runtime fact schema and preserves all original V1 event bytes", () => {
		expect(ExecutionOperationEventV2Schema.shape.payload).toBe(
			RuntimeOperationFactV2Schema,
		);
		expect(ConversationSseMessageV2Schema.parse(original)).toEqual(
			ConversationSseMessageV1Schema.parse(original),
		);
		expect(framePilotSseMessageV2(original)).toEqual(
			framePilotSseMessageV1(original),
		);
		expect(PersistedConversationEventV2Schema.parse(operation)).toEqual(
			operation,
		);
		expect(ConversationSseMessageV1Schema.safeParse(operation).success).toBe(
			false,
		);
		expect(
			ConversationSseMessageV2Schema.safeParse({
				...original,
				schemaVersion: 2,
			}).success,
		).toBe(false);
	});

	it("keeps unknown measurements absent and rejects raw request data or SSE id injection", () => {
		const fact = ExecutionOperationEventV2Schema.parse(operation);
		expect(fact.payload).not.toHaveProperty("usage");
		expect(fact.payload).not.toHaveProperty("durationMs");
		for (const input of [
			{ ...operation, eventId: "event\ndata: private" },
			{
				...operation,
				payload: { ...operation.payload, prompt: "private request" },
			},
			{
				...operation,
				payload: {
					...operation.payload,
					failureCode: "private upstream failure",
				},
			},
		])
			expect(ExecutionOperationEventV2Schema.safeParse(input).success).toBe(
				false,
			);
	});

	it("adds complete events to V2 execution detail without changing V1 detail", () => {
		const legacy = {
			schemaVersion: 1,
			executionId: "execution-1",
			conversationId: "conversation-1",
			status: "unknown",
			processSummary: [],
			startedAt: null,
			finishedAt: null,
			error: null,
		};
		const mixed = {
			...legacy,
			schemaVersion: 2,
			events: [original, operation],
		};
		expect(ExecutionDetailProjectionV1Schema.parse(legacy)).toEqual(legacy);
		expect(ExecutionDetailProjectionV2Schema.parse(mixed)).toEqual(mixed);
		expect(ExecutionDetailProjectionV1Schema.safeParse(mixed).success).toBe(
			false,
		);
		expect(
			ExecutionDetailProjectionV2Schema.safeParse({
				...mixed,
				events: undefined,
			}).success,
		).toBe(false);
	});

	it("exposes only bounded Connection references on tools across history and SSE", () => {
		const tool = {
			...operation,
			payload: {
				kind: "tool",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
				phase: "completed",
				toolId: "connection.execute_action",
				connection: {
					serviceRef: "connection-local",
					verification: "verified",
					callRef: "call-1",
				},
			},
		} as const;
		for (const connection of [
			tool.payload.connection,
			{
				serviceRef: "connection-local",
				verification: "unverified",
				reason: "receipt_missing",
			},
		]) {
			const event = { ...tool, payload: { ...tool.payload, connection } };
			expect(PersistedConversationEventV2Schema.parse(event)).toEqual(event);
			expect(framePilotSseMessageV2(event).data).toEqual(event);
		}
		for (const connection of [
			{ ...tool.payload.connection, accessToken: "sentinel-private-token" },
			{ ...tool.payload.connection, operationNonce: "nonce-1" },
			{ ...tool.payload.connection, requestDigest: "a".repeat(64) },
			{ ...tool.payload.connection, principal: { type: "user", key: "alice" } },
			{ ...tool.payload.connection, actor: { type: "agent", key: "agent-1" } },
			{ ...tool.payload.connection, credentialRevision: "revision-1" },
			{ ...tool.payload.connection, status: "succeeded" },
			{
				...tool.payload.connection,
				callRef: "https://connection.invalid/call/1",
			},
			{ ...tool.payload.connection, callRef: "a".repeat(129) },
			{ ...tool.payload.connection, callRef: undefined },
			{ ...tool.payload.connection, reason: "receipt_missing" },
			{ serviceRef: "connection-local", verification: "unverified" },
		]) {
			expect(
				ExecutionOperationEventV2Schema.safeParse({
					...tool,
					payload: { ...tool.payload, connection },
				}).success,
			).toBe(false);
		}
		expect(
			ExecutionOperationEventV2Schema.safeParse({
				...operation,
				payload: { ...operation.payload, connection: tool.payload.connection },
			}).success,
		).toBe(false);
	});

	it("publishes only the three versioned reads with shared replay and framing semantics", () => {
		const document = createDocument({
			openapi: "3.1.0",
			info: { title: "Operation reads", version: "2.0.0" },
			paths: pilotOperationOpenApiPathsV2,
			components: { schemas: pilotOperationSchemasV2 },
		});
		expect(Object.keys(document.paths ?? {})).toEqual([
			"/api/v2/conversations/{conversationId}",
			"/api/v2/conversations/{conversationId}/executions/{executionId}",
			"/api/v2/conversations/{conversationId}/events",
		]);
		const stream =
			document.paths?.["/api/v2/conversations/{conversationId}/events"]?.get;
		expect(stream?.operationId).toBe("streamConversationEventsV2");
		expect(stream?.["x-agent-infra-sse-framing"]).toEqual({
			controlId: null,
			persistedEventId: "eventId",
		});
		expect(document.components?.schemas?.RuntimeOperationFactV2).toBeDefined();
	});
});
