import { expect, it } from "vitest";
import {
	type RuntimeKeyedHandleScopeV4,
	validateRuntimeKeyedHandleTransitionV4,
} from "./driver-v4.js";

const k1: RuntimeKeyedHandleScopeV4 = {
	principal: { kind: "user", id: "alice" },
	executionSource: "web",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 1,
	hostSessionRef: "session-1",
	modelOptionId: "model-a",
	reasoningLevel: "high",
	keyBinding: {
		purpose: "personal",
		subjectId: "alice",
		ciphertextRef: "key-1",
		version: 1,
	},
};

it("reuses a native handle only within the same Execution and Key scope", () => {
	expect(validateRuntimeKeyedHandleTransitionV4(null, k1)).toBe("start");
	expect(validateRuntimeKeyedHandleTransitionV4(k1, k1)).toBe("reuse");
});

it("requires proved retirement even when model selection stays the same", () => {
	for (const changed of [
		{ ...k1, channelId: "wecom" },
		{ ...k1, principal: { kind: "user" as const, id: "bob" } },
		{ ...k1, executionId: "execution-2" },
		{ ...k1, keyBinding: { ...k1.keyBinding, version: 2 } },
		{ ...k1, keyBinding: { ...k1.keyBinding, subjectId: "bob" } },
		{ ...k1, hostSessionRef: "session-2" },
	]) {
		expect(() => validateRuntimeKeyedHandleTransitionV4(k1, changed)).toThrow(
			"Runtime keyed handle transition is unproven",
		);
		expect(() =>
			validateRuntimeKeyedHandleTransitionV4(k1, changed, {
				stopped: true,
				drained: false,
				sessionContinued: true,
			}),
		).toThrow("Runtime keyed handle transition is unproven");
		expect(
			validateRuntimeKeyedHandleTransitionV4(k1, changed, {
				stopped: true,
				drained: true,
				sessionContinued: true,
			}),
		).toBe("rebuild");
	}
});
