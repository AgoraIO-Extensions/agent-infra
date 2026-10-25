import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import {
	nativeCapabilityAdmissionRequestDigestV6,
	nativeCapabilityOperationDigestV6,
	parseNativeCapabilityAdmissionRequestV6,
	validateNativeCapabilityInvocationPlanV6,
} from "./native-capability-admission-v6.js";

const request = {
	schemaVersion: 6,
	requestId: "request-1",
	traceId: "trace-1",
	principal: { kind: "user", id: "alice" },
	executionSource: "web",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	hostSessionRef: "session-1",
	operation: {
		kind: "execution",
		id: "execution-1",
		deliveryFence: 2,
		executionDeliveryFence: 2,
	},
	grant: { schemaVersion: 6, format: "runtime-execution-jws", token: "a.b.c" },
	keyBinding: {
		purpose: "personal",
		subjectId: "alice",
		ciphertextRef: "key-1",
		version: 1,
	},
	capabilityId: "c".repeat(64),
	capabilityKind: "command",
	directoryRevision: "d".repeat(64),
	parameters: "compact",
	parametersDigest: createHash("sha256").update("compact").digest("hex"),
	capabilitySourceVersion: "0.153.0",
	selection: {
		schemaVersion: 1,
		modelOptionId: "model-option-primary",
		reasoningLevel: "high",
	},
	configVersion: "configuration-1",
} as const;

it("projects V6 request into a Store admission input with frozen selection/config", () => {
	const parsed = parseNativeCapabilityAdmissionRequestV6(request);
	expect(parsed).toMatchObject({
		schemaVersion: 6,
		modelOptionId: "model-option-primary",
		reasoningLevel: "high",
		configVersion: "configuration-1",
	});
	expect(nativeCapabilityAdmissionRequestDigestV6(parsed)).toBe(
		nativeCapabilityAdmissionRequestDigestV6(parsed),
	);
});

it.each([
	"selection",
	"configVersion",
	"capabilityId",
	"directoryRevision",
	"parametersDigest",
	"parameters",
])("rejects a V6 request missing %s before Store admission", (field) => {
	const value = { ...request } as Record<string, unknown>;
	delete value[field];
	expect(() => parseNativeCapabilityAdmissionRequestV6(value)).toThrow();
});

it("rejects a valid-looking but incorrect parameters digest", () => {
	const value = { ...request, parametersDigest: "a".repeat(64) };
	expect(() => parseNativeCapabilityAdmissionRequestV6(value)).toThrow();
});

it("changes operation identity when frozen selection or Key binding changes", () => {
	const first = nativeCapabilityOperationDigestV6(request);
	expect(
		nativeCapabilityOperationDigestV6({
			...request,
			selection: { ...request.selection, reasoningLevel: "low" },
		}),
	).not.toBe(first);
	expect(
		nativeCapabilityOperationDigestV6({
			...request,
			keyBinding: { ...request.keyBinding, version: 2 },
		}),
	).not.toBe(first);
});

function validPlan() {
	const parsed = parseNativeCapabilityAdmissionRequestV6(request);
	const authority = {
		agentId: "agent-1",
		actorId: "alice",
		channelId: "web",
		authorizationRevision: "auth-1",
		sessionGeneration: 1,
		hostSessionRef: "session-1",
	};
	const requestDigest = nativeCapabilityAdmissionRequestDigestV6(parsed);
	const operationDigest = nativeCapabilityOperationDigestV6(request);
	const plan = {
		schemaVersion: 2 as const,
		kind: "native-capability" as const,
		conversationId: parsed.conversationId,
		agentId: authority.agentId,
		actorId: authority.actorId,
		channelId: authority.channelId,
		executionId: parsed.idempotencyKey,
		turnId: "turn-1",
		sessionGeneration: authority.sessionGeneration,
		authorizationRevision: authority.authorizationRevision,
		hostSessionRef: authority.hostSessionRef,
		capabilityId: parsed.capabilityId,
		directoryRevision: parsed.directoryRevision,
		capabilitySourceVersion: parsed.capabilitySourceVersion,
		parameters: parsed.parameters,
		parametersDigest: parsed.parametersDigest,
		modelOptionId: parsed.modelOptionId,
		reasoningLevel: parsed.reasoningLevel,
		configVersion: parsed.configVersion,
		keyBinding: {
			purpose: "personal" as const,
			subjectId: authority.actorId,
			ciphertextRef: "ciphertext-1",
			version: 1,
		},
		executionStatus: "submitted" as const,
		outbox: {
			id: `conversation:native-capability:${parsed.idempotencyKey}`,
			operation: "conversation.native-capability.invoke.v2" as const,
			payload: parsed,
		},
		requestDigest,
		operationDigest,
	};
	return {
		authority,
		plan,
		input: { request: parsed, authority, requestDigest, operationDigest },
	};
}

it("accepts a fully frozen V6 plan at the Store seam", () => {
	const value = validPlan();
	expect(() =>
		validateNativeCapabilityInvocationPlanV6(value.plan, value.input),
	).not.toThrow();
});

it.each(["selection", "configVersion", "keyBinding", "authority", "outbox"])(
	"rejects V6 plan drift in %s before persistence",
	(field) => {
		const value = validPlan();
		const changed = structuredClone(value.plan) as typeof value.plan;
		if (field === "selection") changed.modelOptionId = "model-option-other";
		if (field === "configVersion")
			changed.configVersion = "configuration-other";
		if (field === "keyBinding") changed.keyBinding.ciphertextRef = "";
		if (field === "authority") changed.actorId = "bob";
		if (field === "outbox")
			changed.outbox.payload = {
				...changed.outbox.payload,
				parameters: "drift",
			};
		expect(() =>
			validateNativeCapabilityInvocationPlanV6(changed, value.input),
		).toThrow("Native V6 admission plan is invalid");
	},
);
