import { describe, expect, it } from "vitest";
import { exactPayload } from "./conversation-dispatch-validation.ts";

const payload = {
	schemaVersion: 1,
	conversationId: "conversation-native",
	agentId: "agent-native",
	actorId: "actor-native",
	channelId: "web",
	executionId: "execution-native",
	turnId: "turn-native",
	sessionGeneration: 2,
	capabilityId: "a".repeat(64),
	capabilityKind: "skill",
	directoryRevision: "b".repeat(64),
	parameters: "summary",
	parametersDigest: "c".repeat(64),
};

describe("Conversation Dispatch native capability payload", () => {
	it("projects the immutable plan binding into a claim payload", () => {
		expect(
			exactPayload(payload, "conversation.native-capability.invoke.v1"),
		).toMatchObject({
			conversationId: payload.conversationId,
			executionId: payload.executionId,
			turnId: null,
			nativeCapability: {
				agentId: payload.agentId,
				actorId: payload.actorId,
				channelId: payload.channelId,
				turnId: payload.turnId,
				capabilityId: payload.capabilityId,
				parameters: payload.parameters,
				parametersDigest: payload.parametersDigest,
			},
		});
	});

	it.each(["parameters", "parametersDigest", "directoryRevision"] as const)(
		"rejects a native payload missing %s",
		(field) => {
			const invalid = { ...payload } as Record<string, unknown>;
			delete invalid[field];
			expect(
				exactPayload(invalid, "conversation.native-capability.invoke.v1"),
			).toBeUndefined();
		},
	);
});
