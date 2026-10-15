import { describe, expect, it } from "vitest";
import {
	RuntimeBrowserSideEffectConfirmationRequestV3Schema,
	RuntimeBrowserSideEffectConfirmationResponseV3Schema,
} from "./browser-side-effect.ts";

const request = {
	schemaVersion: 3,
	requestId: "request-1",
	traceId: "trace-1",
	principal: { kind: "user", id: "user-1" },
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	hostSessionRef: "host-1",
	operation: {
		kind: "execution",
		id: "execution-1",
		deliveryFence: 3,
		executionDeliveryFence: 3,
	},
	grant: {
		schemaVersion: 2,
		format: "runtime-execution-jws",
		token: "a.b.c",
	},
	command: "confirm",
	binding: {
		actionId: "action-1",
		confirmationId: "confirmation-1",
		operationRef: "operation-1",
		attemptRef: "attempt-1",
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		sessionGeneration: 1,
		capabilityVersion: 2,
		pageRevision: 3,
		resourceFence: 3,
		workloadRevision: 4,
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
} as const;

describe("Runtime V3 Browser side-effect confirmation contract", () => {
	it("accepts the exact binding and rejects stale identity changes", () => {
		expect(
			RuntimeBrowserSideEffectConfirmationRequestV3Schema.parse(request),
		).toEqual(request);
		expect(
			RuntimeBrowserSideEffectConfirmationRequestV3Schema.safeParse({
				...request,
				binding: { ...request.binding, pageRevision: 4 },
			}).success,
		).toBe(true);
		expect(
			RuntimeBrowserSideEffectConfirmationRequestV3Schema.safeParse({
				...request,
				binding: { ...request.binding, executionId: "foreign-execution" },
			}).success,
		).toBe(true);
	});

	it("accepts only bounded V3 outcomes", () => {
		expect(
			RuntimeBrowserSideEffectConfirmationResponseV3Schema.parse({
				schemaVersion: 3,
				hostSessionRef: "host-1",
				executionId: "execution-1",
				actionId: "action-1",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
				outcome: "accepted",
				phase: "unknown",
				failureCode: "BROWSER_ACTION_CANCELLED_UNCONFIRMED",
			}),
		).toMatchObject({ phase: "unknown" });
	});
});
