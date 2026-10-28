import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { parseAuthority } from "./conversation-execution-input.js";
import {
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionSourceV1,
	type ConversationModelConfigurationV1,
	conversationExecutionSourceV1,
} from "./conversation-execution-types.js";
import {
	isPositiveSafeInteger,
	snapshotObject,
} from "./conversation-execution-values.js";
import {
	type NativeCapabilityAdmissionRequestV3,
	parseNativeCapabilityAdmissionRequestV3,
} from "./native-capability-admission.js";
import {
	parseTaskPrincipalV1,
	type TaskAuthorizationBoundaryV1,
	type TaskPrincipalV1,
} from "./task-authorization.js";

const digestPattern = /^[a-f0-9]{64}$/u;
/** Unsigned, server-resolved context; transport DTOs and Grants stay outside Core. */
type NativeCapabilityAdmissionContextV6 = Readonly<{
	schemaVersion: 6;
	requestId: string;
	traceId: string;
	principal: TaskPrincipalV1;
	executionSource: ConversationExecutionSourceV1;
	channelId: string;
	agentId: string;
	conversationId: string;
	executionId: string;
	turnId: string;
	sessionGeneration: number;
	hostSessionRef: string;
	operation: Readonly<{
		kind: "execution";
		id: string;
		deliveryFence: number;
		executionDeliveryFence: number;
	}>;
	keyBinding: NativeCapabilityAdmissionV6KeyBinding;
	capabilityId: string;
	capabilityKind: "command";
	directoryRevision: string;
	parameters: string;
	parametersDigest: string;
	capabilitySourceVersion: string;
	selection: NativeCapabilityAdmissionRequestV3["selection"];
	configVersion: string;
}>;

function contextText(
	value: unknown,
	maximum = Number.POSITIVE_INFINITY,
	allowEmpty = false,
): string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		value.length > maximum
	)
		throw new TypeError("Native V6 admission context is invalid");
	return value;
}

function parseRuntimeInput(input: unknown): NativeCapabilityAdmissionContextV6 {
	const value = snapshotObject(input, [
		"schemaVersion",
		"requestId",
		"traceId",
		"principal",
		"executionSource",
		"channelId",
		"agentId",
		"conversationId",
		"executionId",
		"turnId",
		"sessionGeneration",
		"hostSessionRef",
		"operation",
		"keyBinding",
		"capabilityId",
		"capabilityKind",
		"directoryRevision",
		"parameters",
		"parametersDigest",
		"capabilitySourceVersion",
		"selection",
		"configVersion",
	]);
	const principal = parseTaskPrincipalV1(
		snapshotObject(value.principal, ["kind", "id"]),
	);
	const operation = snapshotObject(value.operation, [
		"kind",
		"id",
		"deliveryFence",
		"executionDeliveryFence",
	]);
	const keyBinding = snapshotObject(value.keyBinding, [
		"purpose",
		"subjectId",
		"ciphertextRef",
		"version",
	]);
	const selection = snapshotObject(value.selection, [
		"schemaVersion",
		"modelOptionId",
		"reasoningLevel",
	]);
	if (
		value.schemaVersion !== 6 ||
		value.capabilityKind !== "command" ||
		(value.executionSource !== "web" &&
			value.executionSource !== "wecom" &&
			value.executionSource !== "platform-api" &&
			value.executionSource !== "eval") ||
		!isPositiveSafeInteger(value.sessionGeneration) ||
		operation.kind !== "execution" ||
		!isPositiveSafeInteger(operation.deliveryFence) ||
		!isPositiveSafeInteger(operation.executionDeliveryFence) ||
		operation.id !== value.executionId ||
		operation.deliveryFence !== operation.executionDeliveryFence ||
		(keyBinding.purpose !== "personal" &&
			keyBinding.purpose !== "agent-default") ||
		!isPositiveSafeInteger(keyBinding.version) ||
		selection.schemaVersion !== 1
	)
		throw new TypeError("Native V6 admission context is invalid");
	const parameters = contextText(value.parameters, 16 * 1024, true);
	const parametersDigest = contextText(value.parametersDigest);
	const capabilityId = contextText(value.capabilityId);
	const directoryRevision = contextText(value.directoryRevision);
	const configVersion = contextText(value.configVersion);
	if (
		!digestPattern.test(capabilityId) ||
		!digestPattern.test(directoryRevision) ||
		!digestPattern.test(parametersDigest) ||
		parametersDigest !==
			createHash("sha256").update(parameters).digest("hex") ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(configVersion)
	)
		throw new TypeError("Native V6 admission context is invalid");
	return Object.freeze({
		schemaVersion: 6,
		requestId: contextText(value.requestId),
		traceId: contextText(value.traceId),
		principal: Object.freeze(principal),
		executionSource: value.executionSource,
		channelId: contextText(value.channelId),
		agentId: contextText(value.agentId),
		conversationId: contextText(value.conversationId),
		executionId: contextText(value.executionId),
		turnId: contextText(value.turnId),
		sessionGeneration: value.sessionGeneration,
		hostSessionRef: contextText(value.hostSessionRef),
		operation: Object.freeze({
			kind: "execution",
			id: contextText(operation.id),
			deliveryFence: operation.deliveryFence,
			executionDeliveryFence: operation.executionDeliveryFence,
		}),
		keyBinding: Object.freeze({
			purpose: keyBinding.purpose,
			subjectId: contextText(keyBinding.subjectId),
			ciphertextRef: contextText(keyBinding.ciphertextRef),
			version: keyBinding.version,
		}),
		capabilityId,
		capabilityKind: "command",
		directoryRevision,
		parameters,
		parametersDigest,
		capabilitySourceVersion: contextText(value.capabilitySourceVersion, 512),
		selection: Object.freeze({
			schemaVersion: 1,
			modelOptionId: contextText(selection.modelOptionId),
			reasoningLevel: contextText(selection.reasoningLevel),
		}),
		configVersion,
	});
}

/** Store-owned input for the V6 stateful command admission transaction. */
export type NativeCapabilityAdmissionRequestV6 = Readonly<{
	schemaVersion: 6;
	principal: TaskPrincipalV1;
	executionSource: ConversationExecutionSourceV1;
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

export type NativeCapabilityInvocationBindingV6 = Readonly<{
	schemaVersion: 2;
	kind: "native-capability";
	conversationId: string;
	agentId: string;
	actorId: string;
	principal: TaskPrincipalV1;
	executionSource: ConversationExecutionSourceV1;
	operation: NativeCapabilityAdmissionContextV6["operation"];
	channelId: string;
	executionId: string;
	turnId: string;
	sessionGeneration: number;
	authorizationRevision: string;
	taskBoundary: TaskAuthorizationBoundaryV1;
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
	modelConfigurationRevision: number;
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
	principal: TaskPrincipalV1;
	executionSource: ConversationExecutionSourceV1;
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
				| "conversation_unavailable"
				| "idempotency_in_progress"
				| "metadata_unavailable";
	  }
	| { readonly outcome: "conflict"; readonly reason: "idempotency_conflict" };

export interface NativeCapabilityAdmissionTransactionPortV6 {
	admitNativeCapabilityV6(
		input: {
			readonly runtimeRequest: NativeCapabilityAdmissionContextV6;
			readonly invocation: NativeCapabilityAdmissionRequestV3;
			readonly keyBinding: NativeCapabilityAdmissionV6KeyBinding;
			readonly request: NativeCapabilityAdmissionRequestV6;
			readonly authority: NativeCapabilityAdmissionV6AuthorityBinding;
			readonly taskAuthority: ConversationExecutionAuthorityV1;
			readonly modelConfigurationRevision: number;
			readonly plan: NativeCapabilityInvocationPlanV6;
			readonly requestDigest: string;
			readonly operationDigest: string;
		},
		isAuthorized: () => Promise<boolean>,
	): Promise<NativeCapabilityAdmissionV6Decision>;
}

export interface NativeCapabilityAdmissionV6AuthorizationPort {
	authorize(input: { readonly conversationId: string }): Promise<
		| {
				readonly outcome: "allowed";
				readonly authority: NativeCapabilityAdmissionV6AuthorityBinding;
				readonly taskAuthority: ConversationExecutionAuthorityV1;
				readonly modelConfigurationRevision: number;
				readonly keyBinding: NativeCapabilityAdmissionV6KeyBinding;
		  }
		| { readonly outcome: "denied" }
	>;
}

export interface NativeCapabilityAdmissionUseCaseV6 {
	admit(
		input: unknown,
		invocation: unknown,
	): Promise<NativeCapabilityAdmissionV6Decision>;
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
	publicInput: unknown,
): NativeCapabilityAdmissionRequestV6 {
	const request = parseRuntimeInput(input);
	const invocation = parseNativeCapabilityAdmissionRequestV3(publicInput);
	const computedParametersDigest = createHash("sha256")
		.update(request.parameters)
		.digest("hex");
	if (
		invocation.conversationId !== request.conversationId ||
		invocation.capabilityId !== request.capabilityId ||
		invocation.directoryRevision !== request.directoryRevision ||
		invocation.parameters !== request.parameters ||
		!isDeepStrictEqual(invocation.selection, request.selection) ||
		invocation.requestId !== request.requestId ||
		invocation.traceId !== request.traceId ||
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
		idempotencyKey: invocation.idempotencyKey,
		requestId: request.requestId,
		traceId: request.traceId,
	});
}

export function nativeCapabilityAdmissionRequestDigestV6(
	request: NativeCapabilityAdmissionRequestV6,
): string {
	// Public input + authorization scope identify admission. Resolved config,
	// Key and allocated operation IDs belong only to the frozen operation.
	const {
		requestId: _requestId,
		traceId: _traceId,
		capabilitySourceVersion: _sourceVersion,
		parametersDigest: _parametersDigest,
		configVersion: _configVersion,
		...business
	} = request;
	return createHash("sha256")
		.update(JSON.stringify(canonical({ ...business, schemaVersion: 3 })))
		.digest("hex");
}

export function nativeCapabilityOperationDigestV6(
	input: NativeCapabilityAdmissionContextV6,
): string {
	const {
		requestId: _requestId,
		traceId: _traceId,
		parameters: _parameters,
		operation,
		...frozen
	} = parseRuntimeInput(input);
	return createHash("sha256")
		.update(
			JSON.stringify(
				canonical({
					...frozen,
					operation: { kind: operation.kind, id: operation.id },
				}),
			),
		)
		.digest("hex");
}

function runtimeAuthorityMatches(
	request: NativeCapabilityAdmissionContextV6,
	authority: NativeCapabilityAdmissionV6AuthorityBinding,
	keyBinding: NativeCapabilityAdmissionV6KeyBinding,
): boolean {
	let source: ConversationExecutionSourceV1;
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

function taskAuthorityMatches(
	authority: NativeCapabilityAdmissionV6AuthorityBinding,
	taskAuthority: ConversationExecutionAuthorityV1,
): boolean {
	const boundary = taskAuthority.taskBoundary;
	return (
		boundary !== undefined &&
		taskAuthority.actorId === authority.actorId &&
		taskAuthority.agentId === authority.agentId &&
		taskAuthority.channelId === authority.channelId &&
		taskAuthority.authorizationRevision === authority.authorizationRevision &&
		isDeepStrictEqual(boundary.principal, authority.principal) &&
		boundary.agentId === authority.agentId &&
		boundary.channelId === authority.channelId &&
		boundary.agentAuthorizationRevision === authority.authorizationRevision
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
	runtimeRequest: NativeCapabilityAdmissionContextV6,
	request: NativeCapabilityAdmissionRequestV6,
	authority: NativeCapabilityAdmissionV6AuthorityBinding,
	keyBinding: NativeCapabilityAdmissionV6KeyBinding,
	taskAuthority: ConversationExecutionAuthorityV1,
	modelConfigurationRevision: number,
): NativeCapabilityInvocationPlanV6 {
	if (
		!taskAuthority.taskBoundary ||
		!taskAuthorityMatches(authority, taskAuthority)
	)
		throw new TypeError("Native V6 task authority is invalid");
	if (
		!Number.isSafeInteger(modelConfigurationRevision) ||
		modelConfigurationRevision < 1
	)
		throw new TypeError("Native V6 model configuration revision is invalid");
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
		taskBoundary: structuredClone(taskAuthority.taskBoundary),
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
		modelConfigurationRevision,
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
		readonly runtimeRequest: NativeCapabilityAdmissionContextV6;
		readonly invocation: NativeCapabilityAdmissionRequestV3;
		readonly keyBinding: NativeCapabilityAdmissionV6KeyBinding;
		readonly request: NativeCapabilityAdmissionRequestV6;
		readonly authority: NativeCapabilityAdmissionV6AuthorityBinding;
		readonly taskAuthority: ConversationExecutionAuthorityV1;
		readonly modelConfigurationRevision: number;
		readonly requestDigest: string;
		readonly operationDigest: string;
	},
): void {
	const { request, authority } = input;
	const runtimeRequest = parseRuntimeInput(input.runtimeRequest);
	const expected = frozenPlanV6(
		runtimeRequest,
		parseNativeCapabilityAdmissionRequestV6(runtimeRequest, input.invocation),
		authority,
		input.keyBinding,
		parseAuthority(input.taskAuthority),
		input.modelConfigurationRevision,
	);
	if (
		!runtimeAuthorityMatches(runtimeRequest, authority, input.keyBinding) ||
		!isDeepStrictEqual(
			request,
			parseNativeCapabilityAdmissionRequestV6(runtimeRequest, input.invocation),
		) ||
		input.requestDigest !== expected.requestDigest ||
		input.operationDigest !== expected.operationDigest ||
		!isDeepStrictEqual(plan, expected)
	)
		throw new TypeError("Native V6 admission plan is invalid");
}

/** Revalidate a saved operation against the public retry, never a new candidate. */
export function validateNativeCapabilityReplayPlanV6(
	plan: NativeCapabilityInvocationPlanV6,
	input: {
		readonly invocation: NativeCapabilityAdmissionRequestV3;
		readonly authority: NativeCapabilityAdmissionV6AuthorityBinding;
		readonly taskAuthority: ConversationExecutionAuthorityV1;
		readonly requestDigest: string;
	},
): void {
	const runtimeRequest: NativeCapabilityAdmissionContextV6 = {
		schemaVersion: 6,
		requestId: plan.outbox.payload.requestId,
		traceId: plan.outbox.payload.traceId,
		principal: plan.principal,
		executionSource: plan.executionSource,
		channelId: plan.channelId,
		agentId: plan.agentId,
		conversationId: plan.conversationId,
		executionId: plan.executionId,
		turnId: plan.turnId,
		sessionGeneration: plan.sessionGeneration,
		hostSessionRef: plan.hostSessionRef,
		operation: plan.operation,
		keyBinding: plan.keyBinding,
		capabilityId: plan.capabilityId,
		capabilityKind: "command",
		directoryRevision: plan.directoryRevision,
		parameters: plan.parameters,
		parametersDigest: plan.parametersDigest,
		capabilitySourceVersion: plan.capabilitySourceVersion,
		selection: {
			schemaVersion: 1,
			modelOptionId: plan.modelOptionId,
			reasoningLevel: plan.reasoningLevel,
		},
		configVersion: plan.configVersion,
	};
	const invocation = {
		...input.invocation,
		requestId: runtimeRequest.requestId,
		traceId: runtimeRequest.traceId,
	};
	validateNativeCapabilityInvocationPlanV6(plan, {
		...input,
		invocation,
		runtimeRequest,
		request: parseNativeCapabilityAdmissionRequestV6(
			runtimeRequest,
			invocation,
		),
		keyBinding: plan.keyBinding,
		operationDigest: plan.operationDigest,
		modelConfigurationRevision: plan.modelConfigurationRevision,
	});
}

/** A stateful command never replaces an explicit selection with Owner defaults. */
export function isNativeCapabilityModelSelectionCurrentV6(
	plan: Pick<
		NativeCapabilityInvocationPlanV6,
		"modelConfigurationRevision" | "modelOptionId" | "reasoningLevel"
	>,
	configuration: ConversationModelConfigurationV1,
): boolean {
	return (
		plan.modelConfigurationRevision === configuration.configurationRevision &&
		configuration.options.some(
			(option) =>
				option.optionId === plan.modelOptionId &&
				option.reasoningLevels.includes(plan.reasoningLevel),
		)
	);
}

export function createNativeCapabilityAdmissionUseCaseV6(dependencies: {
	readonly authorization: NativeCapabilityAdmissionV6AuthorizationPort;
	readonly transaction: NativeCapabilityAdmissionTransactionPortV6;
}): NativeCapabilityAdmissionUseCaseV6 {
	return {
		async admit(input, publicInput) {
			const invocation = parseNativeCapabilityAdmissionRequestV3(publicInput);
			const runtimeRequest = parseRuntimeInput(input);
			const request = parseNativeCapabilityAdmissionRequestV6(
				runtimeRequest,
				invocation,
			);
			const authorization = await dependencies.authorization.authorize({
				conversationId: request.conversationId,
			});
			if (authorization.outcome !== "allowed")
				return { outcome: "denied", reason: "authorization_lost" };
			const authority = structuredClone(authorization.authority);
			const taskAuthority = parseAuthority(authorization.taskAuthority);
			const modelConfigurationRevision =
				authorization.modelConfigurationRevision;
			const keyBinding = structuredClone(authorization.keyBinding);
			if (
				!runtimeAuthorityMatches(runtimeRequest, authority, keyBinding) ||
				!taskAuthorityMatches(authority, taskAuthority)
			)
				return { outcome: "denied", reason: "authorization_lost" };
			const plan = frozenPlanV6(
				runtimeRequest,
				request,
				authority,
				keyBinding,
				taskAuthority,
				modelConfigurationRevision,
			);
			const { requestDigest, operationDigest } = plan;
			validateNativeCapabilityInvocationPlanV6(plan, {
				invocation,
				taskAuthority,
				modelConfigurationRevision,
				runtimeRequest,
				keyBinding,
				request,
				authority,
				requestDigest,
				operationDigest,
			});
			return dependencies.transaction.admitNativeCapabilityV6(
				freezePlan({
					invocation,
					taskAuthority,
					modelConfigurationRevision,
					runtimeRequest,
					request,
					authority,
					keyBinding,
					plan,
					requestDigest,
					operationDigest,
				}),
				async () => {
					try {
						const current = await dependencies.authorization.authorize({
							conversationId: request.conversationId,
						});
						return (
							current.outcome === "allowed" &&
							isDeepStrictEqual(current.authority, authority) &&
							isDeepStrictEqual(
								parseAuthority(current.taskAuthority),
								taskAuthority,
							)
						);
					} catch {
						return false;
					}
				},
			);
		},
	};
}
