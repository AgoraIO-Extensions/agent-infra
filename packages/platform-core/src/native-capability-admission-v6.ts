import { createHash } from "node:crypto";

import {
	type RuntimeNativeCapabilityRequestV6,
	RuntimeNativeCapabilityRequestV6Schema,
	runtimeOperationDigestInputV6,
} from "@agent-infra/contracts/runtime";

const digestPattern = /^[a-f0-9]{64}$/u;

/** Store-owned input for the V6 stateful command admission transaction. */
export type NativeCapabilityAdmissionRequestV6 = Readonly<{
	schemaVersion: 6;
	conversationId: string;
	capabilityId: string;
	directoryRevision: string;
	capabilitySourceVersion: string;
	parameters: string;
	parametersDigest: string;
	modelOptionId: string;
	reasoningLevel: string;
	configVersion: string;
	idempotencyKey: string;
	requestId: string;
	traceId: string;
}>;

export type NativeCapabilityInvocationPlanV6 = Readonly<{
	schemaVersion: 2;
	kind: "native-capability";
	conversationId: string;
	agentId: string;
	actorId: string;
	channelId: string;
	executionId: string;
	turnId: string;
	sessionGeneration: number;
	authorizationRevision: string;
	hostSessionRef: string;
	capabilityId: string;
	directoryRevision: string;
	capabilitySourceVersion: string;
	parameters: string;
	parametersDigest: string;
	modelOptionId: string;
	reasoningLevel: string;
	configVersion: string;
	keyBinding: Readonly<{
		purpose: "personal" | "agent-default";
		subjectId: string;
		ciphertextRef: string;
		version: number;
	}>;
	executionStatus: "submitted";
	outbox: Readonly<{
		id: string;
		operation: "conversation.native-capability.invoke.v2";
		payload: NativeCapabilityAdmissionRequestV6;
	}>;
	requestDigest: string;
	operationDigest: string;
}>;

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	}
	return value;
}

export function parseNativeCapabilityAdmissionRequestV6(
	input: unknown,
): NativeCapabilityAdmissionRequestV6 {
	const request = RuntimeNativeCapabilityRequestV6Schema.parse(input);
	if (
		request.capabilityKind !== "command" ||
		!digestPattern.test(request.capabilityId) ||
		!digestPattern.test(request.directoryRevision) ||
		!digestPattern.test(request.parametersDigest) ||
		request.operation.kind !== "execution" ||
		request.operation.id !== request.executionId ||
		request.operation.deliveryFence !== request.operation.executionDeliveryFence
	)
		throw new TypeError("Native V6 admission request is invalid");
	return Object.freeze({
		schemaVersion: 6,
		conversationId: request.conversationId,
		capabilityId: request.capabilityId,
		directoryRevision: request.directoryRevision,
		capabilitySourceVersion: request.capabilitySourceVersion,
		parameters: request.parameters,
		parametersDigest: request.parametersDigest,
		modelOptionId: request.selection.modelOptionId,
		reasoningLevel: request.selection.reasoningLevel,
		configVersion: request.configVersion,
		idempotencyKey: request.executionId,
		requestId: request.requestId,
		traceId: request.traceId,
	});
}

export function nativeCapabilityAdmissionRequestDigestV6(
	request: NativeCapabilityAdmissionRequestV6,
): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(request)))
		.digest("hex");
}

export function nativeCapabilityOperationDigestV6(
	request: RuntimeNativeCapabilityRequestV6,
): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(runtimeOperationDigestInputV6(request))))
		.digest("hex");
}
