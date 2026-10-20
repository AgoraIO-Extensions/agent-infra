import { createHash } from "node:crypto";
import { nativeCapabilityParametersDigestV1 } from "@agent-infra/platform-core";
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
	capabilitySourceVersion: "1.2.3",
	parameters: "summary",
	parametersDigest: nativeCapabilityParametersDigestV1("summary"),
};

describe("Conversation Dispatch native capability payload", () => {
	it("rejects the historical JSON-encoded parameter digest without rewriting it (#2950)", () => {
		expect(
			exactPayload(
				{
					...payload,
					parametersDigest: createHash("sha256")
						.update(JSON.stringify(payload.parameters))
						.digest("hex"),
				},
				"conversation.native-capability.invoke.v1",
			),
		).toBeUndefined();
	});

	it("accepts an admitted command with no parameters", () => {
		expect(
			exactPayload(
				{
					...payload,
					capabilityKind: "command",
					parameters: "",
					parametersDigest: nativeCapabilityParametersDigestV1(""),
				},
				"conversation.native-capability.invoke.v1",
			),
		).toMatchObject({ nativeCapability: { parameters: "" } });
	});
	it("projects the immutable plan binding into a claim payload", () => {
		expect(
			exactPayload(payload, "conversation.native-capability.invoke.v1"),
		).toMatchObject({
			conversationId: payload.conversationId,
			executionId: payload.executionId,
			turnId: payload.turnId,
			nativeCapability: {
				agentId: payload.agentId,
				actorId: payload.actorId,
				channelId: payload.channelId,
				turnId: payload.turnId,
				capabilityId: payload.capabilityId,
				parameters: payload.parameters,
				parametersDigest: payload.parametersDigest,
				capabilitySourceVersion: payload.capabilitySourceVersion,
			},
		});
	});
	it.each(["\0", "\ud800", "a".repeat(16 * 1024 + 1)])(
		"rejects malformed or oversized native parameters",
		(parameters) => {
			expect(
				exactPayload(
					{
						...payload,
						parameters,
						parametersDigest: nativeCapabilityParametersDigestV1(parameters),
					},
					"conversation.native-capability.invoke.v1",
				),
			).toBeUndefined();
		},
	);

	it.each([
		"parameters",
		"parametersDigest",
		"directoryRevision",
		"capabilitySourceVersion",
	] as const)("rejects a native payload missing %s", (field) => {
		const invalid = { ...payload } as Record<string, unknown>;
		delete invalid[field];
		expect(
			exactPayload(invalid, "conversation.native-capability.invoke.v1"),
		).toBeUndefined();
	});
});
