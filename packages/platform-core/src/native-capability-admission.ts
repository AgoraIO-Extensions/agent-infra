import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { parseAuthority } from "./conversation-execution-input.js";
import { parseState } from "./conversation-execution-state.js";
import type {
	ConversationExecutionAuthorityV1,
	ConversationExecutionConversationStateV1,
} from "./conversation-execution-types.js";
import { nextOpaqueId } from "./conversation-execution-values.js";
import {
	FileAuthorityError,
	type FileLimitsV1,
	type FileRecordV1,
	type FileScopeV1,
	type NativeTextInputV1,
	nativeTextInputLimitV1,
	resolveNativeTextInputsV1,
} from "./file-authority.js";

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

/**
 * Invocation V2 adds the ordered, caller-selected file ids of an already
 * uploaded read-only text input set (issue #2887). The caller never supplies
 * digests, byte lengths, media types or grants; Core resolves each id through
 * FileAuthority in the admission transaction.
 */
export type NativeCapabilityAdmissionRequestV2 = Readonly<{
	schemaVersion: 2;
	conversationId: string;
	capabilityId: string;
	directoryRevision: string;
	parameters: string;
	attachments: readonly string[];
	idempotencyKey: string;
	requestId: string;
	traceId: string;
}>;

export type NativeCapabilityAdmissionRequest =
	| NativeCapabilityAdmissionRequestV1
	| NativeCapabilityAdmissionRequestV2;

export interface NativeCapabilityAdmissionCapabilityV1
	extends NativeCapabilityMetadataV1 {
	readonly directoryRevision: string;
}

export interface NativeCapabilityAdmissionInputFilesV1 {
	getFile(fileId: string): Promise<FileRecordV1 | null>;
}

export interface NativeCapabilityAdmissionStateV1 {
	readonly conversation: ConversationExecutionConversationStateV1 | null;
	readonly activeExecution: {
		readonly executionId: string;
		readonly status: "waiting" | "submitted" | "processing" | "unknown";
	} | null;
	readonly authorizationRevision: string | null;
	/**
	 * Transaction-scoped file reader. Required for Invocation V2 so the ordered
	 * ids are resolved under the same locks as the persisted Plan; null for
	 * transactions that cannot read FileAuthority records.
	 */
	readonly inputFiles: NativeCapabilityAdmissionInputFilesV1 | null;
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
	/** Ordered Execution-only text inputs; omitted for Invocation V1. */
	readonly attachments?: readonly NativeTextInputV1[];
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
			/** Present exactly when the accepted Invocation V2 sequence is present. */
			readonly attachments?: readonly NativeTextInputV1[];
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

export interface NativeCapabilityInputLimitsPortV1 {
	/**
	 * Reads the current attachment FileLimits intersection for the admission
	 * scope. It is called inside the admission transaction so a configuration or
	 * capability change between selection and commit fails closed.
	 */
	read(input: {
		readonly actorId: string;
		readonly agentId: string;
		readonly channelId: string;
		readonly conversationId: string;
		readonly sessionGeneration: number;
	}): Promise<FileLimitsV1 | null>;
}

export interface NativeCapabilityAdmissionTransactionPortV1 {
	admitNativeCapability(
		request: {
			readonly command: NativeCapabilityAdmissionRequest;
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
		request: NativeCapabilityAdmissionRequest,
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

export function parseNativeCapabilityAdmissionRequestV2(
	input: unknown,
): NativeCapabilityAdmissionRequestV2 {
	const value = exactObject(input, [
		"schemaVersion",
		"conversationId",
		"capabilityId",
		"directoryRevision",
		"parameters",
		"attachments",
		"idempotencyKey",
		"requestId",
		"traceId",
	]);
	if (value.schemaVersion !== 2) invalidInput();
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
		!idempotencyKeyPattern.test(value.idempotencyKey) ||
		!Array.isArray(value.attachments) ||
		value.attachments.length < 1 ||
		value.attachments.length > nativeTextInputLimitV1.maxFiles
	)
		invalidInput();
	const attachments = (value.attachments as unknown[]).map((fileId) =>
		text(fileId),
	);
	if (new Set(attachments).size !== attachments.length) invalidInput();
	return Object.freeze({
		schemaVersion: 2,
		conversationId,
		capabilityId,
		directoryRevision,
		parameters,
		attachments: Object.freeze(attachments),
		idempotencyKey: value.idempotencyKey,
		requestId: text(value.requestId),
		traceId: text(value.traceId),
	});
}

export function parseNativeCapabilityAdmissionRequest(
	input: unknown,
): NativeCapabilityAdmissionRequest {
	if (
		typeof input === "object" &&
		input !== null &&
		!Array.isArray(input) &&
		!types.isProxy(input) &&
		(input as Record<string, unknown>).schemaVersion === 2
	)
		return parseNativeCapabilityAdmissionRequestV2(input);
	return parseNativeCapabilityAdmissionRequestV1(input);
}

/**
 * Validates the server-resolved ordered attachment facts carried by the Plan and
 * the native outbox payload. Both the admission transaction and a later dispatch
 * must reconstruct exactly the accepted sequence.
 */
export function parseNativeCapabilityAttachmentsV1(
	value: unknown,
): readonly NativeTextInputV1[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > nativeTextInputLimitV1.maxFiles
	)
		throw new TypeError("Native capability attachments are invalid");
	const keys = ["byteLength", "fileId", "mediaType", "sha256"];
	const seen = new Set<string>();
	return Object.freeze(
		value.map((entry) => {
			if (
				typeof entry !== "object" ||
				entry === null ||
				Array.isArray(entry) ||
				types.isProxy(entry)
			)
				throw new TypeError("Native capability attachments are invalid");
			const record = entry as Record<string, unknown>;
			if (
				Reflect.ownKeys(record).length !== keys.length ||
				Object.keys(record).sort().join(",") !== keys.join(",")
			)
				throw new TypeError("Native capability attachments are invalid");
			const fileId = record.fileId;
			const sha256 = record.sha256;
			const byteLength = record.byteLength;
			if (
				typeof fileId !== "string" ||
				fileId.length === 0 ||
				fileId.length > 1024 ||
				seen.has(fileId) ||
				typeof sha256 !== "string" ||
				!digestPattern.test(sha256) ||
				typeof byteLength !== "number" ||
				!Number.isSafeInteger(byteLength) ||
				byteLength < 0 ||
				byteLength > nativeTextInputLimitV1.maxBytes ||
				record.mediaType !== nativeTextInputLimitV1.mediaType
			)
				throw new TypeError("Native capability attachments are invalid");
			seen.add(fileId);
			return Object.freeze({
				fileId,
				sha256,
				byteLength,
				mediaType: nativeTextInputLimitV1.mediaType,
			});
		}),
	);
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
	return createHash("sha256").update(parameters, "utf8").digest("hex");
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

/**
 * Invocation V2 binds the exact ordered attachment ids into idempotency. A
 * changed, reordered or missing sequence is a different request and therefore a
 * key conflict, never a replay.
 */
export function nativeCapabilityAdmissionRequestDigestV2(
	request: NativeCapabilityAdmissionRequestV2,
): string {
	return digest({
		schemaVersion: 2,
		command: "native-capability.invoke",
		conversationId: request.conversationId,
		capabilityId: request.capabilityId,
		directoryRevision: request.directoryRevision,
		parameters: request.parameters,
		attachments: [...request.attachments],
	});
}

export function nativeCapabilityAdmissionRequestDigest(
	request: NativeCapabilityAdmissionRequest,
): string {
	return request.schemaVersion === 2
		? nativeCapabilityAdmissionRequestDigestV2(request)
		: nativeCapabilityAdmissionRequestDigestV1(request);
}

/**
 * The metadata seam only selects a capability/directory revision; attachments do
 * not affect its answer. V2 therefore revalidates through the frozen V1 view so
 * the existing metadata port and its cache keep their exact input shape.
 */
function nativeCapabilityMetadataRequestViewV1(
	request: NativeCapabilityAdmissionRequest,
): NativeCapabilityAdmissionRequestV1 {
	if (request.schemaVersion === 1) return request;
	return Object.freeze({
		schemaVersion: 1,
		conversationId: request.conversationId,
		capabilityId: request.capabilityId,
		directoryRevision: request.directoryRevision,
		parameters: request.parameters,
		idempotencyKey: request.idempotencyKey,
		requestId: request.requestId,
		traceId: request.traceId,
	});
}

export function createNativeCapabilityAdmissionUseCaseV1(dependencies: {
	readonly authorization: NativeCapabilityAdmissionAuthorizationPortV1;
	readonly metadata: NativeCapabilityMetadataRevalidationPortV1;
	readonly transaction: NativeCapabilityAdmissionTransactionPortV1;
	readonly inputLimits?: NativeCapabilityInputLimitsPortV1;
	readonly now?: () => Date;
	readonly newId?: () => string;
}): NativeCapabilityAdmissionUseCaseV1 {
	const newId = dependencies.newId ?? randomUUID;
	const now = dependencies.now ?? (() => new Date());
	return {
		async admit(input) {
			const request = parseNativeCapabilityAdmissionRequest(input);
			const metadataRequest = nativeCapabilityMetadataRequestViewV1(request);
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
			const requestDigest = nativeCapabilityAdmissionRequestDigest(request);
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
							request: metadataRequest,
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
							request: metadataRequest,
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
								request: metadataRequest,
								capability: latestSelected,
								scope: currentScope,
							})
						)
							return { outcome: "stale" };
						let attachments: readonly NativeTextInputV1[] | undefined;
						if (request.schemaVersion === 2) {
							// Invocation V2 is Skill-only and resolves its ordered file ids
							// through FileAuthority inside this same transaction.
							if (latestSelected.kind !== "skill")
								return { outcome: "unsupported" };
							const inputFiles = state.inputFiles;
							if (!dependencies.inputLimits || !inputFiles)
								return {
									outcome: "unavailable",
									reason: "metadata_unavailable",
								};
							const fileScope: FileScopeV1 = {
								actorId: authority.actorId,
								agentId: authority.agentId,
								channelId: authority.channelId,
								conversationId: request.conversationId,
							};
							let limits: FileLimitsV1 | null;
							try {
								limits = await dependencies.inputLimits.read({
									actorId: fileScope.actorId,
									agentId: fileScope.agentId,
									channelId: fileScope.channelId,
									conversationId: fileScope.conversationId,
									sessionGeneration: conversation.sessionGeneration,
								});
							} catch {
								return {
									outcome: "unavailable",
									reason: "metadata_unavailable",
								};
							}
							if (!limits) return { outcome: "denied" };
							try {
								const files = await Promise.all(
									request.attachments.map((fileId) =>
										inputFiles.getFile(fileId),
									),
								);
								attachments = resolveNativeTextInputsV1(
									files,
									fileScope,
									limits,
									now(),
								);
							} catch (error) {
								if (error instanceof FileAuthorityError)
									return { outcome: "denied" };
								throw error;
							}
						}
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
							...(attachments ? { attachments } : {}),
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
									...(attachments ? { attachments } : {}),
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
							request: metadataRequest,
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
