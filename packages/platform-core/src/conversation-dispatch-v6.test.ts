import { describe, expect, it } from "vitest";
import { runtimeRequest } from "./conversation-dispatch-runtime.js";
import type { ConversationDispatchClaimV1 } from "./conversation-dispatch-types.js";

const claim = {
	schemaVersion: 1,
	itemId: "item-v6",
	leaseOwner: "worker-v6",
	operation: "conversation.native-capability.invoke.v2",
	requestId: "request-v6",
	traceId: "trace-v6",
	agentId: "agent-v6",
	actorId: "actor-v6",
	channelId: "channel-v6",
	conversationId: "conversation-v6",
	executionId: "execution-v6",
	turnId: "turn-v6",
	messageId: null,
	stopRequestId: null,
	sessionGeneration: 1,
	deliveryFence: 2,
	executionDeliveryFence: 2,
	authorizationRevision: "authorization-v6",
	modelConfigurationRevision: 3,
	modelOptionId: "model-v6",
	reasoningLevel: "high",
	hostSessionRef: "host-v6",
	runtimeCursor: null,
	input: null,
	executionStatus: "submitted",
	stopPending: false,
	nativeCapabilityV6: {
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
	},
} as unknown as ConversationDispatchClaimV1;

describe("V6 conversation dispatch consumer", () => {
	it("maps the V6 Store operation to a native Runtime request", () => {
		const request = runtimeRequest(claim, {
			schemaVersion: 1,
			agentId: "agent-v6",
			actorId: "actor-v6",
			channelId: "channel-v6",
			conversationId: "conversation-v6",
			executionId: "execution-v6",
			turnId: "turn-v6",
			sessionGeneration: 1,
			authorizationRevision: "authorization-v6",
			runtimeGrant: { kind: "test" },
		});
		expect(request.operation).toBe("native-capability.invoke");
		expect(request.nativeCapabilityV6?.executionId).toBe("execution-v6");
	});

	it("does not create a V6 request when the immutable binding is absent", () => {
		expect(() =>
			runtimeRequest(
				{ ...claim, nativeCapabilityV6: undefined },
				{
					schemaVersion: 1,
					agentId: "agent-v6",
					actorId: "actor-v6",
					channelId: "channel-v6",
					conversationId: "conversation-v6",
					executionId: "execution-v6",
					turnId: "turn-v6",
					sessionGeneration: 1,
					authorizationRevision: "authorization-v6",
					runtimeGrant: { kind: "test" },
				},
			),
		).toThrow();
	});
});
