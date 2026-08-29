import { describe, expect, it } from "vitest";

import {
	ExecutionGrantV1Schema,
	RuntimeCapabilitiesV1Schema,
	RuntimeDriverLookupV1Schema,
	RuntimeDriverOperationRecordV1Schema,
	RuntimeEventV1Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeStopRequestV1Schema,
	RuntimeSubmitTurnRequestV1Schema,
	RuntimeSupplementRequestV1Schema,
} from "../../src/runtime/index.js";

const signedGrant = {
	schemaVersion: 1,
	format: "compact-jws",
	token: "header.payload.signature",
} as const;

const requestContext = {
	schemaVersion: 1,
	requestId: "request-runtime-1",
	traceId: "trace-runtime-1",
	actorId: "actor-1",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	deliveryFence: 4,
	grant: signedGrant,
} as const;

describe("RuntimeHost V1 wire schemas", () => {
	it("accepts versioned grant, command, replay, and normalized event shapes", () => {
		expect(ExecutionGrantV1Schema.parse(signedGrant)).toEqual(signedGrant);
		expect(
			RuntimeSubmitTurnRequestV1Schema.parse({
				...requestContext,
				input: { text: "synthetic-conformance-input", attachments: [] },
			}),
		).toMatchObject({ executionId: "execution-1", deliveryFence: 4 });
		expect(
			RuntimeSubmitTurnRequestV1Schema.parse({
				...requestContext,
				input: { attachments: ["attachment-1"] },
			}),
		).toMatchObject({ input: { attachments: ["attachment-1"] } });
		expect(
			RuntimeSupplementRequestV1Schema.parse({
				...requestContext,
				hostSessionRef: "host-session-1",
				messageId: "message-1",
				executionDeliveryFence: 4,
				deliveryFence: 2,
				input: { text: "synthetic-supplement", attachments: [] },
			}),
		).toMatchObject({
			messageId: "message-1",
			executionDeliveryFence: 4,
			deliveryFence: 2,
		});
		expect(
			RuntimeStopRequestV1Schema.parse({
				...requestContext,
				hostSessionRef: "host-session-1",
				stopRequestId: "stop-1",
				executionDeliveryFence: 4,
				deliveryFence: 2,
			}),
		).toMatchObject({ stopRequestId: "stop-1", executionDeliveryFence: 4 });
		expect(
			RuntimeReplayRequestV1Schema.parse({
				...requestContext,
				hostSessionRef: "host-session-1",
				afterCursor: "runtime-cursor-4",
			}),
		).toMatchObject({ afterCursor: "runtime-cursor-4" });
		expect(
			RuntimeEventV1Schema.parse({
				schemaVersion: 1,
				adapterEventKey: "adapter-event-5",
				executionId: "execution-1",
				cursor: "runtime-cursor-5",
				type: "status",
				occurredAt: "2026-08-28T12:00:00Z",
				payload: { status: "running" },
			}),
		).toMatchObject({ type: "status", payload: { status: "running" } });
		expect(
			RuntimeCapabilitiesV1Schema.parse({
				modelSelection: false,
				attachments: true,
				resultFiles: true,
				connection: false,
				supplementaryInstruction: true,
			}),
		).toMatchObject({ supplementaryInstruction: true });
	});

	it("rejects native protocol leakage, malformed fences, and expanded objects", () => {
		expect(
			RuntimeDriverLookupV1Schema.safeParse({
				state: "found",
				record: {
					schemaVersion: 1,
					operationId: "operation-1",
					nativeSessionRef: "native-1",
					result: {
						outcome: "rejected",
						code: "UPSTREAM_REJECTED",
						message: "Provider returned bearer secret-value",
						retryable: false,
					},
				},
			}).success,
		).toBe(false);
		expect(
			RuntimeDriverOperationRecordV1Schema.safeParse({
				schemaVersion: 1,
				operationId: "operation-1",
				nativeSessionRef: "native-1",
				result: {
					outcome: "rejected",
					code: "RUNTIME_TURN_NOT_ACTIVE",
					message: "Runtime turn is no longer active",
					retryable: false,
				},
			}).success,
		).toBe(true);
		expect(
			RuntimeSupplementRequestV1Schema.safeParse({
				...requestContext,
				hostSessionRef: "host-session-1",
				messageId: "message-1",
				input: { text: "synthetic-supplement", attachments: [] },
			}).success,
		).toBe(false);
		expect(
			RuntimeSubmitTurnRequestV1Schema.safeParse({
				...requestContext,
				nativeSessionId: "vendor-session-1",
				input: { text: "synthetic-conformance-input", attachments: [] },
			}).success,
		).toBe(false);
		expect(
			RuntimeSubmitTurnRequestV1Schema.safeParse({
				...requestContext,
				deliveryFence: 0,
				input: { text: "synthetic-conformance-input", attachments: [] },
			}).success,
		).toBe(false);
		expect(
			RuntimeSubmitTurnRequestV1Schema.safeParse({
				...requestContext,
				input: { attachments: [] },
			}).success,
		).toBe(false);
		expect(
			RuntimeEventV1Schema.safeParse({
				schemaVersion: 1,
				adapterEventKey: "adapter-event-5",
				executionId: "execution-1",
				cursor: "runtime-cursor-5",
				type: "text",
				occurredAt: "2026-08-28T12:00:00Z",
				payload: { delta: "synthetic-output", rawProtocolEvent: {} },
			}).success,
		).toBe(false);
		expect(
			ExecutionGrantV1Schema.safeParse({
				...signedGrant,
				format: "legacy-envelope",
			}).success,
		).toBe(false);
	});
});
