import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { parseAuthority } from "./conversation-execution-input.js";
import { parseState } from "./conversation-execution-state.js";
import type {
	ConversationExecutionAuthorityV1,
	ConversationExecutionConversationStateV1,
} from "./conversation-execution-types.js";
import { nextOpaqueId } from "./conversation-execution-values.js";

const digestPattern = /^[a-f0-9]{64}$/u;
const idempotencyKeyPattern = /^[A-Za-z0-9._~-]{1,128}$/u;
const maxParameterBytes = 16 * 1024;
const maxMetadataDescriptionBytes = 16 * 1024;

export type NativeCapabilityKindV1 = "command" | "skill";

export interface NativeCapabilityMetadataV1 {
	readonly id: string;
	readonly kind: NativeCapabilityKindV1;
	readonly name: string;
	readonly description: string;
	readonly source: { readonly name: string; readonly version: string };
	readonly availability: "available" | "discovered" | "disabled";
}

export interface NativeCapabilityMetadataProjectionV1 {
	readonly selector: "commands" | "skills";
	readonly revision: string;
	readonly capabilities: readonly NativeCapabilityMetadataV1[];
}

export type NativeCapabilityAdmissionRequestV1 = Readonly<{
	schemaVersion: 1;
	conversationId: string;
	capabilityId: string;
	directoryRevision: string;
	parameters: string;
	idempotencyKey: string;
	requestId: string;
	traceId: string;
}>;

export interface NativeCapabilityAdmissionCapabilityV1
	extends NativeCapabilityMetadataV1 {
	readonly directoryRevision: string;
}

export interface NativeCapabilityAdmissionStateV1 {
	readonly conversation: ConversationExecutionConversationStateV1 | null;
	readonly activeExecution: {
		readonly executionId: string;
		readonly status: "waiting" | "submitted" | "processing" | "unknown";
	} | null;
	readonly authorizationRevision: string | null;
}

export interface NativeCapabilityInvocationPlanV1 {
	readonly schemaVersion: 1;
	readonly kind: "native-capability";
	readonly conversationId: string;
	readonly agentId: string;
	readonly actorId: string;
	readonly channelId: string;
	readonly executionId: string;
	readonly turnId: string;
	readonly sessionGeneration: number;
	readonly authorizationRevision: string;
	readonly capability: NativeCapabilityAdmissionCapabilityV1;
	readonly parameters: string;
	readonly parametersDigest: string;
	readonly executionStatus: "submitted";
	readonly outbox: {
		readonly id: string;
		readonly operation: "conversation.native-capability.invoke.v1";
		readonly payload: {
			readonly schemaVersion: 1;
			readonly conversationId: string;
			readonly agentId: string;
			readonly actorId: string;
			readonly channelId: string;
			readonly executionId: string;
			readonly turnId: string;
			readonly sessionGeneration: number;
			readonly capabilityId: string;
			readonly capabilityKind: NativeCapabilityKindV1;
			readonly directoryRevision: string;
			readonly capabilitySourceVersion: string;
			readonly parameters: string;
			readonly parametersDigest: string;
		};
		readonly requestId: string;
		readonly traceId: string;
	};
	readonly audit: {
		readonly action: "conversation.native_capability.accepted";
		readonly actorId: string;
		readonly agentId: string;
		readonly conversationId: string;
		readonly executionId: string;
		readonly requestId: string;
		readonly traceId: string;
	};
	readonly result: NativeCapabilityAdmissionResultV1;
	readonly idempotency: {
		readonly scopeType: "conversation";
		readonly scopeId: string;
		readonly actorId: string;
		readonly commandType: "native-capability.invoke";
		readonly key: string;
		readonly requestDigest: string;
	};
}

export interface NativeCapabilityAdmissionResultV1 {
	readonly schemaVersion: 1;
	readonly status: "submitted";
	readonly conversationId: string;
	readonly executionId: string;
	readonly capabilityId: string;
	readonly capabilityKind: NativeCapabilityKindV1;
	readonly directoryRevision: string;
}

export type NativeCapabilityAdmissionDecisionV1 =
	| {
			readonly outcome: "accepted" | "replayed";
			readonly result: NativeCapabilityAdmissionResultV1;
			readonly plan: NativeCapabilityInvocationPlanV1;
	  }
	| {
			readonly outcome:
				| "busy"
				| "denied"
				| "stale"
				| "unknown"
				| "disabled"
				| "invalid_parameters"
				| "unsupported"
				| "unavailable";
			readonly reason?:
				| "authorization_lost"
				| "conversation_unavailable"
				| "metadata_unavailable"
				| "idempotency_in_progress";
	  }
	| { readonly outcome: "conflict"; readonly reason: "idempotency_conflict" };

export interface NativeCapabilityAdmissionAuthorizationPortV1 {
	authorize(input: {
		readonly schemaVersion: 1;
		readonly operation: "native-capability.invoke";
		readonly conversationId: string;
	}): Promise<
		| {
				readonly outcome: "allowed";
				readonly authority: ConversationExecutionAuthorityV1;
		  }
		| { readonly outcome: "denied" }
	>;
}

export interface NativeCapabilityAdmissionScopeV1 {
	readonly agentId: string;
	readonly actorId: string;
	readonly channelId: string;
	readonly conversationId: string;
	readonly sessionGeneration: number;
	readonly authorizationRevision: string;
	/** Null for controlled legacy overrides without a bound Host. */
	readonly hostScopeRef: string | null;
}

export interface NativeCapabilityMetadataRevalidationPortV1 {
	revalidate(input: {
		readonly request: NativeCapabilityAdmissionRequestV1;
		readonly authority: ConversationExecutionAuthorityV1;
		readonly sessionGeneration: number;
	}): Promise<
		| {
				readonly outcome: "allowed";
				readonly capability: NativeCapabilityAdmissionCapabilityV1;
				readonly scope: NativeCapabilityAdmissionScopeV1;
		  }
		| { readonly outcome: "stale" | "unknown" | "disabled" | "unavailable" }
	>;
	isCurrent(input: {
		readonly request: NativeCapabilityAdmissionRequestV1;
		readonly capability: NativeCapabilityAdmissionCapabilityV1;
		readonly scope: NativeCapabilityAdmissionScopeV1;
	}): boolean;
}

export interface NativeCapabilityAdmissionTransactionPortV1 {
	admitNativeCapability(
		request: {
			readonly command: NativeCapabilityAdmissionRequestV1;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
		decide: (state: NativeCapabilityAdmissionStateV1) => Promise<
			| NativeCapabilityInvocationPlanV1
			| Extract<
					NativeCapabilityAdmissionDecisionV1,
					{
						readonly outcome: Exclude<
							NativeCapabilityAdmissionDecisionV1["outcome"],
							"accepted" | "replayed" | "conflict"
						>;
					}
			  >
		>,
		isCurrent: (
			plan: NativeCapabilityInvocationPlanV1,
			conversation: ConversationExecutionConversationStateV1,
		) => boolean,
		isAuthorized: () => Promise<boolean>,
	): Promise<NativeCapabilityAdmissionDecisionV1>;
}

export interface NativeCapabilityAdmissionUseCaseV1 {
	admit(
		request: NativeCapabilityAdmissionRequestV1,
	): Promise<NativeCapabilityAdmissionDecisionV1>;
}

export class NativeCapabilityAdmissionError extends Error {
	readonly code: "invalid_input" | "unavailable";

	constructor(code: "invalid_input" | "unavailable") {
		super(
			code === "invalid_input"
				? "Invalid native capability admission request"
				: "Native capability admission is unavailable",
		);
		this.name = "NativeCapabilityAdmissionError";
		this.code = code;
	}
}

function invalidInput(): never {
	throw new NativeCapabilityAdmissionError("invalid_input");
}

function boundedText(
	value: unknown,
	maxBytes: number,
	allowEmpty = false,
): string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		value.includes("\0") ||
		!String.prototype.isWellFormed.call(value) ||
		new TextEncoder().encode(value).byteLength > maxBytes
	)
		invalidInput();
	return value;
}

function text(value: unknown, maxBytes = 1024): string {
	return boundedText(value, maxBytes);
}

function exactObject(
	input: unknown,
	required: readonly string[],
): Record<string, unknown> {
	if (
		typeof input !== "object" ||
		input === null ||
		Array.isArray(input) ||
		types.isProxy(input)
	)
		invalidInput();
	const values = input as Record<string, unknown>;
	const ownKeys = Reflect.ownKeys(values);
	const allowed = new Set(required);
	if (
		ownKeys.length !== required.length ||
		ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
	)
		invalidInput();
	for (const key of required) {
		const descriptor = Object.getOwnPropertyDescriptor(values, key);
		if (
			descriptor?.enumerable !== true ||
			!Object.hasOwn(descriptor, "value") ||
			Object.hasOwn(descriptor, "get") ||
			Object.hasOwn(descriptor, "set")
		)
			invalidInput();
	}
	return values;
}

export function parseNativeCapabilityAdmissionRequestV1(
	input: unknown,
): NativeCapabilityAdmissionRequestV1 {
	const value = exactObject(input, [
		"schemaVersion",
		"conversationId",
		"capabilityId",
		"directoryRevision",
		"parameters",
		"idempotencyKey",
		"requestId",
		"traceId",
	]);
	if (value.schemaVersion !== 1) invalidInput();
	const conversationId = text(value.conversationId);
	const capabilityId = text(value.capabilityId);
	const directoryRevision = text(value.directoryRevision);
	if (
		!digestPattern.test(capabilityId) ||
		!digestPattern.test(directoryRevision)
	)
		invalidInput();
	const parameters = boundedText(value.parameters, maxParameterBytes, true);
	if (
		typeof value.idempotencyKey !== "string" ||
		!idempotencyKeyPattern.test(value.idempotencyKey)
	)
		invalidInput();
	return Object.freeze({
		schemaVersion: 1,
		conversationId,
		capabilityId,
		directoryRevision,
		parameters,
		idempotencyKey: value.idempotencyKey,
		requestId: text(value.requestId),
		traceId: text(value.traceId),
	});
}

function capability(value: unknown): NativeCapabilityMetadataV1 {
	const object = exactObject(value, [
		"id",
		"kind",
		"name",
		"description",
		"source",
		"availability",
	]);
	const id = text(object.id);
	if (!digestPattern.test(id)) invalidInput();
	if (object.kind !== "command" && object.kind !== "skill") invalidInput();
	if (
		object.availability !== "available" &&
		object.availability !== "discovered" &&
		object.availability !== "disabled"
	)
		invalidInput();
	const source = exactObject(object.source, ["name", "version"]);
	return Object.freeze({
		id,
		kind: object.kind,
		name: text(object.name, 1024),
		description: boundedText(
			object.description,
			maxMetadataDescriptionBytes,
			true,
		),
		source: Object.freeze({
			name: text(source.name, 1024),
			version: text(source.version, 512),
		}),
		availability: object.availability,
	});
}

function parseAdmittedCapability(
	input: unknown,
): NativeCapabilityAdmissionCapabilityV1 {
	const value = exactObject(input, [
		"id",
		"kind",
		"name",
		"description",
		"source",
		"availability",

		"directoryRevision",
	]);
	const { directoryRevision, ...metadata } = value;
	if (
		typeof directoryRevision !== "string" ||
		!digestPattern.test(directoryRevision)
	)
		invalidInput();
	return Object.freeze({ ...capability(metadata), directoryRevision });
}

export function parseNativeCapabilityMetadataProjectionV1(
	input: NativeCapabilityMetadataProjectionV1,
): NativeCapabilityMetadataProjectionV1 {
	const object = exactObject(input, ["selector", "revision", "capabilities"]);
	if (object.selector !== "commands" && object.selector !== "skills")
		invalidInput();
	const revision = text(object.revision);
	if (
		!digestPattern.test(revision) ||
		!Array.isArray(object.capabilities) ||
		object.capabilities.length > 128
	)
		invalidInput();
	const capabilities = (object.capabilities as unknown[]).map(capability);
	if (new Set(capabilities.map(({ id }) => id)).size !== capabilities.length)
		invalidInput();
	if (
		capabilities.some(
			({ kind }) =>
				kind !== (object.selector === "commands" ? "command" : "skill"),
		)
	)
		invalidInput();
	return Object.freeze({
		selector: object.selector,
		revision,
		capabilities: Object.freeze(capabilities),
	});
}

function freeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value))
		return value;
	Object.freeze(value);
	for (const child of Object.values(value)) freeze(child);
	return value;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function nativeCapabilityParametersDigestV1(parameters: string): string {
	return digest(parameters);
}

export function nativeCapabilityAdmissionRequestDigestV1(
	request: NativeCapabilityAdmissionRequestV1,
): string {
	return digest({
		schemaVersion: 1,
		command: "native-capability.invoke",
		conversationId: request.conversationId,
		capabilityId: request.capabilityId,
		directoryRevision: request.directoryRevision,
		parameters: request.parameters,
	});
}

export function createNativeCapabilityAdmissionUseCaseV1(dependencies: {
	readonly authorization: NativeCapabilityAdmissionAuthorizationPortV1;
	readonly metadata: NativeCapabilityMetadataRevalidationPortV1;
	readonly transaction: NativeCapabilityAdmissionTransactionPortV1;
	readonly newId?: () => string;
}): NativeCapabilityAdmissionUseCaseV1 {
	const newId = dependencies.newId ?? randomUUID;
	return {
		async admit(input) {
			const request = parseNativeCapabilityAdmissionRequestV1(input);
			let authority: ConversationExecutionAuthorityV1;
			try {
				const decision = await dependencies.authorization.authorize({
					schemaVersion: 1,
					operation: "native-capability.invoke",
					conversationId: request.conversationId,
				});
				if (decision.outcome !== "allowed")
					return { outcome: "denied", reason: "authorization_lost" };
				authority = parseAuthority(decision.authority);
			} catch {
				return { outcome: "unavailable", reason: "metadata_unavailable" };
			}
			if (
				authority.schemaVersion !== 1 ||
				authority.agentId.length === 0 ||
				authority.actorId.length === 0
			)
				return { outcome: "denied", reason: "authorization_lost" };
			const requestDigest = nativeCapabilityAdmissionRequestDigestV1(request);
			try {
				let latestScopeForCommit: NativeCapabilityAdmissionScopeV1 | undefined;
				return await dependencies.transaction.admitNativeCapability(
					{ command: request, authority, requestDigest },
					async (state) => {
						const conversation = parseState({
							conversation: state.conversation ?? undefined,
							modelConfiguration: undefined,
							sourceMessage: undefined,
							targetExecution: undefined,
							existingStop: undefined,
							activeExecution: undefined,
						}).conversation;
						if (
							!conversation ||
							conversation.conversationId !== request.conversationId ||
							conversation.actorId !== authority.actorId ||
							(conversation.principal?.kind ?? "user") !==
								(authority.taskBoundary?.principal.kind ?? "user") ||
							conversation.agentId !== authority.agentId ||
							conversation.channelId !== authority.channelId ||
							conversation.status !== "ready" ||
							conversation.isolationPending ||
							state.authorizationRevision !== authority.authorizationRevision
						)
							return { outcome: "denied", reason: "authorization_lost" };
						if (state.activeExecution) return { outcome: "busy" };
						const metadata = await dependencies.metadata.revalidate({
							request,
							authority,
							sessionGeneration: conversation.sessionGeneration,
						});
						if (metadata.outcome !== "allowed") return metadata;
						const selected = parseAdmittedCapability(metadata.capability);
						const scope = exactObject(metadata.scope, [
							"agentId",
							"actorId",
							"channelId",
							"conversationId",
							"sessionGeneration",
							"authorizationRevision",
							"hostScopeRef",
						]);
						if (
							scope.agentId !== authority.agentId ||
							scope.actorId !== authority.actorId ||
							scope.channelId !== authority.channelId ||
							scope.conversationId !== request.conversationId ||
							scope.sessionGeneration !== conversation.sessionGeneration ||
							scope.authorizationRevision !== authority.authorizationRevision ||
							scope.hostScopeRef !== conversation.hostSessionRef ||
							selected.id !== request.capabilityId ||
							selected.directoryRevision !== request.directoryRevision
						)
							return { outcome: "unavailable", reason: "metadata_unavailable" };
						if (
							(selected.kind === "command" &&
								selected.availability !== "available") ||
							(selected.kind === "skill" &&
								selected.availability !== "discovered")
						)
							return { outcome: "disabled" };
						if (
							selected.kind === "skill" &&
							request.parameters.trim().length === 0
						)
							return { outcome: "invalid_parameters" };
						const current = await dependencies.authorization.authorize({
							schemaVersion: 1,
							operation: "native-capability.invoke",
							conversationId: request.conversationId,
						});
						if (
							current.outcome !== "allowed" ||
							!isDeepStrictEqual(parseAuthority(current.authority), authority)
						)
							return { outcome: "denied", reason: "authorization_lost" };
						const latestMetadata = await dependencies.metadata.revalidate({
							request,
							authority,
							sessionGeneration: conversation.sessionGeneration,
						});
						if (latestMetadata.outcome !== "allowed") return latestMetadata;
						const latestSelected = parseAdmittedCapability(
							latestMetadata.capability,
						);
						const latestScope = exactObject(latestMetadata.scope, [
							"agentId",
							"actorId",
							"channelId",
							"conversationId",
							"sessionGeneration",
							"authorizationRevision",
							"hostScopeRef",
						]);
						const currentScope = {
							agentId: latestScope.agentId as string,
							actorId: latestScope.actorId as string,
							channelId: latestScope.channelId as string,
							conversationId: latestScope.conversationId as string,
							sessionGeneration: latestScope.sessionGeneration as number,
							authorizationRevision:
								latestScope.authorizationRevision as string,
							hostScopeRef: latestScope.hostScopeRef as string | null,
						};
						if (
							!isDeepStrictEqual(latestSelected, selected) ||
							!isDeepStrictEqual(currentScope, scope) ||
							(currentScope.hostScopeRef !== null &&
								currentScope.hostScopeRef.length === 0)
						)
							return { outcome: "stale" };
						latestScopeForCommit = currentScope;
						const finalAuthority = await dependencies.authorization.authorize({
							schemaVersion: 1,
							operation: "native-capability.invoke",
							conversationId: request.conversationId,
						});
						if (
							finalAuthority.outcome !== "allowed" ||
							!isDeepStrictEqual(
								parseAuthority(finalAuthority.authority),
								authority,
							)
						)
							return { outcome: "denied", reason: "authorization_lost" };
						if (
							!dependencies.metadata.isCurrent({
								request,
								capability: latestSelected,
								scope: currentScope,
							})
						)
							return { outcome: "stale" };
						const executionId = nextOpaqueId(newId);
						const turnId = nextOpaqueId(newId);
						const result: NativeCapabilityAdmissionResultV1 = Object.freeze({
							schemaVersion: 1,
							status: "submitted",
							conversationId: request.conversationId,
							executionId,
							capabilityId: selected.id,
							capabilityKind: selected.kind,
							directoryRevision: selected.directoryRevision,
						});
						const plan: NativeCapabilityInvocationPlanV1 = {
							schemaVersion: 1,
							kind: "native-capability",
							conversationId: request.conversationId,
							agentId: authority.agentId,
							actorId: authority.actorId,
							channelId: authority.channelId,
							executionId,
							turnId,
							sessionGeneration: conversation.sessionGeneration,
							authorizationRevision: authority.authorizationRevision,
							capability: selected,
							parameters: request.parameters,
							parametersDigest: nativeCapabilityParametersDigestV1(
								request.parameters,
							),
							executionStatus: "submitted",
							outbox: {
								id: `conversation:native-capability:${executionId}`,
								operation: "conversation.native-capability.invoke.v1",
								payload: {
									schemaVersion: 1,
									conversationId: request.conversationId,
									agentId: authority.agentId,
									actorId: authority.actorId,
									channelId: authority.channelId,
									executionId,
									turnId,
									sessionGeneration: conversation.sessionGeneration,
									capabilityId: selected.id,
									capabilityKind: selected.kind,
									directoryRevision: selected.directoryRevision,
									capabilitySourceVersion: selected.source.version,
									parameters: request.parameters,
									parametersDigest: nativeCapabilityParametersDigestV1(
										request.parameters,
									),
								},
								requestId: request.requestId,
								traceId: request.traceId,
							},
							audit: {
								action: "conversation.native_capability.accepted",
								actorId: authority.actorId,
								agentId: authority.agentId,
								conversationId: request.conversationId,
								executionId,
								requestId: request.requestId,
								traceId: request.traceId,
							},
							result,
							idempotency: {
								scopeType: "conversation",
								scopeId: request.conversationId,
								actorId: authority.actorId,
								commandType: "native-capability.invoke",
								key: request.idempotencyKey,
								requestDigest,
							},
						};
						return freeze(plan);
					},
					(plan, currentConversation) =>
						latestScopeForCommit !== undefined &&
						currentConversation.sessionGeneration ===
							latestScopeForCommit.sessionGeneration &&
						currentConversation.hostSessionRef ===
							latestScopeForCommit.hostScopeRef &&
						dependencies.metadata.isCurrent({
							request,
							capability: plan.capability,
							scope: latestScopeForCommit,
						}),
					async () => {
						try {
							const current = await dependencies.authorization.authorize({
								schemaVersion: 1,
								operation: "native-capability.invoke",
								conversationId: request.conversationId,
							});
							return (
								current.outcome === "allowed" &&
								isDeepStrictEqual(parseAuthority(current.authority), authority)
							);
						} catch {
							return false;
						}
					},
				);
			} catch {
				return { outcome: "unavailable", reason: "metadata_unavailable" };
			}
		},
	};
}
