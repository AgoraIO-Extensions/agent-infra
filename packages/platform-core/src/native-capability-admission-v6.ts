import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
	type RuntimeNativeCapabilityRequestV6,
	RuntimeNativeCapabilityRequestV6Schema,
	runtimeOperationDigestInputV6,
} from "@agent-infra/contracts/runtime";
import { conversationExecutionSourceV1 } from "./conversation-execution-types.js";

const digestPattern = /^[a-f0-9]{64}$/u;

/** Store-owned input for the V6 stateful command admission transaction. */
export type NativeCapabilityAdmissionRequestV6 = Readonly<{
	schemaVersion: 6;
	principal: RuntimeNativeCapabilityRequestV6["principal"];
	executionSource: RuntimeNativeCapabilityRequestV6["executionSource"];
	agentId: string;
	channelId: string;
	sessionGeneration: number;
	hostSessionRef: string;
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

type NativeCapabilityInvocationBindingV6 = Readonly<{
	schemaVersion: 2;
	kind: "native-capability";
	conversationId: string;
	agentId: string;
	actorId: string;
	principal: RuntimeNativeCapabilityRequestV6["principal"];
	executionSource: RuntimeNativeCapabilityRequestV6["executionSource"];
	operation: RuntimeNativeCapabilityRequestV6["operation"];
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
	requestDigest: string;
	operationDigest: string;
}>;

export type NativeCapabilityInvocationPlanV6 =
	NativeCapabilityInvocationBindingV6 &
		Readonly<{
			outbox: Readonly<{
				id: string;
				operation: "conversation.native-capability.invoke.v2";
				payload: NativeCapabilityInvocationBindingV6 &
					Readonly<{
						requestId: string;
						traceId: string;
						idempotencyKey: string;
					}>;
			}>;
		}>;

export type NativeCapabilityAdmissionV6AuthorityBinding = Readonly<{
	conversationId: string;
	principal: RuntimeNativeCapabilityRequestV6["principal"];
	executionSource: RuntimeNativeCapabilityRequestV6["executionSource"];
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
		readonly runtimeRequest: RuntimeNativeCapabilityRequestV6;
		readonly keyBinding: NativeCapabilityAdmissionV6KeyBinding;
		readonly request: NativeCapabilityAdmissionRequestV6;
		readonly authority: NativeCapabilityAdmissionV6AuthorityBinding;
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
		principal: Object.freeze({ ...request.principal }),
		executionSource: request.executionSource,
		agentId: request.agentId,
		channelId: request.channelId,
		sessionGeneration: request.sessionGeneration,
		hostSessionRef: request.hostSessionRef,
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
	const { requestId: _requestId, traceId: _traceId, ...business } = request;
	return createHash("sha256")
		.update(JSON.stringify(canonical(business)))
		.digest("hex");
}

export function nativeCapabilityOperationDigestV6(
	request: RuntimeNativeCapabilityRequestV6,
): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(runtimeOperationDigestInputV6(request))))
		.digest("hex");
}

function runtimeAuthorityMatches(
	request: RuntimeNativeCapabilityRequestV6,
	authority: NativeCapabilityAdmissionV6AuthorityBinding,
	keyBinding: NativeCapabilityAdmissionV6KeyBinding,
): boolean {
	let source: RuntimeNativeCapabilityRequestV6["executionSource"];
	try {
		source = conversationExecutionSourceV1(authority.channelId);
	} catch {
		return false;
	}
	const personal = source === "web" || source === "wecom";
	if (
		source !== authority.executionSource ||
		(personal && authority.principal.kind !== "user") ||
		keyBinding.purpose !== (personal ? "personal" : "agent-default") ||
		keyBinding.subjectId !== (personal ? authority.actorId : authority.agentId)
	)
		return false;

	return (
		request.conversationId === authority.conversationId &&
		request.agentId === authority.agentId &&
		request.principal.id === authority.actorId &&
		isDeepStrictEqual(request.principal, authority.principal) &&
		request.executionSource === authority.executionSource &&
		request.channelId === authority.channelId &&
		request.sessionGeneration === authority.sessionGeneration &&
		request.hostSessionRef === authority.hostSessionRef &&
		isDeepStrictEqual(request.keyBinding, keyBinding)
	);
}

function freezePlan<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freezePlan(child);
		Object.freeze(value);
	}
	return value;
}

function frozenPlanV6(
	runtimeRequest: RuntimeNativeCapabilityRequestV6,
	request: NativeCapabilityAdmissionRequestV6,
	authority: NativeCapabilityAdmissionV6AuthorityBinding,
	keyBinding: NativeCapabilityAdmissionV6KeyBinding,
): NativeCapabilityInvocationPlanV6 {
	const requestDigest = nativeCapabilityAdmissionRequestDigestV6(request);
	const operationDigest = nativeCapabilityOperationDigestV6(runtimeRequest);
	const binding: NativeCapabilityInvocationBindingV6 = {
		schemaVersion: 2,
		kind: "native-capability",
		conversationId: request.conversationId,
		agentId: authority.agentId,
		actorId: authority.actorId,
		principal: structuredClone(runtimeRequest.principal),
		executionSource: runtimeRequest.executionSource,
		operation: structuredClone(runtimeRequest.operation),
		channelId: authority.channelId,
		executionId: runtimeRequest.executionId,
		turnId: runtimeRequest.turnId,
		sessionGeneration: runtimeRequest.sessionGeneration,
		authorizationRevision: authority.authorizationRevision,
		hostSessionRef: authority.hostSessionRef,
		capabilityId: request.capabilityId,
		directoryRevision: request.directoryRevision,
		capabilitySourceVersion: request.capabilitySourceVersion,
		parameters: request.parameters,
		parametersDigest: request.parametersDigest,
		modelOptionId: request.modelOptionId,
		reasoningLevel: request.reasoningLevel,
		configVersion: request.configVersion,
		keyBinding: structuredClone(keyBinding),
		executionStatus: "submitted",
		requestDigest,
		operationDigest,
	};
	const plan: NativeCapabilityInvocationPlanV6 = freezePlan({
		...binding,
		outbox: {
			id: `conversation:native-capability:${runtimeRequest.executionId}`,
			operation: "conversation.native-capability.invoke.v2",
			payload: {
				...binding,
				requestId: request.requestId,
				traceId: request.traceId,
				idempotencyKey: request.idempotencyKey,
			},
		},
	});
	return plan;
}

/** Re-checks the complete immutable binding at the Store transaction seam. */
export function validateNativeCapabilityInvocationPlanV6(
	plan: NativeCapabilityInvocationPlanV6,
	input: {
		readonly runtimeRequest: RuntimeNativeCapabilityRequestV6;
		readonly keyBinding: NativeCapabilityAdmissionV6KeyBinding;
		readonly request: NativeCapabilityAdmissionRequestV6;
		readonly authority: NativeCapabilityAdmissionV6AuthorityBinding;
		readonly requestDigest: string;
		readonly operationDigest: string;
	},
): void {
	const { request, authority } = input;
	const runtimeRequest = RuntimeNativeCapabilityRequestV6Schema.parse(
		input.runtimeRequest,
	);
	const expected = frozenPlanV6(
		runtimeRequest,
		parseNativeCapabilityAdmissionRequestV6(runtimeRequest),
		authority,
		input.keyBinding,
	);
	if (
		!runtimeAuthorityMatches(runtimeRequest, authority, input.keyBinding) ||
		!isDeepStrictEqual(
			request,
			parseNativeCapabilityAdmissionRequestV6(runtimeRequest),
		) ||
		input.requestDigest !== expected.requestDigest ||
		input.operationDigest !== expected.operationDigest ||
		!isDeepStrictEqual(plan, expected)
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
			const authority = structuredClone(authorization.authority);
			const keyBinding = structuredClone(authorization.keyBinding);
			if (!runtimeAuthorityMatches(runtimeRequest, authority, keyBinding))
				return { outcome: "denied", reason: "authorization_lost" };
			const plan = frozenPlanV6(runtimeRequest, request, authority, keyBinding);
			const { requestDigest, operationDigest } = plan;
			validateNativeCapabilityInvocationPlanV6(plan, {
				runtimeRequest,
				keyBinding,
				request,
				authority,
				requestDigest,
				operationDigest,
			});
			return dependencies.transaction.admitNativeCapabilityV6(
				freezePlan({
					runtimeRequest,
					request,
					authority,
					keyBinding,
					plan,
					requestDigest,
					operationDigest,
				}),
			);
		},
	};
}
