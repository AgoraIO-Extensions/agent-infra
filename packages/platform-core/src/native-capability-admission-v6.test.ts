import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import {
	nativeCapabilityAdmissionRequestDigestV6,
	nativeCapabilityOperationDigestV6,
	parseNativeCapabilityAdmissionRequestV6,
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
])("rejects a V6 request missing %s before Store admission", (field) => {
	const value = { ...request } as Record<string, unknown>;
	delete value[field];
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
