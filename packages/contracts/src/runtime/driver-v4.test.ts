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

it("reuses a native handle only with proven same-Execution continuity", () => {
	expect(validateRuntimeKeyedHandleTransitionV4(null, k1)).toBe("start");
	expect(
		validateRuntimeKeyedHandleTransitionV4(k1, k1, {
			stopped: false,
			drained: false,
			sessionContinued: true,
		}),
	).toBe("reuse");
});

it("rejects same-Execution reuse without continuity or after retirement", () => {
	expect(() => validateRuntimeKeyedHandleTransitionV4(k1, k1)).toThrow(
		"Runtime keyed handle transition is unproven",
	);
	for (const retirement of [
		{ stopped: true, drained: false, sessionContinued: true },
		{ stopped: false, drained: true, sessionContinued: true },
		{ stopped: true, drained: true, sessionContinued: true },
		{ stopped: false, drained: false, sessionContinued: false },
	]) {
		expect(() =>
			validateRuntimeKeyedHandleTransitionV4(k1, k1, retirement),
		).toThrow("Runtime keyed handle transition is unproven");
	}
});

it("rejects a changed Session scope or a Key rebind within one Execution", () => {
	for (const changed of [
		{ ...k1, channelId: "wecom" },
		{ ...k1, principal: { kind: "user" as const, id: "bob" } },
		{ ...k1, agentId: "agent-2" },
		{ ...k1, conversationId: "conversation-2" },
		{ ...k1, sessionGeneration: 2 },
		{ ...k1, executionSource: "wecom" as const },
		{ ...k1, keyBinding: { ...k1.keyBinding, version: 2 } },
		{ ...k1, keyBinding: { ...k1.keyBinding, subjectId: "bob" } },
		{ ...k1, modelOptionId: "model-b" },
		{ ...k1, reasoningLevel: "low" },
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
		expect(() =>
			validateRuntimeKeyedHandleTransitionV4(k1, changed, {
				stopped: true,
				drained: true,
				sessionContinued: true,
			}),
		).toThrow("Runtime keyed handle transition is unproven");
	}
});

it("rebuilds for an adjacent Execution only after the original Session is drained", () => {
	const next = {
		...k1,
		executionId: "execution-2",
		modelOptionId: "model-b",
		keyBinding: { ...k1.keyBinding, version: 2 },
	};
	expect(() => validateRuntimeKeyedHandleTransitionV4(k1, next)).toThrow(
		"Runtime keyed handle transition is unproven",
	);
	expect(() =>
		validateRuntimeKeyedHandleTransitionV4(k1, next, {
			stopped: true,
			drained: false,
			sessionContinued: true,
		}),
	).toThrow("Runtime keyed handle transition is unproven");
	expect(
		validateRuntimeKeyedHandleTransitionV4(k1, next, {
			stopped: true,
			drained: true,
			sessionContinued: true,
		}),
	).toBe("rebuild");
});
