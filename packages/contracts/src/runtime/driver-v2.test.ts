import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	RuntimeDriverNativeCommandV1Schema,
	RuntimeDriverNativeCommandV2Schema,
	RuntimeDriverNativeCommandOperationRecordV2Schema,
} from "./driver.ts";

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

const stateful = {
	schemaVersion: 2 as const,
	kind: "native-command" as const,
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	operationId: "operation-1",
	nativeSessionRef: "native-session-1",
	capabilityId: digest("capability"),
	directoryRevision: digest("directory"),
	capabilityName: "compact",
	capabilitySourceVersion: "0.153.0",
	parameters: "{}",
	parametersDigest: digest("{}"),
	effect: "state_changing" as const,
	selection: {
		schemaVersion: 1 as const,
		modelOptionId: "sub2api:gpt-5.6-sol",
		reasoningLevel: "medium",
	},
	keyBinding: {
		purpose: "agent-default" as const,
		subjectId: "agent-1",
		ciphertextRef: "relay-key-1",
		version: 1,
	},
	authorizationRecordId: "authorization-1",
};

describe("stateful native command driver contract", () => {
	it("requires frozen selection, key binding, effect and authorization", () => {
		expect(RuntimeDriverNativeCommandV2Schema.parse(stateful)).toEqual(
			stateful,
		);
		for (const field of [
			"selection",
			"keyBinding",
			"authorizationRecordId",
			"effect",
		]) {
			const value = { ...stateful } as Record<string, unknown>;
			delete value[field];
			expect(RuntimeDriverNativeCommandV2Schema.safeParse(value).success).toBe(
				false,
			);
		}
	});

	it("does not widen the legacy read-only command contract", () => {
		expect(RuntimeDriverNativeCommandV1Schema.safeParse(stateful).success).toBe(
			false,
		);
		expect(
			RuntimeDriverNativeCommandV2Schema.safeParse({
				...stateful,
				effect: "read_only",
			}).success,
		).toBe(false);
	});

	it("keeps the stateful operation record versioned", () => {
		const parsed = RuntimeDriverNativeCommandOperationRecordV2Schema.parse({
			schemaVersion: 2,
			agentId: stateful.agentId,
			conversationId: stateful.conversationId,
			sessionGeneration: stateful.sessionGeneration,
			kind: "native-command",
			operationId: stateful.operationId,
			nativeSessionRef: stateful.nativeSessionRef,
			result: { outcome: "accepted", status: "completed" },
			effect: stateful.effect,
			selection: stateful.selection,
			keyBinding: stateful.keyBinding,
			authorizationRecordId: stateful.authorizationRecordId,
		});
		expect(parsed.schemaVersion).toBe(2);
	});
});
