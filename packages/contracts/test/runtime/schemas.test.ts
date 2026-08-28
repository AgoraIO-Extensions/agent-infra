import { describe, expect, it } from "vitest";

import {
	RuntimeCapabilitiesV1Schema,
	RuntimeEventV1Schema,
	RuntimeReplayRequestV1Schema,
	RuntimeStopRequestV1Schema,
	RuntimeSubmitTurnRequestV1Schema,
	SignedExecutionGrantV1Schema,
} from "../../src/runtime/index.js";

const signedGrant = {
	schemaVersion: 1,
	algorithm: "Ed25519",
	keyId: "runtime-grant-key-1",
	payload: "eyJzY2hlbWFWZXJzaW9uIjoxfQ",
	signature: "c2lnbmF0dXJl",
} as const;

const requestContext = {
	schemaVersion: 1,
	requestId: "request-runtime-1",
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
		expect(SignedExecutionGrantV1Schema.parse(signedGrant)).toEqual(
			signedGrant,
		);
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
			SignedExecutionGrantV1Schema.safeParse({
				...signedGrant,
				algorithm: "HS256",
			}).success,
		).toBe(false);
	});
});
