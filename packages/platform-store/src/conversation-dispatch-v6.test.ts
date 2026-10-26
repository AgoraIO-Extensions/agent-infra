import { describe, expect, it } from "vitest";
import { exactPayload } from "./conversation-dispatch-validation.js";

const binding = {
	schemaVersion: 2,
	kind: "native-capability",
	conversationId: "conversation-v6",
	agentId: "agent-v6",
	actorId: "actor-v6",
	principal: { kind: "user", id: "actor-v6" },
	executionSource: "web",
	operation: {
		kind: "execution",
		id: "execution-v6",
		deliveryFence: 2,
		executionDeliveryFence: 2,
	},
	channelId: "channel-v6",
	executionId: "execution-v6",
	turnId: "turn-v6",
	sessionGeneration: 1,
	authorizationRevision: "authorization-v6",
	taskBoundary: {
		schemaVersion: 1,
		principal: { kind: "user", id: "actor-v6" },
		agentId: "agent-v6",
		channelId: "channel-v6",
		agentAuthorizationRevision: "authorization-v6",
	},
	hostSessionRef: "host-v6",
	capabilityId: "a".repeat(64),
	directoryRevision: "b".repeat(64),
	capabilitySourceVersion: "source-v6",
	parameters: "",
	parametersDigest: "c".repeat(64),
	modelOptionId: "model-v6",
	reasoningLevel: "high",
	configVersion: "config-v6",
	keyBinding: {
		purpose: "personal",
		subjectId: "actor-v6",
		ciphertextRef: "key-v6",
		version: 1,
	},
	modelConfigurationRevision: 3,
	executionStatus: "submitted",
	requestDigest: "d".repeat(64),
	operationDigest: "e".repeat(64),
	requestId: "request-v6",
	traceId: "trace-v6",
	idempotencyKey: "idempotency-v6",
};

describe("V6 outbox payload validation", () => {
	it("projects a strict V6 binding from the v2 operation payload", () => {
		const payload = exactPayload(
			binding,
			"conversation.native-capability.invoke.v2",
		);
		expect(payload?.nativeCapabilityV6?.executionId).toBe("execution-v6");
	});

	it("rejects a V6 payload with a missing immutable digest", () => {
		const invalid = { ...binding, operationDigest: "" };
		expect(
			exactPayload(invalid, "conversation.native-capability.invoke.v2"),
		).toBeUndefined();
	});
});
