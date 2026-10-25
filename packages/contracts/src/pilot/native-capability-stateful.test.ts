import { expect, it } from "vitest";
import {
	NativeCapabilityInvocationRequestV1Schema,
	NativeCapabilityInvocationRequestV2Schema,
	NativeCapabilityInvocationRequestV3Schema,
} from "./native-capability.ts";

const request = {
	schemaVersion: 3,
	capabilityId: "a".repeat(64),
	directoryRevision: "b".repeat(64),
	parameters: "",
	idempotencyKey: "stateful-command",
	requestId: "request-stateful",
	traceId: "trace-stateful",
	selection: {
		schemaVersion: 1,
		modelOptionId: "model-1",
		reasoningLevel: "high",
	},
};

it("requires explicit V3 and model selection without widening V1 or V2", () => {
	expect(NativeCapabilityInvocationRequestV3Schema.parse(request)).toEqual(
		request,
	);
	expect(
		NativeCapabilityInvocationRequestV1Schema.safeParse(request).success,
	).toBe(false);
	expect(
		NativeCapabilityInvocationRequestV2Schema.safeParse(request).success,
	).toBe(false);
	const { schemaVersion: _version, ...unversioned } = request;
	expect(
		NativeCapabilityInvocationRequestV3Schema.safeParse(unversioned).success,
	).toBe(false);
	const { selection: _selection, ...noSelection } = request;
	expect(
		NativeCapabilityInvocationRequestV3Schema.safeParse(noSelection).success,
	).toBe(false);
});

it.each([
	{ attachments: ["file-1"] },
	{ effect: "read_only" },
	{ capabilityKind: "skill" },
	{ nativeMethod: "thread/compact/start" },
	{ principal: { kind: "user", id: "other-user" } },
	{ agentId: "other-agent" },
	{ executionId: "caller-execution" },
	{ hostSessionRef: "caller-session" },
	{ configVersion: "caller-configuration" },
	{ keyBinding: { ciphertextRef: "caller-key", version: 1 } },
	{ grant: "caller-grant" },
	{ parametersDigest: "c".repeat(64) },
	{ selection: { ...request.selection, endpoint: "https://invalid.example" } },
	{ selection: { ...request.selection, modelOptionId: "" } },
	{ selection: { ...request.selection, reasoningLevel: "" } },
])("rejects caller authority or invalid selection %j", (change) => {
	expect(
		NativeCapabilityInvocationRequestV3Schema.safeParse({
			...request,
			...change,
		}).success,
	).toBe(false);
});
