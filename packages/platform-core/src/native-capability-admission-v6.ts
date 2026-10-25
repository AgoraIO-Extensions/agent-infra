import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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

export type NativeCapabilityAdmissionV6AuthorityBinding = Readonly<{
	agentId: string;
	actorId: string;
	channelId: string;
	authorizationRevision: string;
	sessionGeneration: number;
	hostSessionRef: string;
}>;

export type NativeCapabilityAdmissionV6KeyBinding = Readonly<{
	purpose: "personal" | "agent-default";
	subjectId: string;
	ciphertextRef: string;
	version: number;
}>;

export type NativeCapabilityAdmissionV6Decision =
	| {
			readonly outcome: "accepted" | "replayed";
			readonly plan: NativeCapabilityInvocationPlanV6;
	  }
	| {
			readonly outcome: "busy" | "denied" | "stale" | "unknown" | "unavailable";
			readonly reason?:
				| "authorization_lost"
				| "idempotency_in_progress"
				| "metadata_unavailable";
	  }
	| { readonly outcome: "conflict"; readonly reason: "idempotency_conflict" };

export interface NativeCapabilityAdmissionTransactionPortV6 {
	admitNativeCapabilityV6(input: {
		readonly request: NativeCapabilityAdmissionRequestV6;
		readonly authority: NativeCapabilityAdmissionV6AuthorityBinding;
		readonly keyBinding: NativeCapabilityAdmissionV6KeyBinding;
		readonly plan: NativeCapabilityInvocationPlanV6;
		readonly requestDigest: string;
		readonly operationDigest: string;
	}): Promise<NativeCapabilityAdmissionV6Decision>;
}

export interface NativeCapabilityAdmissionV6AuthorizationPort {
	authorize(input: { readonly conversationId: string }): Promise<
		| {
				readonly outcome: "allowed";
				readonly authority: NativeCapabilityAdmissionV6AuthorityBinding;
				readonly keyBinding: NativeCapabilityAdmissionV6KeyBinding;
		  }
		| { readonly outcome: "denied" }
	>;
}

export interface NativeCapabilityAdmissionUseCaseV6 {
	admit(input: unknown): Promise<NativeCapabilityAdmissionV6Decision>;
}

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
	const computedParametersDigest = createHash("sha256")
		.update(request.parameters)
		.digest("hex");
	if (
		request.capabilityKind !== "command" ||
		!digestPattern.test(request.capabilityId) ||
		!digestPattern.test(request.directoryRevision) ||
		!digestPattern.test(request.parametersDigest) ||
		request.parametersDigest !== computedParametersDigest ||
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

/** Re-checks the complete immutable binding at the Store transaction seam. */
export function validateNativeCapabilityInvocationPlanV6(
	plan: NativeCapabilityInvocationPlanV6,
	input: {
		readonly request: NativeCapabilityAdmissionRequestV6;
		readonly authority: NativeCapabilityAdmissionV6AuthorityBinding;
		readonly requestDigest: string;
		readonly operationDigest: string;
	},
): void {
	const { request, authority } = input;
	const keySubjectMatches =
		(plan.keyBinding.purpose === "personal" &&
			plan.keyBinding.subjectId === authority.actorId) ||
		(plan.keyBinding.purpose === "agent-default" &&
			plan.keyBinding.subjectId === authority.agentId);
	if (
		plan.schemaVersion !== 2 ||
		plan.kind !== "native-capability" ||
		plan.executionStatus !== "submitted" ||
		plan.conversationId !== request.conversationId ||
		plan.agentId !== authority.agentId ||
		plan.actorId !== authority.actorId ||
		plan.channelId !== authority.channelId ||
		plan.authorizationRevision !== authority.authorizationRevision ||
		plan.sessionGeneration !== authority.sessionGeneration ||
		plan.hostSessionRef.length === 0 ||
		plan.hostSessionRef !== authority.hostSessionRef ||
		plan.capabilityId !== request.capabilityId ||
		plan.directoryRevision !== request.directoryRevision ||
		plan.capabilitySourceVersion !== request.capabilitySourceVersion ||
		plan.parameters !== request.parameters ||
		plan.parametersDigest !== request.parametersDigest ||
		plan.modelOptionId !== request.modelOptionId ||
		plan.reasoningLevel !== request.reasoningLevel ||
		plan.configVersion !== request.configVersion ||
		plan.executionId !== request.idempotencyKey ||
		plan.keyBinding.ciphertextRef.length === 0 ||
		!Number.isSafeInteger(plan.keyBinding.version) ||
		plan.keyBinding.version < 1 ||
		!keySubjectMatches ||
		!digestPattern.test(plan.requestDigest) ||
		!digestPattern.test(plan.operationDigest) ||
		plan.requestDigest !== input.requestDigest ||
		plan.operationDigest !== input.operationDigest ||
		plan.outbox.id !== `conversation:native-capability:${plan.executionId}` ||
		plan.outbox.operation !== "conversation.native-capability.invoke.v2" ||
		!isDeepStrictEqual(plan.outbox.payload, request)
	)
		throw new TypeError("Native V6 admission plan is invalid");
}

export function createNativeCapabilityAdmissionUseCaseV6(dependencies: {
	readonly authorization: NativeCapabilityAdmissionV6AuthorizationPort;
	readonly transaction: NativeCapabilityAdmissionTransactionPortV6;
}): NativeCapabilityAdmissionUseCaseV6 {
	return {
		async admit(input) {
			const runtimeRequest =
				RuntimeNativeCapabilityRequestV6Schema.parse(input);
			const request = parseNativeCapabilityAdmissionRequestV6(runtimeRequest);
			const authorization = await dependencies.authorization.authorize({
				conversationId: request.conversationId,
			});
			if (authorization.outcome !== "allowed")
				return { outcome: "denied", reason: "authorization_lost" };
			const requestDigest = nativeCapabilityAdmissionRequestDigestV6(request);
			const operationDigest = nativeCapabilityOperationDigestV6(runtimeRequest);
			const plan: NativeCapabilityInvocationPlanV6 = {
				schemaVersion: 2,
				kind: "native-capability",
				conversationId: request.conversationId,
				agentId: authorization.authority.agentId,
				actorId: authorization.authority.actorId,
				channelId: authorization.authority.channelId,
				executionId: runtimeRequest.executionId,
				turnId: runtimeRequest.turnId,
				sessionGeneration: runtimeRequest.sessionGeneration,
				authorizationRevision: authorization.authority.authorizationRevision,
				hostSessionRef: authorization.authority.hostSessionRef,
				capabilityId: request.capabilityId,
				directoryRevision: request.directoryRevision,
				capabilitySourceVersion: request.capabilitySourceVersion,
				parameters: request.parameters,
				parametersDigest: request.parametersDigest,
				modelOptionId: request.modelOptionId,
				reasoningLevel: request.reasoningLevel,
				configVersion: request.configVersion,
				keyBinding: authorization.keyBinding,
				executionStatus: "submitted",
				outbox: {
					id: `conversation:native-capability:${runtimeRequest.executionId}`,
					operation: "conversation.native-capability.invoke.v2",
					payload: request,
				},
				requestDigest,
				operationDigest,
			};
			validateNativeCapabilityInvocationPlanV6(plan, {
				request,
				authority: authorization.authority,
				requestDigest,
				operationDigest,
			});
			return dependencies.transaction.admitNativeCapabilityV6({
				request,
				authority: authorization.authority,
				keyBinding: authorization.keyBinding,
				plan,
				requestDigest,
				operationDigest,
			});
		},
	};
}
