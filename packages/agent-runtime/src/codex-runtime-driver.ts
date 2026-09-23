import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
	RuntimeCapabilitiesV1,
	RuntimeConnectionAssociationV1,
	RuntimeDriverOperationRecordV1,
	RuntimeEvent,
	RuntimeOperationFactV2,
	RuntimeSelectionV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";
import {
	RuntimeDriverOperationRecordV1Schema,
	RuntimeDriverSubmitTurnOperationRecordV2Schema,
	RuntimeOperationFactV2Schema,
} from "@agent-infra/contracts/runtime";

import {
	CODEX_APP_SERVER_V2_PROVENANCE,
	CodexAppServerBridge,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
	type CodexModelAccess,
	codexConversationKey,
	runCodexConnectionRecovery,
	validateModelAccess,
} from "./codex-app-server-bridge.js";
import {
	type CodexConnectionEvidence,
	type CodexConnectionEvidenceUpdateRequest,
	type CodexConnectionEvidenceUpdateResponse,
	type CodexConnectionOperationRequest,
	type CodexConnectionOperationResponse,
	type CodexConnectionOrigin,
	type CodexConnectionQueryMetadata,
	type CodexConnectionRecoveryOriginal,
	type CodexConnectionRecoveryRequest,
	type CodexConnectionRecoveryResponse,
	type CodexConnectionRequest,
	type CodexConnectionServiceAuthority,
	createCodexConnectionClient,
	isCodexConnectionClientConfiguration,
	isCodexConnectionEvidence,
	isCodexConnectionOrigin,
	isCodexConnectionOriginalBinding,
	isCodexConnectionRecoveryOriginal,
	isCodexConnectionRequest,
	validateCodexConnectionProfile,
} from "./codex-connection-client.js";
import {
	type CodexModelRequestContext,
	type CodexModelRequestJournal,
	type CodexModelRequestOutcome,
	type CodexModelRoute,
	type CodexModelTurn,
	type CodexModelTurnAdmission,
	type CodexNativeTurn,
	openCodexModelTransport,
} from "./codex-model-transport.js";
import {
	type CodexNativeAttemptIdentityV1,
	type CodexNativeCallbackRequest,
	type CodexNativeCallbackResponse,
	type CodexNativeOperationRequestV1,
	type CodexNativeOperationResponseV1,
	type CodexNativeSourceRequestV1,
	type CodexNativeSourceReservationV1,
	type CodexNativeSourceResponseV1,
	type CodexNativeSourceV1,
	isCodexNativeAttemptIdentityV1,
	isCodexNativeSourceReservationV1,
	isCodexNativeSourceV1,
	sameCodexNativeAttemptV1,
} from "./codex-native-callback.js";
import type {
	RuntimeDriver,
	RuntimeDriverCommand,
	RuntimeDriverLookup,
	RuntimeDriverOperationRecord,
	RuntimeExternalActionAuthorization,
	RuntimeOriginalEvidenceReadContext,
	RuntimeOriginalEvidenceRecoveryRef,
} from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";
import {
	type RuntimeOriginalExecutionRef,
	runtimeAuthorizationDenied,
} from "./runtime-authorization.js";

interface CodexAppServerTransport {
	send(frame: CodexAppServerFrame): Promise<void>;
	frames(): AsyncIterable<CodexAppServerFrame>;
	close?(): Promise<void>;
}

type OpenCodexBridge = (
	options: CodexAppServerBridgeOptions,
) => Promise<CodexAppServerTransport>;

export interface CodexRuntimeDriverOptions {
	readonly path: string;
	// Deployment-owned native executable search path; never supplied by wire commands.
	readonly launchPath?: string;
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly modelOptions: readonly CodexRuntimeModelOption[];
	readonly authorizeExternalAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<void>;
	// Independent client delivery is trusted deployment input, never a Runtime command.
	readonly connectionClient?: {
		/** Independently configured service allowlist; never derived from the profile. */
		readonly authorizedService: CodexConnectionServiceAuthority;
		readonly profile: {
			readonly profileRef: string;
			readonly serviceRef: string;
			readonly issuer: string;
			readonly resource: string;
		};
		readonly resolveReadOnlyClient?: (
			reference: RuntimeOriginalExecutionRef,
			read: RuntimeOriginalEvidenceReadContext,
			signal: AbortSignal,
		) => Promise<unknown>;
		readonly resolveOriginalClient: (
			reference: RuntimeOriginalExecutionRef,
			signal: AbortSignal,
		) => Promise<unknown>;
	};
}

export interface CodexRuntimeModelOption {
	readonly modelOptionId: string;
	readonly model: string;
	readonly reasoningLevels: readonly string[];
	readonly endpoint?: string;
	readonly credential?: string;
}

interface ConfiguredCodexRuntimeModelOption {
	readonly modelOptionId: string;
	readonly model: string;
	readonly internalModel: string;
	readonly reasoningLevels: readonly string[];
}

interface CodexExecution {
	executionId: string;
	turnId: string;
	nativeTurnId: string;
	status: PersistedTurnStatus;
}

interface CodexJournalStatusEvent {
	cursor: string;
	adapterEventKey: string;
	occurredAt: string;
	type: "status";
	payload: { status: "running" };
}

interface CodexJournalTextEvent {
	cursor: string;
	adapterEventKey: string;
	occurredAt: string;
	nativeItemId: string;
	type: "text";
	payload: { delta: string };
}

interface CodexJournalCompletedEvent {
	cursor: string;
	adapterEventKey: string;
	occurredAt: string;
	type: "completed";
	payload: { status: "completed" | "failed" | "cancelled" };
}

interface CodexJournalOperationEvent {
	cursor: string;
	adapterEventKey: string;
	occurredAt: string;
	type: "operation";
	payload: RuntimeOperationFactV2;
}

type CodexJournalEvent =
	| CodexJournalStatusEvent
	| CodexJournalTextEvent
	| CodexJournalOperationEvent
	| CodexJournalCompletedEvent;

interface CodexNativeToolAttempt {
	identity: CodexNativeAttemptIdentityV1;
	operationRef: string;
	attemptRef: string;
	intentRequestId: string;
	intentFingerprint: string;
	permitId?: string;
	expiresAt?: number;
	denied?: "authorization_denied" | "authorization_unavailable";
	startedRequestId?: string;
	startedFingerprint?: string;
	outcomeRequestId?: string;
	outcomeFingerprint?: string;
	connectionOrigin?: CodexConnectionOrigin;
	connectionRequest?: CodexConnectionRequest;
	connectionEvidence?: CodexConnectionEvidence;
	connectionEvidenceUpdates?: CodexNativeSourceReceipt[];
}

/** Canonicalize only nonsecret operation/evidence fields, never bootstrap frames. */
function canonicalCallbackValue(_key: string, value: unknown): unknown {
	if (Array.isArray(value))
		return value.map((entry) => canonicalCallbackValue("", entry));
	if (!isPlainRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => [key, canonicalCallbackValue(key, entry)]),
	);
}

function isConnectionMetadataSuccessor(
	previous: RuntimeOperationFactV2,
	next: RuntimeOperationFactV2,
) {
	if (previous.kind !== "tool" || next.kind !== "tool" || !next.connection)
		return false;
	const { connection: prior, ...before } = previous;
	const { connection: current, ...after } = next;
	return (
		isDeepStrictEqual(before, after) &&
		!isDeepStrictEqual(prior, current) &&
		(!prior ||
			(prior.serviceRef === current.serviceRef &&
				(prior.callRef === undefined || prior.callRef === current.callRef) &&
				(prior.verification !== "verified" ||
					current.verification === "verified")))
	);
}

interface CodexNativeSourceReceipt {
	requestId: string;
	fingerprint: string;
}

interface CodexNativeSourceRecord {
	reservation: CodexNativeSourceReservationV1;
	reserve: CodexNativeSourceReceipt;
	reserveAuthorized?: true;
	reserveDenied?: "authorization_denied" | "authorization_unavailable";
	bindPending?: CodexNativeSourceReceipt;
	bind?: CodexNativeSourceReceipt;
	bindDenied?: "authorization_denied" | "authorization_unavailable";
	bindDeniedReceipt?: CodexNativeSourceReceipt;
	source?: CodexNativeSourceV1;
	delivery?: "started" | "steered";
	notStarted?: CodexNativeSourceReceipt;
	notStartedStage?: "not_queued" | "not_routed" | "gate_rejected";
	notStartedReason?:
		| "queue_closed"
		| "routing_rejected"
		| "cancelled_before_start"
		| "binding_denied";
	terminal?: CodexNativeSourceReceipt;
	nativeStatus?: "completed" | "failed" | "cancelled";
}

interface CodexConnectionRecoveryPass {
	recoveryRequestId: string;
	deadlineAt: number;
	scannedAttemptRefs: string[];
	completed: boolean;
}

interface CodexEventJournal {
	nativeTurnId: string;
	connectionRecovery?: CodexConnectionRecoveryPass;
	connectionRecoveryCursor?: string;
	pendingOperationKey?: string;
	acknowledgedCursor?: string;
	externalActionsBlocked?: true;
	nativeToolAttempts?: Record<string, CodexNativeToolAttempt>;
	nativeSources?: Record<string, CodexNativeSourceRecord>;
	nativeCompletionStatus?: "completed" | "failed" | "cancelled";
	events: CodexJournalEvent[];
}

interface CodexSession {
	nativeSessionRef: string;
	agentId: string;
	conversationId: string;
	sessionGeneration: number;
	threadId?: string;
	historyMode?: "paginated";
	activeExecutionId?: string;
	acceptanceUncertainOperationKey?: string;
	eventSequence?: number;
	journals?: Record<string, CodexEventJournal>;
	executions: Record<string, CodexExecution>;
}

interface CodexOperation {
	schemaVersion: 1 | 2;
	state: "prepared" | "resolved";
	nativeSessionRef: string;
	configVersion?: string;
	internalModel?: string;
	reasoningLevel?: string;
	// Durable admission confirmation has not returned successfully.
	admissionPending?: true;
	// Confirmation persisted, but timely transport admission is not durably recorded.
	admissionRecoveryPending?: true;
	executionId?: string;
	turnId?: string;
	record?: RuntimeDriverOperationRecord;
}

interface CodexDriverState {
	schemaVersion: 1;
	sessions: Record<string, CodexSession>;
	operations: Record<string, CodexOperation>;
}

interface PendingRequest {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	nativeSelectionRejection: boolean;
	allowHistoryMaterializationRetry: boolean;
}

type CodexNotificationHandler = (frame: CodexAppServerFrame) => Promise<void>;

const capabilities: RuntimeCapabilitiesV1 = {
	modelSelection: true,
	attachments: false,
	resultFiles: false,
	connection: false,
	supplementaryInstruction: false,
};

const itemsListPageSize = 100;
const maximumItemsListPages = 8;
const modelsListPageSize = 100;
const maximumModelsListPages = 8;
const turnsListPageSize = 100;
const maximumTurnsListPages = 8;
const rpcRequestTimeoutMs = 30_000;
const containedServerRequestMethods = new Set([
	"item/tool/call",
	"mcpServer/elicitation/request",
]);
const delegatedToolUnavailableJsonRpcError = Object.freeze({
	code: -32_001,
	message: "Platform delegated tools are unavailable",
});
const isolatedConfigurationKeys = [
	"mcp_servers",
	"plugins",
	"marketplaces",
] as const;
const requiredConfigurationOriginKeys = [
	"model",
	"model_reasoning_effort",
	"features.plugins",
] as const;
const codexModelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const codexReasoningPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const persistedTurnStatuses = [
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;

type PersistedTurnStatus = (typeof persistedTurnStatuses)[number];

function modelOperationFailure(
	code: Exclude<
		CodexModelRequestOutcome,
		{ phase: "succeeded" }
	>["failureCode"],
): RuntimeOperationFactV2["failureCode"] {
	switch (code) {
		case "request_not_started":
			return "request_rejected";
		case "http_error":
			return "request_rejected";
		case "provider_error":
			return "operation_failed";
		case "transport_error":
			return "dependency_unavailable";
		case "invalid_response":
			return "response_incomplete";
		case "interrupted":
			return "interrupted";
	}
}

type CodexInterruptionCommand = Extract<
	RuntimeDriverCommand,
	{ kind: "stop" | "generation-cancel" }
>;

type CodexSubmitTurnCommand = Extract<
	RuntimeDriverCommand,
	{ kind: "submit-turn" }
>;

function operationKey(
	command: Pick<
		RuntimeDriverCommand,
		"agentId" | "conversationId" | "sessionGeneration" | "kind" | "operationId"
	>,
) {
	return JSON.stringify([
		command.agentId,
		command.conversationId,
		command.sessionGeneration,
		command.kind,
		command.operationId,
	]);
}

function isCodexInterruptionCommand(
	command: RuntimeDriverCommand,
): command is CodexInterruptionCommand {
	return command.kind === "stop" || command.kind === "generation-cancel";
}

function isCodexOperationKind(
	value: unknown,
): value is RuntimeDriverCommand["kind"] {
	return (
		value === "submit-turn" ||
		value === "supplement" ||
		value === "stop" ||
		value === "generation-cancel"
	);
}

function operationMatchesCommand(
	operation: CodexOperation,
	command: RuntimeDriverCommand,
) {
	if (operation.schemaVersion !== command.schemaVersion) return false;
	if (!isCodexInterruptionCommand(command)) {
		return (
			operation.executionId === undefined && operation.turnId === undefined
		);
	}
	return (
		operation.nativeSessionRef === command.nativeSessionRef &&
		operation.executionId === command.executionId &&
		operation.turnId === command.turnId
	);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function hasOnlyKeys(value: object, keys: readonly string[]) {
	return Object.keys(value).every((key) => keys.includes(key));
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function ownRecordValue<T>(record: Record<string, T>, key: string) {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isJsonRpcRequestId(value: unknown): value is string | number {
	return (
		typeof value === "string" ||
		(typeof value === "number" && Number.isSafeInteger(value))
	);
}

function isNativeSelectionRejection(value: unknown) {
	return (
		isPlainRecord(value) &&
		hasOnlyKeys(value, ["code", "message", "data"]) &&
		value.code === -32_600 &&
		nonEmptyString(value.message) &&
		value.message.startsWith("invalid thread settings override:")
	);
}

function isHistoryNotMaterializedError(value: unknown) {
	if (!isPlainRecord(value) || !Number.isSafeInteger(value.code)) return false;
	if (value.code === -32_601)
		return value.message === "list_turns is not supported yet";
	return (
		value.code === -32_600 &&
		typeof value.message === "string" &&
		value.message.endsWith(
			"thread/turns/list is unavailable before first user message",
		)
	);
}

function isEmptyRecord(value: unknown) {
	return isPlainRecord(value) && Object.keys(value).length === 0;
}

function assertSessionFlagOrigin(origin: unknown) {
	if (
		!isPlainRecord(origin) ||
		!isPlainRecord(origin.name) ||
		typeof origin.name.type !== "string" ||
		typeof origin.version !== "string"
	) {
		protocolInvalid();
	}
	if (origin.name.type !== "sessionFlags") configurationInvalid();
}

function assertOnlySessionFlagOrigins(value: Record<string, unknown>) {
	for (const key of requiredConfigurationOriginKeys) {
		const origin = ownRecordValue(value, key);
		if (origin === undefined) configurationInvalid();
		assertSessionFlagOrigin(origin);
	}
	for (const origin of Object.values(value)) assertSessionFlagOrigin(origin);
}

function isPersistedTurnStatus(value: unknown): value is PersistedTurnStatus {
	return (
		typeof value === "string" &&
		(persistedTurnStatuses as readonly string[]).includes(value)
	);
}

function isCodexExecution(
	executionId: string,
	value: unknown,
): value is CodexExecution {
	return (
		isPlainRecord(value) &&
		hasOnlyKeys(value, ["executionId", "turnId", "nativeTurnId", "status"]) &&
		value.executionId === executionId &&
		nonEmptyString(value.turnId) &&
		nonEmptyString(value.nativeTurnId) &&
		isPersistedTurnStatus(value.status)
	);
}

function isCodexJournalEvent(value: unknown): value is CodexJournalEvent {
	if (
		isPlainRecord(value) &&
		hasOnlyKeys(value, [
			"cursor",
			"adapterEventKey",
			"occurredAt",
			"type",
			"payload",
		]) &&
		nonEmptyString(value.cursor) &&
		nonEmptyString(value.adapterEventKey) &&
		nonEmptyString(value.occurredAt) &&
		value.type === "operation" &&
		RuntimeOperationFactV2Schema.safeParse(value.payload).success
	)
		return true;
	if (
		isPlainRecord(value) &&
		nonEmptyString(value.cursor) &&
		nonEmptyString(value.adapterEventKey) &&
		nonEmptyString(value.occurredAt) &&
		isPlainRecord(value.payload) &&
		hasOnlyKeys(value.payload, ["status"]) &&
		value.type === "status" &&
		value.payload.status === "running" &&
		hasOnlyKeys(value, [
			"cursor",
			"adapterEventKey",
			"occurredAt",
			"type",
			"payload",
		])
	) {
		return true;
	}
	if (
		isPlainRecord(value) &&
		hasOnlyKeys(value, [
			"cursor",
			"adapterEventKey",
			"occurredAt",
			"nativeItemId",
			"type",
			"payload",
		]) &&
		nonEmptyString(value.cursor) &&
		nonEmptyString(value.adapterEventKey) &&
		nonEmptyString(value.occurredAt) &&
		nonEmptyString(value.nativeItemId) &&
		value.type === "text" &&
		isPlainRecord(value.payload) &&
		hasOnlyKeys(value.payload, ["delta"]) &&
		nonEmptyString(value.payload.delta)
	) {
		return true;
	}
	if (
		isPlainRecord(value) &&
		hasOnlyKeys(value, [
			"cursor",
			"adapterEventKey",
			"occurredAt",
			"type",
			"payload",
		]) &&
		nonEmptyString(value.cursor) &&
		nonEmptyString(value.adapterEventKey) &&
		nonEmptyString(value.occurredAt) &&
		value.type === "completed" &&
		isPlainRecord(value.payload) &&
		hasOnlyKeys(value.payload, ["status"]) &&
		(value.payload.status === "completed" ||
			value.payload.status === "failed" ||
			value.payload.status === "cancelled")
	) {
		return true;
	}
	return false;
}

function isCodexEventJournal(
	nativeTurnId: string,
	value: unknown,
): value is CodexEventJournal {
	return (
		isPlainRecord(value) &&
		hasOnlyKeys(value, [
			"nativeTurnId",
			"connectionRecovery",
			"connectionRecoveryCursor",
			"pendingOperationKey",
			"acknowledgedCursor",
			"externalActionsBlocked",
			"nativeToolAttempts",
			"nativeSources",
			"nativeCompletionStatus",
			"events",
		]) &&
		value.nativeTurnId === nativeTurnId &&
		(value.connectionRecoveryCursor === undefined ||
			nonEmptyString(value.connectionRecoveryCursor)) &&
		(value.connectionRecovery === undefined ||
			(isPlainRecord(value.connectionRecovery) &&
				hasOnlyKeys(value.connectionRecovery, [
					"recoveryRequestId",
					"deadlineAt",
					"scannedAttemptRefs",
					"completed",
				]) &&
				nonEmptyString(value.connectionRecovery.recoveryRequestId) &&
				typeof value.connectionRecovery.deadlineAt === "number" &&
				Number.isSafeInteger(value.connectionRecovery.deadlineAt) &&
				value.connectionRecovery.deadlineAt > 0 &&
				typeof value.connectionRecovery.completed === "boolean" &&
				Array.isArray(value.connectionRecovery.scannedAttemptRefs) &&
				value.connectionRecovery.scannedAttemptRefs.length <= 16 &&
				value.connectionRecovery.scannedAttemptRefs.every(nonEmptyString) &&
				new Set(value.connectionRecovery.scannedAttemptRefs).size ===
					value.connectionRecovery.scannedAttemptRefs.length)) &&
		(value.nativeSources === undefined ||
			(isPlainRecord(value.nativeSources) &&
				Object.keys(value.nativeSources).length <= 1024 &&
				Object.entries(value.nativeSources).every(([id, source]) =>
					isNativeSourceRecord(id, source),
				))) &&
		(value.pendingOperationKey === undefined ||
			nonEmptyString(value.pendingOperationKey)) &&
		(value.acknowledgedCursor === undefined ||
			nonEmptyString(value.acknowledgedCursor)) &&
		(value.externalActionsBlocked === undefined ||
			value.externalActionsBlocked === true) &&
		Array.isArray(value.events) &&
		value.events.every(isCodexJournalEvent) &&
		(value.nativeCompletionStatus === undefined ||
			value.nativeCompletionStatus === "completed" ||
			value.nativeCompletionStatus === "failed" ||
			value.nativeCompletionStatus === "cancelled") &&
		(value.nativeToolAttempts === undefined ||
			(isPlainRecord(value.nativeToolAttempts) &&
				Object.entries(value.nativeToolAttempts).every(([key, attempt]) =>
					isNativeToolAttempt(
						key,
						attempt,
						value.events as CodexJournalEvent[],
					),
				))) &&
		(value.acknowledgedCursor === undefined ||
			value.events.some(
				(event) => event.cursor === value.acknowledgedCursor,
			)) &&
		consistentOperationFacts(value.events)
	);
}

function isNativeSourceRecord(
	id: string,
	value: unknown,
): value is CodexNativeSourceRecord {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"reservation",
			"reserve",
			"reserveAuthorized",
			"reserveDenied",
			"bindPending",
			"bind",
			"bindDenied",
			"bindDeniedReceipt",
			"source",
			"delivery",
			"notStarted",
			"notStartedStage",
			"notStartedReason",
			"terminal",
			"nativeStatus",
		]) ||
		!isCodexNativeSourceReservationV1(value.reservation) ||
		value.reservation.reservationId !== id
	)
		return false;
	for (const field of [
		"reserve",
		"bindPending",
		"bind",
		"bindDeniedReceipt",
		"notStarted",
		"terminal",
	] as const) {
		const receipt = value[field];
		if (receipt === undefined && field !== "reserve") continue;
		if (
			!isPlainRecord(receipt) ||
			!hasOnlyKeys(receipt, ["requestId", "fingerprint"]) ||
			typeof receipt.requestId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
				receipt.requestId,
			) ||
			typeof receipt.fingerprint !== "string" ||
			!/^[a-f0-9]{64}$/.test(receipt.fingerprint)
		)
			return false;
	}
	if (value.bindDeniedReceipt !== undefined && value.bindDenied === undefined)
		return false;
	for (const field of ["reserveDenied", "bindDenied"])
		if (
			value[field] !== undefined &&
			value[field] !== "authorization_denied" &&
			value[field] !== "authorization_unavailable"
		)
			return false;
	if (value.reserveAuthorized !== undefined && value.reserveAuthorized !== true)
		return false;
	if (value.reserveDenied && value.reserveAuthorized) return false;
	if (value.source !== undefined && !isCodexNativeSourceV1(value.source))
		return false;
	if (
		value.source !== undefined &&
		(value.source as CodexNativeSourceV1).threadId !==
			value.reservation.childThreadId
	)
		return false;
	if (value.bind !== undefined && value.bindPending !== undefined) return false;
	if (value.bind !== undefined) {
		if (
			!value.reserveAuthorized ||
			!value.source ||
			(value.delivery !== "started" && value.delivery !== "steered") ||
			value.reserveDenied
		)
			return false;
		if (
			value.delivery === "started" &&
			(value.source as CodexNativeSourceV1).turnId !==
				value.reservation.submissionId
		)
			return false;
		if (
			value.delivery === "steered" &&
			(value.bindDenied || value.bindDeniedReceipt)
		)
			return false;
	} else if (value.bindPending !== undefined) {
		if (
			!value.reserveAuthorized ||
			!value.source ||
			(value.delivery !== "started" && value.delivery !== "steered") ||
			value.reserveDenied ||
			value.bindDenied ||
			value.bindDeniedReceipt ||
			(value.delivery === "started" &&
				(value.source as CodexNativeSourceV1).turnId !==
					value.reservation.submissionId)
		)
			return false;
	} else if (value.bindDenied !== undefined) {
		if (
			!value.reserveAuthorized ||
			!value.source ||
			(value.delivery !== "started" && value.delivery !== "steered") ||
			value.reserveDenied ||
			(value.delivery === "started" &&
				(value.source as CodexNativeSourceV1).turnId !==
					value.reservation.submissionId)
		)
			return false;
	} else if (value.delivery !== undefined) return false;
	if (value.notStarted !== undefined) {
		const allowed: Record<string, string[]> = {
			not_queued: ["queue_closed", "cancelled_before_start"],
			not_routed: ["routing_rejected", "cancelled_before_start"],
			gate_rejected: ["binding_denied", "cancelled_before_start"],
		};
		if (
			typeof value.notStartedStage !== "string" ||
			typeof value.notStartedReason !== "string" ||
			!allowed[value.notStartedStage]?.includes(value.notStartedReason) ||
			!value.reserveAuthorized ||
			value.reserveDenied ||
			((value.bind || value.bindPending) && !value.bindDenied) ||
			value.terminal
		)
			return false;
		if (
			(value.notStartedStage === "gate_rejected") !==
			(value.source !== undefined)
		)
			return false;
		if (
			value.notStartedStage === "gate_rejected" &&
			(value.source as CodexNativeSourceV1).turnId !==
				value.reservation.submissionId
		)
			return false;
	} else if (
		value.notStartedStage !== undefined ||
		value.notStartedReason !== undefined
	)
		return false;
	if (value.terminal !== undefined) {
		if (
			!value.bind ||
			value.bindDenied ||
			value.delivery !== "started" ||
			value.notStarted ||
			!["completed", "failed", "cancelled"].includes(String(value.nativeStatus))
		)
			return false;
	} else if (value.nativeStatus !== undefined) return false;
	if (
		value.source !== undefined &&
		!value.bind &&
		!value.bindPending &&
		!value.notStarted &&
		!value.bindDenied
	)
		return false;
	return !(
		value.reserveDenied &&
		(value.bind || value.notStarted || value.terminal || value.source)
	);
}

function pendingNativeSources(journal: CodexEventJournal) {
	return Object.values(journal.nativeSources ?? {}).filter(
		(source) =>
			!source.reserveDenied &&
			!source.bindDenied &&
			!source.notStarted &&
			(!source.bind || (source.delivery === "started" && !source.terminal)),
	);
}

function nativeSourceFingerprint(request: CodexNativeSourceRequestV1) {
	return createHash("sha256")
		.update(JSON.stringify(canonicalCallbackValue("", request)))
		.digest("hex");
}

function isNativeToolAttempt(
	key: string,
	value: unknown,
	events: readonly CodexJournalEvent[],
): value is CodexNativeToolAttempt {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"identity",
			"operationRef",
			"attemptRef",
			"intentRequestId",
			"intentFingerprint",
			"permitId",
			"expiresAt",
			"denied",
			"startedRequestId",
			"startedFingerprint",
			"outcomeRequestId",
			"outcomeFingerprint",
			"connectionOrigin",
			"connectionRequest",
			"connectionEvidence",
			"connectionEvidenceUpdates",
		]) ||
		!isCodexNativeAttemptIdentityV1(value.identity) ||
		value.identity.attemptRef !== key
	)
		return false;
	const uuid = (candidate: unknown) =>
		typeof candidate === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			candidate,
		);
	for (const field of ["operationRef", "attemptRef", "intentRequestId"])
		if (!uuid(value[field])) return false;
	if (
		typeof value.intentFingerprint !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.intentFingerprint)
	)
		return false;
	for (const phase of ["started", "outcome"]) {
		const fingerprint = value[`${phase}Fingerprint`];
		if (
			(value[`${phase}RequestId`] === undefined) !==
				(fingerprint === undefined) ||
			(fingerprint !== undefined &&
				(typeof fingerprint !== "string" ||
					!/^[a-f0-9]{64}$/.test(fingerprint)))
		)
			return false;
	}
	for (const field of ["permitId", "startedRequestId", "outcomeRequestId"])
		if (value[field] !== undefined && !uuid(value[field])) return false;
	if (
		(value.permitId === undefined) !== (value.expiresAt === undefined) ||
		(value.expiresAt !== undefined &&
			(typeof value.expiresAt !== "number" ||
				!Number.isSafeInteger(value.expiresAt) ||
				value.expiresAt <= 0)) ||
		(value.denied !== undefined &&
			value.denied !== "authorization_denied" &&
			value.denied !== "authorization_unavailable") ||
		(value.denied !== undefined && value.permitId !== undefined) ||
		((value.startedRequestId !== undefined ||
			value.outcomeRequestId !== undefined) &&
			value.permitId === undefined)
	)
		return false;
	const facts = events.flatMap((event) =>
		event.type === "operation" &&
		event.payload.kind === "tool" &&
		event.payload.operationRef === value.operationRef &&
		event.payload.attemptRef === value.attemptRef
			? [event.payload]
			: [],
	);
	if (facts[0]?.phase !== "intent") return false;
	if (
		(value.startedRequestId !== undefined) !==
		facts.some((fact) => fact.phase === "started")
	)
		return false;
	const last = facts.at(-1);
	if (
		value.denied !== undefined &&
		(last?.phase !== "failed" || last.failureCode !== value.denied)
	)
		return false;
	if (
		value.outcomeRequestId !== undefined &&
		last?.phase !== "completed" &&
		last?.phase !== "failed" &&
		last?.phase !== "unknown"
	)
		return false;
	if (
		value.connectionRequest !== undefined &&
		(!isCodexConnectionRequest(value.connectionRequest) ||
			value.identity.toolName !==
				`connection/${value.connectionRequest.toolName}`)
	)
		return false;
	if (
		value.connectionOrigin !== undefined &&
		(!isCodexConnectionOrigin(value.connectionOrigin) ||
			!value.connectionRequest ||
			value.connectionOrigin.slotId !== value.connectionRequest.slotId ||
			value.connectionOrigin.service.serviceRef !==
				value.connectionRequest.serviceRef)
	)
		return false;
	if (
		value.connectionEvidence !== undefined &&
		(value.connectionRequest?.toolName !== "execute_action" ||
			!value.outcomeRequestId ||
			!isCodexConnectionEvidence(value.connectionEvidence))
	)
		return false;
	if (
		value.connectionEvidenceUpdates !== undefined &&
		(!value.connectionEvidence ||
			!Array.isArray(value.connectionEvidenceUpdates) ||
			!value.connectionEvidenceUpdates.every(
				(receipt) =>
					isPlainRecord(receipt) &&
					hasOnlyKeys(receipt, ["requestId", "fingerprint"]) &&
					uuid(receipt.requestId) &&
					typeof receipt.fingerprint === "string" &&
					/^[a-f0-9]{64}$/.test(receipt.fingerprint),
			))
	)
		return false;
	const connectionRequest = value.connectionRequest;
	if (
		facts.some(
			(fact) =>
				fact.kind === "tool" &&
				fact.connection &&
				(connectionRequest?.toolName !== "execute_action" ||
					fact.connection.serviceRef !== connectionRequest.serviceRef),
		)
	)
		return false;
	const requests = [
		...(value.connectionEvidenceUpdates ?? []).map(
			(receipt: CodexNativeSourceReceipt) => receipt.requestId,
		),
		value.intentRequestId,
		value.startedRequestId,
		value.outcomeRequestId,
	].filter((id) => id !== undefined);
	return new Set(requests).size === requests.length;
}

function operationAttemptKey(value: {
	operationRef: string;
	attemptRef: string;
}) {
	return JSON.stringify([value.operationRef, value.attemptRef]);
}

function sameNativeToolOperation(
	left: Pick<CodexNativeToolAttempt, "identity" | "connectionRequest">,
	right: Pick<CodexNativeToolAttempt, "identity" | "connectionRequest">,
) {
	return (
		left.identity.sessionId === right.identity.sessionId &&
		left.identity.turnId === right.identity.turnId &&
		left.identity.callId === right.identity.callId &&
		left.identity.toolName === right.identity.toolName &&
		left.identity.parentAttemptRef === right.identity.parentAttemptRef &&
		isDeepStrictEqual(left.connectionRequest, right.connectionRequest)
	);
}

function latestOperationAttemptFacts(events: readonly CodexJournalEvent[]) {
	const latest = new Map<string, RuntimeOperationFactV2>();
	for (const event of events) {
		if (event.type === "operation")
			latest.set(operationAttemptKey(event.payload), event.payload);
	}
	return [...latest.values()];
}

function latestModelOperationAttemptFact(events: readonly CodexJournalEvent[]) {
	let latest: Extract<RuntimeOperationFactV2, { kind: "model" }> | undefined;
	for (const event of events) {
		if (event.type === "operation" && event.payload.kind === "model")
			latest = event.payload;
	}
	return latest;
}

function pendingNativeToolAttempts(journal: CodexEventJournal | undefined) {
	if (!journal) return [];
	const latest = new Map(
		latestOperationAttemptFacts(journal.events).map((fact) => [
			operationAttemptKey(fact),
			fact,
		]),
	);
	return Object.values(journal.nativeToolAttempts ?? {}).filter(
		(attempt) =>
			!attempt.denied &&
			(!attempt.outcomeRequestId ||
				latest.get(operationAttemptKey(attempt))?.phase === "unknown"),
	);
}

function consistentOperationFacts(events: readonly CodexJournalEvent[]) {
	const latest = new Map<string, RuntimeOperationFactV2>();
	const operations = new Map<string, RuntimeOperationFactV2>();
	const attempts = new Map<string, string>();
	let completed = false;
	for (const event of events) {
		if (event.type !== "operation") {
			if (completed) return false;
			if (event.type === "completed") completed = true;
			continue;
		}
		const fact = event.payload;
		const key = operationAttemptKey(fact);
		const previous = latest.get(key);
		const operation = operations.get(fact.operationRef);
		if (
			(attempts.has(fact.attemptRef) &&
				attempts.get(fact.attemptRef) !== fact.operationRef) ||
			(operation &&
				(operation.kind !== fact.kind ||
					operation.parentOperationRef !== fact.parentOperationRef ||
					(operation.kind === "model" &&
						fact.kind === "model" &&
						JSON.stringify(operation.model) !== JSON.stringify(fact.model)) ||
					(operation.kind === "tool" &&
						fact.kind === "tool" &&
						operation.toolId !== fact.toolId)))
		)
			return false;
		if (
			completed &&
			(!previous || !isConnectionMetadataSuccessor(previous, fact))
		)
			return false;
		if (!previous) {
			if (
				fact.phase !== "intent" ||
				(operation &&
					operation.phase !== "completed" &&
					operation.phase !== "failed")
			)
				return false;
		} else if (!isConnectionMetadataSuccessor(previous, fact)) {
			if (
				previous.attemptRef !== fact.attemptRef ||
				previous.kind !== fact.kind ||
				previous.parentOperationRef !== fact.parentOperationRef ||
				(previous.kind === "model" &&
					fact.kind === "model" &&
					JSON.stringify(previous.model) !== JSON.stringify(fact.model)) ||
				(previous.kind === "tool" &&
					fact.kind === "tool" &&
					previous.toolId !== fact.toolId) ||
				(previous.phase !== "intent" &&
					previous.phase !== "started" &&
					previous.phase !== "unknown") ||
				fact.phase === "intent" ||
				(fact.phase === "started" && previous.phase !== "intent") ||
				(fact.phase === "unknown" && previous.phase === "unknown") ||
				(fact.phase === "completed" &&
					previous.phase !== "started" &&
					previous.phase !== "unknown")
			)
				return false;
		}
		latest.set(key, fact);
		operations.set(fact.operationRef, fact);
		attempts.set(fact.attemptRef, fact.operationRef);
	}
	return (
		!events.some((event) => event.type === "completed") ||
		[...latest.values()].every(
			(fact) => fact.phase !== "intent" && fact.phase !== "started",
		)
	);
}

function isCodexSession(
	nativeSessionRef: string,
	value: unknown,
): value is CodexSession {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"nativeSessionRef",
			"agentId",
			"conversationId",
			"sessionGeneration",
			"threadId",
			"historyMode",
			"activeExecutionId",
			"acceptanceUncertainOperationKey",
			"eventSequence",
			"journals",
			"executions",
		]) ||
		value.nativeSessionRef !== nativeSessionRef ||
		!nonEmptyString(value.agentId) ||
		!nonEmptyString(value.conversationId) ||
		typeof value.sessionGeneration !== "number" ||
		!Number.isSafeInteger(value.sessionGeneration) ||
		value.sessionGeneration < 1 ||
		(value.threadId !== undefined && !nonEmptyString(value.threadId)) ||
		(value.historyMode !== undefined && value.historyMode !== "paginated") ||
		(value.activeExecutionId !== undefined &&
			!nonEmptyString(value.activeExecutionId)) ||
		(value.acceptanceUncertainOperationKey !== undefined &&
			!nonEmptyString(value.acceptanceUncertainOperationKey)) ||
		(value.eventSequence !== undefined &&
			(typeof value.eventSequence !== "number" ||
				!Number.isSafeInteger(value.eventSequence) ||
				value.eventSequence < 0)) ||
		(value.journals !== undefined && !isPlainRecord(value.journals)) ||
		!isPlainRecord(value.executions)
	) {
		return false;
	}
	if (
		value.journals !== undefined &&
		!Object.entries(value.journals).every(([nativeTurnId, journal]) =>
			isCodexEventJournal(nativeTurnId, journal),
		)
	) {
		return false;
	}
	const journals = (value.journals ?? {}) as Record<string, CodexEventJournal>;
	const cursors = new Set<string>();
	const adapterEventKeys = new Set<string>();
	const pendingOperationKeys = new Set<string>();
	const nativeRequests = new Set<string>();
	const sourceIds = new Set<string>();
	const sourceBindings = new Set<string>();
	const sourceReservations = new Set<string>();
	let eventCount = 0;
	for (const journal of Object.values(journals)) {
		const operations = new Map<string, CodexNativeToolAttempt>();
		const attemptRefs = new Set<string>();
		const belongsToRoot = (
			threadId: string,
			turnId: string,
			seen = new Set<string>(),
		): boolean => {
			if (threadId === value.threadId && turnId === journal.nativeTurnId)
				return true;
			const matches = Object.values(journal.nativeSources ?? {}).filter(
				(source) =>
					source.bind &&
					!source.bindDenied &&
					source.delivery === "started" &&
					source.source?.threadId === threadId &&
					source.source.turnId === turnId,
			);
			if (matches.length !== 1) return false;
			const source = matches[0];
			if (!source || seen.has(source.reservation.reservationId)) return false;
			seen.add(source.reservation.reservationId);
			return belongsToRoot(
				source.reservation.parent.sessionId,
				source.reservation.parent.turnId,
				seen,
			);
		};
		for (const source of Object.values(journal.nativeSources ?? {})) {
			if (sourceIds.has(source.reservation.reservationId)) return false;
			sourceIds.add(source.reservation.reservationId);
			const parent = ownRecordValue(
				journal.nativeToolAttempts ?? {},
				source.reservation.parent.attemptRef,
			);
			if (
				!parent ||
				parent.denied ||
				(source.bind && !parent.startedRequestId) ||
				!sameCodexNativeAttemptV1(parent.identity, source.reservation.parent) ||
				parent.permitId !== source.reservation.parentPermitId ||
				!belongsToRoot(parent.identity.sessionId, parent.identity.turnId)
			)
				return false;
			const reservationKey = JSON.stringify([
				journal.nativeTurnId,
				source.reservation.childThreadId,
				source.reservation.submissionId,
			]);
			if (sourceReservations.has(reservationKey)) return false;
			sourceReservations.add(reservationKey);
			if (source.bind && !source.bindDenied) {
				if (
					!parent.startedRequestId ||
					!source.source ||
					!belongsToRoot(source.source.threadId, source.source.turnId)
				)
					return false;
				if (source.delivery === "started") {
					const bindingKey = JSON.stringify([
						journal.nativeTurnId,
						source.source.threadId,
						source.source.turnId,
					]);
					if (
						sourceBindings.has(bindingKey) ||
						source.source.threadId === value.threadId
					)
						return false;
					sourceBindings.add(bindingKey);
				}
			}
			for (const receipt of [
				source.reserve,
				source.bindPending,
				source.bind,
				source.notStarted,
				source.terminal,
			]) {
				if (!receipt) continue;
				if (nativeRequests.has(receipt.requestId)) return false;
				nativeRequests.add(receipt.requestId);
			}
		}
		if (
			pendingNativeSources(journal).length > 0 &&
			journal.events.some((event) => event.type === "completed")
		)
			return false;
		for (const attempt of Object.values(journal.nativeToolAttempts ?? {})) {
			const operation = operations.get(attempt.operationRef);
			if (
				!belongsToRoot(attempt.identity.sessionId, attempt.identity.turnId) ||
				attemptRefs.has(attempt.attemptRef) ||
				(operation && !sameNativeToolOperation(operation, attempt))
			)
				return false;
			operations.set(attempt.operationRef, attempt);
			attemptRefs.add(attempt.attemptRef);
			for (const id of [
				attempt.intentRequestId,
				attempt.startedRequestId,
				attempt.outcomeRequestId,
				...(attempt.connectionEvidenceUpdates ?? []).map(
					(receipt) => receipt.requestId,
				),
			]) {
				if (id === undefined) continue;
				if (nativeRequests.has(id)) return false;
				nativeRequests.add(id);
			}
			if (attempt.identity.parentAttemptRef) {
				const parent = ownRecordValue(
					journal.nativeToolAttempts ?? {},
					attempt.identity.parentAttemptRef,
				);
				if (
					!parent ||
					parent === attempt ||
					!parent.permitId ||
					!parent.startedRequestId
				)
					return false;
			}
		}
		if (journal.pendingOperationKey !== undefined) {
			if (pendingOperationKeys.has(journal.pendingOperationKey)) return false;
			pendingOperationKeys.add(journal.pendingOperationKey);
		}
		for (const event of journal.events) {
			if (
				cursors.has(event.cursor) ||
				adapterEventKeys.has(event.adapterEventKey)
			) {
				return false;
			}
			cursors.add(event.cursor);
			adapterEventKeys.add(event.adapterEventKey);
			eventCount += 1;
		}
	}
	if (
		(eventCount > 0 && value.eventSequence === undefined) ||
		(value.eventSequence !== undefined && value.eventSequence !== eventCount)
	) {
		return false;
	}
	const executions = Object.entries(value.executions);
	if (executions.length > 0 && value.threadId === undefined) return false;
	let runningExecutionId: string | undefined;
	const nativeTurnIds = new Set<string>();
	for (const [executionId, execution] of executions) {
		if (!isCodexExecution(executionId, execution)) return false;
		if (nativeTurnIds.has(execution.nativeTurnId)) return false;
		nativeTurnIds.add(execution.nativeTurnId);
		if (execution.status !== "running") continue;
		if (runningExecutionId) return false;
		runningExecutionId = executionId;
	}
	return value.activeExecutionId === runningExecutionId;
}

function isCodexOperation(
	key: string,
	value: unknown,
	sessions: Record<string, CodexSession>,
): value is CodexOperation {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"schemaVersion",
			"state",
			"nativeSessionRef",
			"configVersion",
			"internalModel",
			"reasoningLevel",
			"admissionPending",
			"admissionRecoveryPending",
			"executionId",
			"turnId",
			"record",
		]) ||
		!nonEmptyString(value.nativeSessionRef) ||
		(value.schemaVersion !== 1 && value.schemaVersion !== 2)
	) {
		return false;
	}
	const session = ownRecordValue(sessions, value.nativeSessionRef);
	if (!session) return false;
	let identity: unknown;
	try {
		identity = JSON.parse(key);
	} catch {
		return false;
	}
	if (!Array.isArray(identity) || identity.length !== 5) return false;
	const [agentId, conversationId, sessionGeneration, kind, operationId] =
		identity;
	if (
		agentId !== session.agentId ||
		conversationId !== session.conversationId ||
		sessionGeneration !== session.sessionGeneration ||
		!isCodexOperationKind(kind) ||
		!nonEmptyString(operationId) ||
		operationKey({
			agentId: session.agentId,
			conversationId: session.conversationId,
			sessionGeneration: session.sessionGeneration,
			kind,
			operationId,
		}) !== key
	) {
		return false;
	}
	if (value.schemaVersion === 2 && kind !== "submit-turn") return false;
	const isInterruption = kind === "stop" || kind === "generation-cancel";
	if (
		(kind === "submit-turn" &&
			value.configVersion !== undefined &&
			(typeof value.configVersion !== "string" ||
				!codexModelPattern.test(value.configVersion))) ||
		(value.internalModel !== undefined &&
			(isInterruption ||
				typeof value.internalModel !== "string" ||
				!/^(?:[a-f0-9]{64}\/)?[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
					value.internalModel,
				))) ||
		(value.reasoningLevel !== undefined &&
			(isInterruption ||
				typeof value.reasoningLevel !== "string" ||
				!codexReasoningPattern.test(value.reasoningLevel))) ||
		(isInterruption && value.configVersion !== undefined)
	) {
		return false;
	}
	if (isInterruption) {
		if (!nonEmptyString(value.executionId) || !nonEmptyString(value.turnId)) {
			return false;
		}
		const execution = ownRecordValue(session.executions, value.executionId);
		if (!execution || execution.turnId !== value.turnId) return false;
	} else if (value.executionId !== undefined || value.turnId !== undefined) {
		return false;
	}
	if (value.state === "prepared") {
		return (
			value.admissionPending === undefined &&
			value.admissionRecoveryPending === undefined &&
			value.record === undefined
		);
	}
	if (value.state !== "resolved" || value.record === undefined) return false;
	const record = (
		value.schemaVersion === 2
			? RuntimeDriverSubmitTurnOperationRecordV2Schema
			: RuntimeDriverOperationRecordV1Schema
	).safeParse(value.record);
	if (
		!record.success ||
		record.data.schemaVersion !== value.schemaVersion ||
		record.data.kind !== kind ||
		record.data.nativeSessionRef !== value.nativeSessionRef ||
		record.data.agentId !== session.agentId ||
		record.data.conversationId !== session.conversationId ||
		record.data.sessionGeneration !== session.sessionGeneration ||
		operationKey(record.data) !== key
	) {
		return false;
	}
	if (record.data.result.outcome !== "accepted") {
		return (
			value.admissionPending === undefined &&
			value.admissionRecoveryPending === undefined &&
			record.data.result.outcome !== "unknown"
		);
	}
	if (isInterruption)
		return (
			value.admissionPending === undefined &&
			value.admissionRecoveryPending === undefined
		);
	if (
		(value.admissionPending !== undefined && value.admissionPending !== true) ||
		(value.admissionRecoveryPending !== undefined &&
			value.admissionRecoveryPending !== true) ||
		(value.admissionPending === true && value.admissionRecoveryPending === true)
	) {
		return false;
	}
	const execution = ownRecordValue(session.executions, record.data.operationId);
	return (
		execution !== undefined && execution.status === record.data.result.status
	);
}

function assertDriverState(value: unknown): asserts value is CodexDriverState {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["schemaVersion", "sessions", "operations"]) ||
		value.schemaVersion !== 1 ||
		!isPlainRecord(value.sessions) ||
		!isPlainRecord(value.operations)
	) {
		stateInvalid();
	}
	const sessions = value.sessions as Record<string, CodexSession>;
	const nativeThreadIds = new Set<string>();
	for (const [nativeSessionRef, session] of Object.entries(sessions)) {
		if (!isCodexSession(nativeSessionRef, session)) stateInvalid();
		if (!session.threadId) continue;
		if (nativeThreadIds.has(session.threadId)) stateInvalid();
		nativeThreadIds.add(session.threadId);
	}
	const operations = value.operations as Record<string, CodexOperation>;
	for (const [key, operation] of Object.entries(value.operations)) {
		if (!isCodexOperation(key, operation, sessions)) stateInvalid();
	}
	for (const [nativeSessionRef, session] of Object.entries(sessions)) {
		for (const [executionId, execution] of Object.entries(session.executions)) {
			const operation = ownRecordValue(
				operations,
				operationKey({
					agentId: session.agentId,
					conversationId: session.conversationId,
					sessionGeneration: session.sessionGeneration,
					kind: "submit-turn",
					operationId: executionId,
				}),
			);
			const record = operation?.record;
			if (
				operation?.state !== "resolved" ||
				operation.nativeSessionRef !== nativeSessionRef ||
				!record ||
				record.result.outcome !== "accepted" ||
				record.result.status !== execution.status
			) {
				stateInvalid();
			}
		}
		for (const [nativeTurnId, journal] of Object.entries(
			session.journals ?? {},
		)) {
			const completedEvents = journal.events.filter(
				(event): event is CodexJournalCompletedEvent =>
					event.type === "completed",
			);
			const completedEvent = completedEvents[0];
			if (completedEvents.length > 1) {
				stateInvalid();
			}
			const execution = Object.values(session.executions).find(
				(candidate) => candidate.nativeTurnId === nativeTurnId,
			);
			if (execution) {
				if (
					journal.pendingOperationKey !== undefined ||
					(execution.status === "running"
						? completedEvent !== undefined
						: completedEvent?.payload.status !== execution.status)
				) {
					stateInvalid();
				}
				continue;
			}
			const pendingOperation = journal.pendingOperationKey
				? ownRecordValue(operations, journal.pendingOperationKey)
				: undefined;
			if (
				pendingOperation?.state !== "prepared" ||
				pendingOperation.nativeSessionRef !== nativeSessionRef
			) {
				stateInvalid();
			}
		}
		const uncertainOperationKey = session.acceptanceUncertainOperationKey;
		if (!uncertainOperationKey) continue;
		const operation = ownRecordValue(operations, uncertainOperationKey);
		if (
			operation?.state !== "prepared" ||
			operation.nativeSessionRef !== nativeSessionRef
		) {
			stateInvalid();
		}
	}
}

function unavailableError() {
	return new RuntimeHostError(
		"RUNTIME_CODEX_UNAVAILABLE",
		"Codex Runtime is unavailable",
		503,
		true,
		"unavailable",
	);
}

class CodexSessionUnavailableError extends RuntimeHostError {
	constructor() {
		super(
			"RUNTIME_CODEX_UNAVAILABLE",
			"Codex Runtime is unavailable",
			503,
			true,
			"unavailable",
		);
	}
}

function protocolInvalidError() {
	return new RuntimeHostError(
		"RUNTIME_CODEX_PROTOCOL_INVALID",
		"Codex Runtime returned an invalid response",
		503,
		true,
	);
}

function unavailable(): never {
	throw unavailableError();
}

function protocolInvalid(): never {
	throw protocolInvalidError();
}

function configurationInvalid(): never {
	throw new RuntimeHostError(
		"RUNTIME_CODEX_CONFIGURATION_INVALID",
		"Codex Runtime configuration is unavailable",
		503,
	);
}

function stateInvalid(): never {
	throw new RuntimeHostError(
		"RUNTIME_CODEX_STATE_INVALID",
		"Codex Runtime session state is unavailable",
		503,
	);
}

class CodexModelSelectionRejectedError extends Error {
	constructor() {
		super("Codex Runtime rejected the selected model");
		this.name = "CodexModelSelectionRejectedError";
	}
}

class CodexHistoryNotMaterializedError extends Error {
	constructor() {
		super("Codex Runtime history is not materialized");
		this.name = "CodexHistoryNotMaterializedError";
	}
}

function driverRecord(
	command: RuntimeDriverCommand,
	value: unknown,
): RuntimeDriverOperationRecord {
	const parsed = (
		command.schemaVersion === 2
			? RuntimeDriverSubmitTurnOperationRecordV2Schema
			: RuntimeDriverOperationRecordV1Schema
	).safeParse(value);
	if (!parsed.success) stateInvalid();
	return parsed.data;
}

function statusForTurn(
	value: unknown,
): Extract<RuntimeStatusV1, "running" | "completed" | "failed" | "cancelled"> {
	if (value === "inProgress") return "running";
	if (value === "completed") return "completed";
	if (value === "failed") return "failed";
	if (value === "interrupted") return "cancelled";
	protocolInvalid();
}

function assertContainedConfiguration(
	value: unknown,
	expected: {
		model: string;
		reasoningEffort: string;
		modelAccess?: Pick<CodexModelAccess, "endpoint">;
		connectionProfile?: NonNullable<
			CodexRuntimeDriverOptions["connectionClient"]
		>["profile"];
	},
) {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["config", "origins"]) ||
		!isPlainRecord(value.config) ||
		!isPlainRecord(value.origins)
	) {
		protocolInvalid();
	}
	if (
		value.config.model !== expected.model ||
		value.config.model_reasoning_effort !== expected.reasoningEffort ||
		!isPlainRecord(value.config.features) ||
		value.config.features.plugins !== false
	) {
		configurationInvalid();
	}
	assertOnlySessionFlagOrigins(value.origins);
	for (const key of isolatedConfigurationKeys) {
		if (key === "mcp_servers" && expected.connectionProfile) {
			// ConfigToml serializes these defaults for a fixed URL-only server.
			// Auth/header/helper/other server configuration is never admitted here.
			if (
				!isDeepStrictEqual(value.config.mcp_servers, {
					connection: {
						url: expected.connectionProfile.resource,
						environment_id: "local",
						enabled: true,
						tool_timeout_sec: null,
					},
				})
			)
				configurationInvalid();
			const origin = ownRecordValue(
				value.origins,
				"mcp_servers.connection.url",
			);
			if (origin === undefined) configurationInvalid();
			assertSessionFlagOrigin(origin);
		} else if (!isEmptyRecord(value.config[key])) configurationInvalid();
	}
	if (expected.modelAccess) {
		const configuredProvider = {
			name: "Agent Infra Active Model",
			base_url: expected.modelAccess.endpoint,
			env_key: "AGENT_INFRA_CODEX_MODEL_CREDENTIAL",
			wire_api: "responses",
			requires_openai_auth: false,
			supports_websockets: false,
			request_max_retries: 0,
			stream_max_retries: 0,
		};
		const expectedProvider = {
			...configuredProvider,
			env_key_instructions: null,
			experimental_bearer_token: null,
			auth: null,
			aws: null,
			query_params: null,
			http_headers: null,
			env_http_headers: null,
			stream_idle_timeout_ms: null,
			websocket_connect_timeout_ms: null,
			supports_standalone_web_search: false,
		};
		const providers = value.config.model_providers;
		const provider = isPlainRecord(providers)
			? providers.agent_infra
			: undefined;
		if (
			value.config.model_provider !== "agent_infra" ||
			!isPlainRecord(provider) ||
			!hasOnlyKeys(provider, Object.keys(expectedProvider)) ||
			Object.entries(expectedProvider).some(
				([key, expectedValue]) => provider[key] !== expectedValue,
			)
		) {
			configurationInvalid();
		}
		for (const key of [
			"model_provider",
			...Object.keys(configuredProvider).map(
				(key) => `model_providers.agent_infra.${key}`,
			),
		]) {
			const origin = ownRecordValue(value.origins, key);
			if (origin === undefined) configurationInvalid();
			assertSessionFlagOrigin(origin);
		}
	}
}

function configuredModelOptions(options: CodexRuntimeDriverOptions) {
	if (
		typeof options.configVersion !== "string" ||
		!codexModelPattern.test(options.configVersion)
	) {
		configurationInvalid();
	}
	const configured = new Map<string, ConfiguredCodexRuntimeModelOption>();
	const routes: CodexModelRoute[] = [];
	const values: unknown = options.modelOptions;
	if (!Array.isArray(values) || values.length === 0) configurationInvalid();
	const routed = values.every(
		(value) =>
			isPlainRecord(value) &&
			value.endpoint !== undefined &&
			value.credential !== undefined,
	);
	if (
		!routed &&
		values.some(
			(value) =>
				isPlainRecord(value) &&
				(value.endpoint !== undefined || value.credential !== undefined),
		)
	) {
		configurationInvalid();
	}
	for (const value of values) {
		const expectedKeys = ["modelOptionId", "model", "reasoningLevels"];
		if (routed) expectedKeys.push("endpoint", "credential");
		if (
			!isPlainRecord(value) ||
			!hasOnlyKeys(value, expectedKeys) ||
			!nonEmptyString(value.modelOptionId) ||
			typeof value.model !== "string" ||
			!codexModelPattern.test(value.model) ||
			!Array.isArray(value.reasoningLevels) ||
			value.reasoningLevels.length === 0 ||
			value.reasoningLevels.some(
				(level) =>
					typeof level !== "string" || !codexReasoningPattern.test(level),
			) ||
			new Set(value.reasoningLevels).size !== value.reasoningLevels.length ||
			configured.has(value.modelOptionId)
		) {
			configurationInvalid();
		}
		const internalModel = routed
			? `${createHash("sha256").update(value.modelOptionId).digest("hex")}/${value.model}`
			: value.model;
		if (routed) {
			const access = validateModelAccess({
				endpoint: value.endpoint,
				credential: value.credential,
			});
			if (!access) configurationInvalid();
			routes.push({
				internalModel,
				model: value.model,
				...access,
			});
		}
		configured.set(value.modelOptionId, {
			modelOptionId: value.modelOptionId,
			model: value.model,
			internalModel,
			reasoningLevels: [...value.reasoningLevels],
		});
	}
	const defaultOption = configured.get(options.defaultModelOptionId);
	if (!defaultOption?.reasoningLevels.includes(options.defaultReasoningLevel)) {
		configurationInvalid();
	}
	return {
		configured,
		defaultSelection: {
			model: defaultOption.internalModel,
			effort: options.defaultReasoningLevel,
		},
		routes,
	};
}

interface PinnedModelProfile {
	model: string;
	reasoningLevels: ReadonlySet<string>;
}

function parsePinnedModelProfiles(value: unknown) {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["data", "nextCursor"]) ||
		!Array.isArray(value.data) ||
		(value.nextCursor !== undefined &&
			value.nextCursor !== null &&
			!nonEmptyString(value.nextCursor))
	) {
		protocolInvalid();
	}
	const profiles: PinnedModelProfile[] = [];
	for (const model of value.data) {
		if (
			!isPlainRecord(model) ||
			typeof model.model !== "string" ||
			!codexModelPattern.test(model.model) ||
			!Array.isArray(model.supportedReasoningEfforts)
		) {
			protocolInvalid();
		}
		const reasoningLevels = new Set<string>();
		for (const effort of model.supportedReasoningEfforts) {
			if (
				!isPlainRecord(effort) ||
				typeof effort.reasoningEffort !== "string" ||
				!codexReasoningPattern.test(effort.reasoningEffort) ||
				reasoningLevels.has(effort.reasoningEffort)
			) {
				protocolInvalid();
			}
			reasoningLevels.add(effort.reasoningEffort);
		}
		profiles.push({ model: model.model, reasoningLevels });
	}
	return {
		profiles,
		nextCursor: value.nextCursor as string | null | undefined,
	};
}

async function assertPinnedModelProfiles(
	rpc: CodexRpc,
	modelOptions: ReadonlyMap<string, ConfiguredCodexRuntimeModelOption>,
) {
	const profiles: PinnedModelProfile[] = [];
	const cursors = new Set<string>();
	const modelNames = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < maximumModelsListPages; page += 1) {
		const result = await rpc.request(
			"model/list",
			{
				includeHidden: true,
				limit: modelsListPageSize,
				...(cursor ? { cursor } : {}),
			},
			parsePinnedModelProfiles,
		);
		for (const profile of result.profiles) {
			if (modelNames.has(profile.model)) protocolInvalid();
			modelNames.add(profile.model);
			profiles.push(profile);
		}
		if (!result.nextCursor) {
			for (const option of modelOptions.values()) {
				const profile = profiles.reduce<PinnedModelProfile | undefined>(
					(best, candidate) =>
						(option.model === candidate.model ||
							option.model.startsWith(`${candidate.model}-`)) &&
						(!best || candidate.model.length > best.model.length)
							? candidate
							: best,
					undefined,
				);
				if (
					!profile ||
					option.reasoningLevels.some(
						(level) => !profile.reasoningLevels.has(level),
					)
				) {
					configurationInvalid();
				}
			}
			return;
		}
		if (cursors.has(result.nextCursor)) protocolInvalid();
		cursors.add(result.nextCursor);
		cursor = result.nextCursor;
	}
	protocolInvalid();
}

function turnStartedNotification(frame: CodexAppServerFrame) {
	if (frame.method !== "turn/started") return undefined;
	const params = frame.params;
	if (
		!isPlainRecord(params) ||
		!hasOnlyKeys(params, ["threadId", "turn"]) ||
		!nonEmptyString(params.threadId) ||
		!isPlainRecord(params.turn) ||
		!nonEmptyString(params.turn.id) ||
		!Array.isArray(params.turn.items)
	) {
		protocolInvalid();
	}
	return {
		threadId: params.threadId,
		nativeTurnId: params.turn.id,
		status: statusForTurn(params.turn.status),
	};
}

function agentMessageDeltaNotification(frame: CodexAppServerFrame) {
	if (frame.method !== "item/agentMessage/delta") return undefined;
	const params = frame.params;
	if (
		!isPlainRecord(params) ||
		!hasOnlyKeys(params, ["threadId", "turnId", "itemId", "delta"]) ||
		!nonEmptyString(params.threadId) ||
		!nonEmptyString(params.turnId) ||
		!nonEmptyString(params.itemId) ||
		typeof params.delta !== "string"
	) {
		protocolInvalid();
	}
	return {
		threadId: params.threadId,
		nativeTurnId: params.turnId,
		nativeItemId: params.itemId,
		delta: params.delta,
	};
}

function agentMessageCompletedNotification(frame: CodexAppServerFrame) {
	if (frame.method !== "item/completed") return undefined;
	const params = frame.params;
	if (
		!isPlainRecord(params) ||
		!nonEmptyString(params.threadId) ||
		!nonEmptyString(params.turnId) ||
		!isPlainRecord(params.item)
	) {
		protocolInvalid();
	}
	// Only the agent message carries replayable text; other item types stay
	// opaque to the platform.
	if (params.item.type !== "agentMessage") return undefined;
	if (!nonEmptyString(params.item.id) || typeof params.item.text !== "string") {
		protocolInvalid();
	}
	return {
		threadId: params.threadId,
		nativeTurnId: params.turnId,
		nativeItemId: params.item.id,
		text: params.item.text,
	};
}

function turnCompletedNotification(frame: CodexAppServerFrame) {
	if (frame.method !== "turn/completed") return undefined;
	const params = frame.params;
	if (
		!isPlainRecord(params) ||
		!hasOnlyKeys(params, ["threadId", "turn"]) ||
		!nonEmptyString(params.threadId) ||
		!isPlainRecord(params.turn) ||
		!nonEmptyString(params.turn.id) ||
		!Array.isArray(params.turn.items)
	) {
		protocolInvalid();
	}
	const status = statusForTurn(params.turn.status);
	if (status === "running") protocolInvalid();
	return { threadId: params.threadId, nativeTurnId: params.turn.id, status };
}

class CodexRpc {
	private readonly pending = new Map<number, PendingRequest>();
	private readonly consuming: Promise<void>;
	private nextRequestId = 1;
	private failed = false;

	constructor(
		private readonly bridge: CodexAppServerTransport,
		private readonly onNotification: CodexNotificationHandler,
		private readonly onFailure?: () => void,
	) {
		this.consuming = this.consume();
	}

	async request<T>(
		method: string,
		params: Record<string, unknown>,
		parse: (value: unknown) => T,
		nativeSelectionRejection = false,
		allowHistoryMaterializationRetry = false,
		deadlineAt = Date.now() + rpcRequestTimeoutMs,
	) {
		if (this.failed) unavailable();
		const id = this.nextRequestId++;
		const response = new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				method,
				resolve: (value) => resolve(parse(value)),
				reject,
				nativeSelectionRejection,
				allowHistoryMaterializationRetry,
			});
		});
		void response.catch(() => {});
		const timeoutError = unavailableError();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => {
					this.fail(timeoutError);
					reject(timeoutError);
				},
				Math.max(0, deadlineAt - Date.now()),
			);
		});
		try {
			await Promise.race([this.bridge.send({ id, method, params }), deadline]);
			return await Promise.race([response, deadline]);
		} catch (error) {
			this.pending.delete(id);
			if (error instanceof CodexModelSelectionRejectedError) throw error;
			if (error instanceof CodexSessionUnavailableError) throw error;
			if (error instanceof CodexHistoryNotMaterializedError) throw error;
			const failure =
				error instanceof RuntimeHostError ? error : unavailableError();
			this.fail(failure);
			throw failure;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async close() {
		this.fail();
		try {
			await this.bridge.close?.();
		} catch {
			// Closing a failed bridge cannot change a completed Driver result.
		}
		await this.consuming;
	}

	private async consume() {
		try {
			for await (const frame of this.bridge.frames()) {
				await this.receive(frame);
				if (this.failed) return;
			}
		} catch {
			// The bridge is an unavailable dependency from the Driver's perspective.
		}
		this.fail();
	}

	private async receive(frame: CodexAppServerFrame) {
		if (!isPlainRecord(frame)) {
			this.fail(protocolInvalidError());
			return;
		}
		if (!("id" in frame)) {
			if (typeof frame.method !== "string") {
				this.fail(protocolInvalidError());
				return;
			}
			try {
				await this.onNotification(frame);
			} catch (error) {
				this.fail(
					error instanceof RuntimeHostError ? error : protocolInvalidError(),
				);
			}
			return;
		}
		if ("method" in frame) {
			if (
				typeof frame.method !== "string" ||
				!isJsonRpcRequestId(frame.id) ||
				!containedServerRequestMethods.has(frame.method)
			) {
				this.fail(protocolInvalidError());
				return;
			}
			this.denyDelegatedToolRequest(frame.id);
			return;
		}
		if (typeof frame.id !== "number" || !Number.isSafeInteger(frame.id)) {
			this.fail(protocolInvalidError());
			return;
		}
		const pending = this.pending.get(frame.id);
		if (!pending) {
			this.fail(protocolInvalidError());
			return;
		}
		if ("error" in frame) {
			if (
				pending.allowHistoryMaterializationRetry &&
				isHistoryNotMaterializedError(frame.error)
			) {
				pending.reject(new CodexHistoryNotMaterializedError());
				this.pending.delete(frame.id);
				return;
			}
			if (
				pending.method === "thread/resume" &&
				isPlainRecord(frame.error) &&
				Number.isSafeInteger(frame.error.code) &&
				nonEmptyString(frame.error.message)
			) {
				pending.reject(new CodexSessionUnavailableError());
				this.pending.delete(frame.id);
				return;
			}
			if (
				pending.nativeSelectionRejection &&
				isNativeSelectionRejection(frame.error)
			) {
				pending.reject(new CodexModelSelectionRejectedError());
				this.pending.delete(frame.id);
				return;
			}
			this.fail(protocolInvalidError());
			return;
		}
		if (!("result" in frame)) {
			this.fail(protocolInvalidError());
			return;
		}
		try {
			pending.resolve(frame.result);
		} catch (error) {
			this.fail(
				error instanceof RuntimeHostError ? error : protocolInvalidError(),
			);
			return;
		}
		this.pending.delete(frame.id);
	}

	private denyDelegatedToolRequest(id: string | number) {
		// #186 owns the only delegated Tool route; native request parameters stay opaque here.
		void this.bridge
			.send({ id, error: delegatedToolUnavailableJsonRpcError })
			.catch(() => this.fail(unavailableError()));
	}

	private fail(error = unavailableError()) {
		if (this.failed) return;
		this.failed = true;
		this.onFailure?.();
		void this.bridge.close?.().catch(() => {});
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

export class CodexRuntimeDriver implements RuntimeDriver {
	private readonly resumedSessions = new Set<string>();
	private readonly inFlightSessionResumes = new Map<string, Promise<void>>();
	private readonly eventWaiters = new Map<string, Set<() => void>>();
	private readonly recoveredEventExecutions = new Set<string>();
	private readonly inFlightEventRecoveries = new Map<string, Promise<void>>();
	private readonly observedNativeTurnStarts = new Set<string>();
	private readonly nativeTurnStartWaiters = new Map<string, Set<() => void>>();
	private readonly initialModelStatusPending = new Set<string>();
	private readonly modelAdmissionDeadlines = new Map<string, number>();
	private readonly modelTurnAdmissions = new Map<
		string,
		CodexModelTurnAdmission
	>();
	/** A registered child turn may arrive before its durable bind is committed. */
	private readonly admittedPendingSourceTurns = new Map<
		string,
		Map<string, number>
	>();
	private readonly inFlightOperations = new Map<
		string,
		Promise<RuntimeDriverOperationRecord>
	>();
	private readonly inFlightNativeSourceCallbacks = new Map<
		string,
		Promise<CodexNativeSourceResponseV1>
	>();

	private retainPendingSourceTurn(turnKey: string, requestId: string): void {
		const requests =
			this.admittedPendingSourceTurns.get(turnKey) ?? new Map<string, number>();
		requests.set(requestId, (requests.get(requestId) ?? 0) + 1);
		this.admittedPendingSourceTurns.set(turnKey, requests);
	}

	private releasePendingSourceTurn(turnKey: string, requestId: string): void {
		const requests = this.admittedPendingSourceTurns.get(turnKey);
		const count = requests?.get(requestId);
		if (count === undefined) return;
		if (count > 1) requests?.set(requestId, count - 1);
		else requests?.delete(requestId);
		if (requests?.size === 0) this.admittedPendingSourceTurns.delete(turnKey);
	}

	private hasPendingSourceTurn(turnKey: string, requestId: string): boolean {
		return (
			this.admittedPendingSourceTurns.get(turnKey)?.has(requestId) === true
		);
	}

	/** @internal */
	protected constructor(
		private readonly file: DurableJsonFile<CodexDriverState>,
		private readonly openConversationBridge: (
			conversationKey: string,
		) => Promise<CodexAppServerTransport>,
		private readonly assertContainedNativeConfiguration: (
			rpc: CodexRpc,
		) => Promise<void>,
		private readonly modelOptions: ReadonlyMap<
			string,
			ConfiguredCodexRuntimeModelOption
		>,
		private readonly defaultSelection: { model: string; effort: string },
		private readonly configVersion: string,
		private readonly closeModelTransport?: () => Promise<void>,
		private readonly revokeModelConversation?: (
			conversationKey: string,
		) => void,
		private readonly beginModelTurnAdmission?: (
			deadline: number,
			internalModel: string,
			threadId: string,
			reasoningLevel: string,
			conversationKey: string,
		) => CodexModelTurnAdmission,
		private readonly recognizeModelTurn?: (
			admission: CodexModelTurnAdmission,
			turn: CodexModelTurn,
		) => boolean,
		private readonly registerModelTurn?: (
			admission: CodexModelTurnAdmission,
			turn: CodexModelTurn,
		) => boolean,
		private readonly waitForModelRequest?: (
			turn: CodexModelTurn,
			deadline: number,
			signal?: AbortSignal,
		) => Promise<boolean>,
		private readonly abandonModelTurnAdmission?: (
			admission: CodexModelTurnAdmission,
		) => void,
		private readonly cancelModelTurn?: (turn: CodexModelTurn) => Promise<void>,
		private readonly revokeModelTurn?: (turn: CodexModelTurn) => void,
		private readonly probeNative?: (
			signal: AbortSignal,
		) => Promise<RuntimeCapabilitiesV1>,
		private readonly authorizeExternalAction?: (
			action: RuntimeExternalActionAuthorization,
		) => Promise<void>,
		private readonly connectionClientOptions?: CodexRuntimeDriverOptions["connectionClient"],
		private readonly recoveryLaunch?: typeof runCodexConnectionRecovery,
		private readonly recoveryDirectory?: string,
		private readonly recoveryLaunchPath?: string,
	) {}

	private readonly connectionRecoveries = new Map<
		string,
		{
			nativeSessionRef: string;
			executionId: string;
			recoveryRequestId: string;
			abort: AbortController;
			finished: Promise<void>;
		}
	>();

	private connectionRecoveryClosed(
		state: CodexDriverState,
		nativeSessionRef: string,
		executionId: string,
	) {
		return Object.entries(state.operations).some(
			([key, operation]) =>
				operation.nativeSessionRef === nativeSessionRef &&
				operation.executionId === executionId &&
				["stop", "generation-cancel"].includes(
					(JSON.parse(key) as unknown[])[3] as string,
				),
		);
	}

	private abortConnectionRecoveries(
		nativeSessionRef?: string,
		executionId?: string,
	) {
		for (const guard of this.connectionRecoveries.values()) {
			if (
				(nativeSessionRef === undefined ||
					guard.nativeSessionRef === nativeSessionRef) &&
				(executionId === undefined || guard.executionId === executionId)
			)
				guard.abort.abort();
		}
	}

	private async drainConnectionRecoveries(
		nativeSessionRef?: string,
		executionId?: string,
	) {
		this.abortConnectionRecoveries(nativeSessionRef, executionId);
		await Promise.allSettled(
			[...this.connectionRecoveries.values()]
				.filter(
					(guard) =>
						(nativeSessionRef === undefined ||
							guard.nativeSessionRef === nativeSessionRef) &&
						(executionId === undefined || guard.executionId === executionId),
				)
				.map((guard) => guard.finished),
		);
	}

	/** @internal Keep the private process separate from the app-server transport. */
	protected launchConnectionRecovery(
		options: Parameters<typeof runCodexConnectionRecovery>[0],
	) {
		if (!this.recoveryLaunch) unavailable();
		return this.recoveryLaunch(options);
	}

	recoverOriginalEvidence(
		reference: RuntimeOriginalEvidenceRecoveryRef,
		read: RuntimeOriginalEvidenceReadContext,
	): Promise<void> {
		if (this.closed) return Promise.reject(unavailableError());
		const key = JSON.stringify([
			reference.nativeSessionRef,
			reference.executionId,
		]);
		const existing = this.connectionRecoveries.get(key);
		if (existing) {
			if (existing.recoveryRequestId !== reference.recoveryRequestId)
				return Promise.reject(unavailableError());
			return existing.finished;
		}
		const abort = new AbortController();
		const guard = {
			nativeSessionRef: reference.nativeSessionRef,
			executionId: reference.executionId,
			recoveryRequestId: reference.recoveryRequestId,
			abort,
			finished: Promise.resolve().then(() =>
				this.performConnectionRecovery(reference, read, abort.signal),
			),
		};
		this.connectionRecoveries.set(key, guard);
		return guard.finished.finally(() => {
			if (this.connectionRecoveries.get(key) === guard)
				this.connectionRecoveries.delete(key);
		});
	}

	private async performConnectionRecovery(
		reference: RuntimeOriginalEvidenceRecoveryRef,
		read: RuntimeOriginalEvidenceReadContext,
		abort: AbortSignal,
	) {
		const options = this.connectionClientOptions;
		if (!options?.resolveReadOnlyClient || !this.recoveryDirectory) return;
		const binding = structuredClone(read.assertCurrent());
		const signal = AbortSignal.any([
			read.signal,
			abort,
			AbortSignal.timeout(
				Math.max(1, Math.min(30_000, read.expiresAt - Date.now())),
			),
		]);
		const locate = (state: CodexDriverState) => {
			signal.throwIfAborted();
			if (
				this.closed ||
				Date.now() >= read.expiresAt ||
				!isDeepStrictEqual(read.assertCurrent(), binding) ||
				this.connectionRecoveryClosed(
					state,
					reference.nativeSessionRef,
					reference.executionId,
				)
			)
				unavailable();
			const session = ownRecordValue(
				state.sessions,
				reference.nativeSessionRef,
			);
			const execution =
				session && ownRecordValue(session.executions, reference.executionId);
			const journal = execution && session?.journals?.[execution.nativeTurnId];
			if (
				!session ||
				!execution ||
				!journal ||
				!isDeepStrictEqual(binding.scope, {
					agentId: session.agentId,
					conversationId: session.conversationId,
					sessionGeneration: session.sessionGeneration,
					executionId: execution.executionId,
				})
			)
				unavailable();
			return { session, execution, journal };
		};
		// Host ordering precedes the Driver file queue for every recovery mutation.
		const change = <T>(write: (value: ReturnType<typeof locate>) => T) =>
			read.commit(() => this.update((state) => write(locate(state))));
		const initial = await change(({ session, journal }) => {
			if (
				journal.connectionRecovery?.recoveryRequestId !==
				reference.recoveryRequestId
			) {
				journal.connectionRecovery = {
					recoveryRequestId: reference.recoveryRequestId,
					deadlineAt: Math.min(Date.now() + 30_000, read.expiresAt),
					scannedAttemptRefs: [],
					completed: false,
				};
			}
			return {
				pass: structuredClone(journal.connectionRecovery),
				conversationKey: codexConversationKey(session),
			};
		});
		if (initial.pass.completed || initial.pass.deadlineAt <= Date.now()) return;
		const processSignal = AbortSignal.any([
			signal,
			AbortSignal.timeout(Math.max(1, initial.pass.deadlineAt - Date.now())),
		]);
		let processNonce: string | undefined;
		let previousRecoveryId: string | undefined;
		const requests = new Set<string>();
		let current:
			| {
					// Driver journal key; native identity.attemptRef is a different reference.
					attemptRef: string;
					original: CodexConnectionRecoveryOriginal;
					queryClient: CodexConnectionQueryMetadata;
			  }
			| undefined;
		let markScannedEvidence: (() => Promise<void>) | undefined;
		const requireAcknowledgedEvidence = (pass: CodexConnectionRecoveryPass) => {
			if (current && !pass.scannedAttemptRefs.includes(current.attemptRef))
				protocolInvalid();
		};
		const recovery = async (
			request: CodexConnectionRecoveryRequest,
			callbackSignal: AbortSignal,
		): Promise<CodexConnectionRecoveryResponse> => {
			const itemSignal = AbortSignal.any([processSignal, callbackSignal]);
			itemSignal.throwIfAborted();
			if (
				request.profileRef !== options.profile.profileRef ||
				requests.has(request.requestId) ||
				(processNonce !== undefined && processNonce !== request.processNonce) ||
				request.previousRecoveryId !== previousRecoveryId
			)
				protocolInvalid();
			processNonce = request.processNonce;
			requests.add(request.requestId);
			const selected = await change(({ journal }) => {
				itemSignal.throwIfAborted();
				const pass = journal.connectionRecovery;
				if (!pass || pass.recoveryRequestId !== reference.recoveryRequestId)
					unavailable();
				requireAcknowledgedEvidence(pass);
				current = undefined;
				if (
					pass.completed ||
					pass.deadlineAt <= Date.now() ||
					pass.scannedAttemptRefs.length >= 16
				) {
					pass.completed = true;
					return undefined;
				}
				const attempts = Object.values(journal.nativeToolAttempts ?? {}).sort(
					(a, b) => a.attemptRef.localeCompare(b.attemptRef),
				);
				const cursor = attempts.findIndex(
					(attempt) => attempt.attemptRef === journal.connectionRecoveryCursor,
				);
				const ordered = [
					...attempts.slice(cursor + 1),
					...attempts.slice(0, cursor + 1),
				];
				const facts = latestOperationAttemptFacts(journal.events);
				for (const attempt of ordered) {
					const descriptor = attempt.connectionRequest;
					const origin = attempt.connectionOrigin;
					const evidence = attempt.connectionEvidence;
					const originalResponse = evidence?.originalResponse;
					const fact = facts.find(
						(fact) =>
							operationAttemptKey(fact) === operationAttemptKey(attempt),
					);
					if (
						pass.scannedAttemptRefs.includes(attempt.attemptRef) ||
						!attempt.permitId ||
						!attempt.outcomeRequestId ||
						attempt.denied ||
						descriptor?.toolName !== "execute_action" ||
						!origin ||
						!originalResponse ||
						evidence?.verification !== "unverified" ||
						!isDeepStrictEqual(origin.originalBinding, binding) ||
						fact?.kind !== "tool" ||
						!["completed", "failed", "unknown"].includes(fact.phase) ||
						fact.connection?.verification === "verified"
					)
						continue;
					const association = this.connectionClient(
						initial.conversationKey,
					).associate({
						requestDescriptor: descriptor,
						evidence,
						previousEvidence: evidence,
						metadataOnly: true,
						occurredAt: Date.now(),
						origin,
					});
					if (!association?.callRef) continue;
					const original = structuredClone({
						identity: attempt.identity,
						permitId: attempt.permitId,
						connectionRequest: descriptor,
						connectionOrigin: origin,
						originalResponse,
					});
					if (!isCodexConnectionRecoveryOriginal(original)) continue;
					journal.connectionRecoveryCursor = attempt.attemptRef;
					return { attemptRef: attempt.attemptRef, original };
				}
				pass.completed = true;
				return undefined;
			});
			const base = {
				schemaVersion: 2 as const,
				phase: "connection-recovery" as const,
				requestId: request.requestId,
				request,
			};
			if (!selected) return { ...base, decision: "done" };
			const { attemptRef, original } = selected;
			const markScanned = async () => {
				await change(({ journal }) => {
					const pass = journal.connectionRecovery;
					if (!pass || pass.recoveryRequestId !== reference.recoveryRequestId)
						unavailable();
					if (!pass.scannedAttemptRefs.includes(attemptRef))
						pass.scannedAttemptRefs.push(attemptRef);
				});
			};
			markScannedEvidence = markScanned;
			let value: unknown;
			const waiting = new AbortController();
			try {
				value = await Promise.race([
					options.resolveReadOnlyClient?.(
						{ ...binding.scope, nativeSessionRef: reference.nativeSessionRef },
						read,
						itemSignal,
					),
					once(itemSignal, "abort", { signal: waiting.signal }).then(() =>
						unavailable(),
					),
				]);
			} catch {
				itemSignal.throwIfAborted();
				read.assertCurrent();
				await markScanned();
				return {
					...base,
					decision: "unavailable",
					reason: "credential_unavailable",
				};
			} finally {
				waiting.abort();
			}
			itemSignal.throwIfAborted();
			locate(this.readState());
			if (!isCodexConnectionClientConfiguration(value)) {
				await markScanned();
				return {
					...base,
					decision: "unavailable",
					reason: "credential_unavailable",
				};
			}
			if (
				!isDeepStrictEqual(
					value.originalBinding,
					original.connectionOrigin.originalBinding,
				) ||
				!isDeepStrictEqual(value.service, original.connectionOrigin.service) ||
				!isDeepStrictEqual(
					value.connectionIdentity,
					original.connectionOrigin.connectionIdentity,
				)
			) {
				await markScanned();
				return { ...base, decision: "unavailable", reason: "binding_mismatch" };
			}
			const expiresAt = Math.min(
				initial.pass.deadlineAt,
				read.expiresAt,
				value.credential.expiresAt,
			);
			if (expiresAt <= Date.now()) {
				await markScanned();
				return {
					...base,
					decision: "unavailable",
					reason: "credential_expired",
				};
			}
			previousRecoveryId = randomUUID();
			current = {
				attemptRef,
				original,
				queryClient: structuredClone({
					originalBinding: value.originalBinding,
					service: value.service,
					connectionIdentity: value.connectionIdentity,
					credential: {
						revision: value.credential.revision,
						expiresAt: value.credential.expiresAt,
					},
				}),
			};
			return {
				...base,
				decision: "verify",
				recoveryId: previousRecoveryId,
				expiresAt,
				original,
				currentClient: value,
			};
		};
		let recoveryProcessCompleted = false;
		try {
			await this.launchConnectionRecovery({
				...(this.recoveryLaunchPath
					? { launchPath: this.recoveryLaunchPath }
					: {}),
				dataDirectory: this.recoveryDirectory,
				conversationKey: initial.conversationKey,
				profile: options.profile,
				authorizedConnectionService: options.authorizedService,
				nativeBarrierRequired: true,
				signal: processSignal,
				recovery,
				evidence: async (request, callbackSignal) => {
					const item = current;
					if (
						request.schemaVersion !== 2 ||
						request.phase !== "connection-evidence" ||
						request.connectionEvidence.verification !== "verified" ||
						!item ||
						!sameCodexNativeAttemptV1(
							request.identity,
							item.original.identity,
						) ||
						request.permitId !== item.original.permitId ||
						!isDeepStrictEqual(
							request.connectionRequest,
							item.original.connectionRequest,
						) ||
						!isDeepStrictEqual(
							request.connectionEvidence.originalResponse,
							item.original.originalResponse,
						)
					)
						protocolInvalid();
					const result = await this.performNativeConnectionEvidence(
						initial.conversationKey,
						request,
						AbortSignal.any([processSignal, callbackSignal]),
						{ read, ...item },
					);
					if (!processSignal.aborted && !callbackSignal.aborted)
						await markScannedEvidence?.();
					return result;
				},
			});
			recoveryProcessCompleted = true;
		} catch {
			// Native or Connection unavailability cannot create a new Tool outcome.
			signal.throwIfAborted();
			read.assertCurrent();
		} finally {
			if (!recoveryProcessCompleted) current = undefined;
		}
		if (!recoveryProcessCompleted) return;
		try {
			await change(({ journal }) => {
				const pass = journal.connectionRecovery;
				if (pass?.recoveryRequestId === reference.recoveryRequestId) {
					requireAcknowledgedEvidence(pass);
					pass.completed = true;
				}
			});
		} finally {
			current = undefined;
		}
	}

	private readonly connectionClients = new Map<
		string,
		ReturnType<typeof createCodexConnectionClient>
	>();
	// These scopes exist only during one synchronous, server-validated client call.
	// Read-only query metadata comes from the deployment resolver, never wire fields.
	private connectionAdmission?: {
		conversationKey: string;
		request: CodexConnectionRequest;
	};
	private readOnlyQueryAdmission?: {
		conversationKey: string;
		request: CodexConnectionRequest;
		origin: CodexConnectionOrigin;
		metadata: CodexConnectionQueryMetadata;
	};

	private hasConnectionJournalAttempt(
		conversationKey: string,
		matches: (attempt: CodexNativeToolAttempt) => boolean,
	) {
		return Object.values(this.readState().sessions).some(
			(session) =>
				codexConversationKey(session) === conversationKey &&
				Object.values(session.journals ?? {}).some((journal) =>
					Object.values(journal.nativeToolAttempts ?? {}).some(matches),
				),
		);
	}

	private originalConnectionExecution(
		conversationKey: string,
		nativeThreadId?: string,
	): RuntimeOriginalExecutionRef {
		if (this.closed) unavailable();
		const state = this.readState();
		const sessions = Object.values(state.sessions).filter(
			(session) => codexConversationKey(session) === conversationKey,
		);
		if (sessions.length !== 1) unavailable();
		const session = sessions[0];
		if (
			!session ||
			session.acceptanceUncertainOperationKey ||
			(nativeThreadId !== undefined && session.threadId !== nativeThreadId)
		)
			unavailable();
		const pending = Object.entries(state.operations).flatMap(
			([key, operation]) => {
				const identity: unknown = JSON.parse(key);
				return operation.nativeSessionRef === session.nativeSessionRef &&
					operation.state === "prepared" &&
					Array.isArray(identity) &&
					identity[3] === "submit-turn" &&
					typeof identity[4] === "string"
					? [identity[4]]
					: [];
			},
		);
		if (
			pending.length > 1 ||
			(pending[0] &&
				session.activeExecutionId &&
				pending[0] !== session.activeExecutionId)
		)
			unavailable();
		const executionId = pending[0] ?? session.activeExecutionId;
		if (
			!executionId ||
			this.hasInterruption(session.nativeSessionRef, executionId, state)
		)
			unavailable();
		const execution = ownRecordValue(session.executions, executionId);
		if (
			execution &&
			(execution.status !== "running" ||
				session.journals?.[execution.nativeTurnId]?.externalActionsBlocked)
		)
			unavailable();
		const operation = ownRecordValue(
			state.operations,
			operationKey({
				...session,
				kind: "submit-turn",
				operationId: executionId,
			}),
		);
		if (
			!operation ||
			operation.configVersion !== this.configVersion ||
			!this.operationSelection(operation)
		)
			unavailable();
		return {
			agentId: session.agentId,
			conversationId: session.conversationId,
			sessionGeneration: session.sessionGeneration,
			executionId,
			nativeSessionRef: session.nativeSessionRef,
		};
	}

	private connectionClient(conversationKey: string) {
		const options = this.connectionClientOptions;
		if (!options || this.closed) unavailable();
		const existing = this.connectionClients.get(conversationKey);
		if (existing) return existing;
		const client = createCodexConnectionClient({
			profile: options.profile,
			authorizedService: options.authorizedService,
			authorizeRequest: (request) =>
				(this.connectionAdmission?.conversationKey === conversationKey &&
					isDeepStrictEqual(this.connectionAdmission.request, request)) ||
				this.hasConnectionJournalAttempt(conversationKey, (attempt) =>
					isDeepStrictEqual(attempt.connectionRequest, request),
				),
			authorizeOrigin: (origin) =>
				this.hasConnectionJournalAttempt(conversationKey, (attempt) =>
					isDeepStrictEqual(attempt.connectionOrigin, origin),
				),
			resolveReadOnlyQueryMetadata: (query) => {
				const current = this.readOnlyQueryAdmission;
				if (
					current?.conversationKey !== conversationKey ||
					!isDeepStrictEqual(current.request, query.requestDescriptor) ||
					!isDeepStrictEqual(current.origin, query.origin) ||
					current.metadata.credential.revision !== query.credentialRevision ||
					current.metadata.credential.expiresAt <= query.queriedAt
				)
					return undefined;
				return structuredClone(current.metadata);
			},
			resolveOriginalClient: async (request, signal) => {
				const reference = this.originalConnectionExecution(
					conversationKey,
					request.nativeSessionRef,
				);
				signal.throwIfAborted();
				const value = await options.resolveOriginalClient(reference, signal);
				signal.throwIfAborted();
				const current = this.originalConnectionExecution(
					conversationKey,
					request.nativeSessionRef,
				);
				if (
					JSON.stringify(reference) !== JSON.stringify(current) ||
					!isPlainRecord(value) ||
					!isCodexConnectionOriginalBinding(value.originalBinding)
				)
					unavailable();
				const { nativeSessionRef: _nativeSessionRef, ...scope } = reference;
				const binding = value.originalBinding.scope;
				if (
					binding.agentId !== scope.agentId ||
					binding.conversationId !== scope.conversationId ||
					binding.sessionGeneration !== scope.sessionGeneration ||
					binding.executionId !== scope.executionId
				)
					unavailable();
				return value;
			},
		});
		this.connectionClients.set(conversationKey, client);
		return client;
	}

	private revokeConnectionClient(conversationKey: string) {
		this.connectionClients.get(conversationKey)?.close();
		this.connectionClients.delete(conversationKey);
	}

	// One native process per Conversation generation. The key is derived from the
	// server-resolved binding, never from a wire field.
	private readonly conversationRpcs = new Map<string, CodexRpc>();
	// A transport multiplexes one JSON-RPC id space, so it can never carry two
	// request multiplexers. It is also bound to the Conversation it was opened
	// for: reusing it for another key would alias two Conversations onto one
	// native process, which is exactly the isolation this class provides.
	private readonly rpcsByTransport = new Map<
		CodexAppServerTransport,
		{ readonly conversationKey: string; readonly rpc: CodexRpc }
	>();
	private readonly inFlightConversationRpcs = new Map<
		string,
		Promise<CodexRpc>
	>();
	private readonly finalModelAdmissionConfirmations = new Map<
		string,
		Promise<boolean>
	>();
	private closed = false;
	private closing?: Promise<void>;
	private readonly nativeCallbacks = new Set<{
		conversationKey: string;
		identity: CodexNativeAttemptIdentityV1;
		abort: AbortController;
		finished: Promise<CodexNativeCallbackResponse>;
	}>();

	/**
	 * Production opens one native process per Conversation, so a transport is
	 * permanently bound to the Conversation that opened it. Only a scripted test
	 * double serves every Conversation from a single transport, because one
	 * transport can host exactly one JSON-RPC multiplexer.
	 */
	protected sharesOneNativeTransport() {
		return false;
	}

	protected modelConversationKey(conversationKey: string) {
		return conversationKey;
	}

	private conversationKeyFor(nativeSessionRef: string) {
		const session = this.session(nativeSessionRef);
		return codexConversationKey({
			agentId: session.agentId,
			conversationId: session.conversationId,
			sessionGeneration: session.sessionGeneration,
		});
	}

	private async rpc(nativeSessionRef: string) {
		if (this.closed) unavailable();
		const key = this.conversationKeyFor(nativeSessionRef);
		const existing = this.conversationRpcs.get(key);
		if (existing) return existing;
		const inFlight = this.inFlightConversationRpcs.get(key);
		if (inFlight) return inFlight;
		const opening = this.openConversationRpc(key);
		this.inFlightConversationRpcs.set(key, opening);
		try {
			return await opening;
		} finally {
			if (this.inFlightConversationRpcs.get(key) === opening) {
				this.inFlightConversationRpcs.delete(key);
			}
		}
	}

	protected async openConversationRpc(conversationKey: string) {
		let bridge: CodexAppServerTransport;
		try {
			bridge = await this.openConversationBridge(conversationKey);
		} catch {
			this.revokeConnectionClient(conversationKey);
			this.revokeModelConversation?.(
				this.modelConversationKey(conversationKey),
			);
			unavailable();
		}
		const opened = this.rpcsByTransport.get(bridge);
		if (opened) {
			// A production transport is a freshly opened native process, so seeing one
			// again for another Conversation would alias two Conversations onto one
			// process and undo the isolation this class exists to provide.
			if (
				opened.conversationKey !== conversationKey &&
				!this.sharesOneNativeTransport()
			) {
				this.revokeModelConversation?.(
					this.modelConversationKey(conversationKey),
				);
				unavailable();
			}
			this.conversationRpcs.set(conversationKey, opened.rpc);
			return opened.rpc;
		}
		const rpc = new CodexRpc(
			bridge,
			(frame) =>
				// Native thread and turn IDs are scoped to one app-server process, so
				// notification routing is bound to the Conversation that owns the
				// transport rather than to the ID alone.
				this.recordNotification(
					frame,
					// The scripted test double serves every Conversation from one
					// transport, so only production can bind routing to one key.
					this.sharesOneNativeTransport() ? undefined : conversationKey,
				),
			() => {
				// A failed RPC is permanently unusable. Retire every cache entry that
				// points at it before a later request can try to reuse the failed
				// native process. The scripted shared-transport fixture can alias one
				// RPC to several Conversations, so remove all such aliases.
				for (const [key, cached] of this.conversationRpcs) {
					if (cached === rpc) {
						this.conversationRpcs.delete(key);
						this.revokeConnectionClient(key);
						this.revokeModelConversation?.(this.modelConversationKey(key));
					}
				}
				const cached = this.rpcsByTransport.get(bridge);
				if (cached?.rpc === rpc) this.rpcsByTransport.delete(bridge);
			},
		);
		try {
			// Every native process is admitted on its own; a contained
			// configuration on one process never vouches for another.
			await rpc.request(
				"initialize",
				{
					clientInfo: { name: "agent-infra-runtime", version: "1" },
					capabilities: { experimentalApi: true },
				},
				(value) => {
					if (!isPlainRecord(value)) protocolInvalid();
				},
			);
			await this.assertContainedNativeConfiguration(rpc);
		} catch (error) {
			await rpc.close().catch(() => {});
			if (error instanceof RuntimeHostError) throw error;
			unavailable();
		}
		if (this.closed) {
			await rpc.close().catch(() => {});
			unavailable();
		}
		this.rpcsByTransport.set(bridge, { conversationKey, rpc });
		this.conversationRpcs.set(conversationKey, rpc);
		return rpc;
	}

	static async open(options: CodexRuntimeDriverOptions) {
		// The deployment's Driver file and its sibling native storage share one
		// Agent PVC. Losing the mapping must never initialize replacement sessions.
		try {
			if (!isAbsolute(options.path) || resolve(options.path) !== options.path)
				stateInvalid();
			const state = await lstat(options.path).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return undefined;
					throw error;
				},
			);
			const native = await lstat(`${options.path}.native`).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return undefined;
					throw error;
				},
			);
			if ((state && !state.isFile()) || (!state && native)) stateInvalid();
			if (state && !native) {
				const saved: unknown = JSON.parse(await readFile(options.path, "utf8"));
				assertDriverState(saved);
				if (Object.keys(saved.sessions).length > 0) unavailable();
			}
		} catch (error) {
			if (error instanceof RuntimeHostError) throw error;
			stateInvalid();
		}
		return CodexRuntimeDriver.openWithBridge(
			options,
			CodexAppServerBridge.open,
		);
	}

	/** @internal */
	protected static async openWithBridge(
		options: CodexRuntimeDriverOptions,
		openBridge: OpenCodexBridge,
	) {
		let connectionClient: CodexRuntimeDriverOptions["connectionClient"];
		if (options.connectionClient !== undefined) {
			if (
				!isPlainRecord(options.connectionClient) ||
				!hasOnlyKeys(options.connectionClient, [
					"authorizedService",
					"profile",
					"resolveOriginalClient",
					"resolveReadOnlyClient",
				]) ||
				typeof options.connectionClient.resolveOriginalClient !== "function" ||
				(options.connectionClient.resolveReadOnlyClient !== undefined &&
					typeof options.connectionClient.resolveReadOnlyClient !== "function")
			)
				configurationInvalid();
			try {
				connectionClient = {
					authorizedService: structuredClone(
						options.connectionClient.authorizedService,
					),
					profile: validateCodexConnectionProfile(
						options.connectionClient.profile,
						options.connectionClient.authorizedService,
					),
					resolveOriginalClient: options.connectionClient.resolveOriginalClient,
					...(options.connectionClient.resolveReadOnlyClient
						? {
								resolveReadOnlyClient:
									options.connectionClient.resolveReadOnlyClient,
							}
						: {}),
				};
			} catch {
				configurationInvalid();
			}
		}
		const configuredCapabilities = {
			...capabilities,
			connection: connectionClient !== undefined,
		};
		const {
			configured: modelOptions,
			defaultSelection,
			routes,
		} = configuredModelOptions(options);
		const file = await CodexRuntimeDriver.openState(options.path);
		let driver: CodexRuntimeDriver | undefined;
		const modelTransport =
			routes.length > 0
				? await openCodexModelTransport(routes, {
						beforeRequest: (context, signal) => {
							if (!driver) unavailable();
							return driver.prepareModelRequest(context, signal);
						},
					})
				: undefined;
		const containedConfiguration = {
			model: defaultSelection.model,
			reasoningEffort: defaultSelection.effort,
			...(modelTransport
				? { modelAccess: { endpoint: modelTransport.endpoint } }
				: {}),
		};
		// Native storage stays a sibling of the Driver state on the Agent PVC; the
		// bridge owns the per-Conversation layout beneath it.
		const openConversationBridge = (conversationKey: string) =>
			openBridge({
				dataDirectory: `${options.path}.native`,
				conversationKey,
				...(options.launchPath === undefined
					? {}
					: { launchPath: options.launchPath }),
				model: defaultSelection.model,
				reasoningEffort: defaultSelection.effort,
				provenance: CODEX_APP_SERVER_V2_PROVENANCE,
				nativeBarrierRequired: true,
				nativeCallback: (request, signal) => {
					if (!driver) unavailable();
					return driver.handleNativeCallback(conversationKey, request, signal);
				},
				...(connectionClient
					? {
							connectionProfile: connectionClient.profile,
							authorizedConnectionService: connectionClient.authorizedService,
							nativeConnectionBootstrap: (request, signal) => {
								if (!driver) unavailable();
								return driver
									.connectionClient(conversationKey)
									.bootstrap(request, signal);
							},
						}
					: {}),
				...(modelTransport
					? {
							modelAccess: modelTransport.modelAccessFor(
								driver
									? driver.modelConversationKey(conversationKey)
									: conversationKey,
							),
						}
					: {}),
			});
		const assertContainedConfigurationFor = async (
			rpc: CodexRpc,
			expected: Parameters<typeof assertContainedConfiguration>[1],
		) => {
			await rpc.request("config/read", { includeLayers: false }, (value) => {
				assertContainedConfiguration(value, expected);
			});
			if (modelTransport) {
				await assertPinnedModelProfiles(rpc, modelOptions);
			}
		};
		const conversationContainedConfiguration = {
			...containedConfiguration,
			...(connectionClient
				? { connectionProfile: connectionClient.profile }
				: {}),
		};
		const assertContainedNativeConfiguration = (rpc: CodexRpc) =>
			assertContainedConfigurationFor(rpc, conversationContainedConfiguration);
		const probeNative = async (signal: AbortSignal) => {
			signal.throwIfAborted();
			// Dedicated temporary native HOME; never pass a real Conversation key or Store.
			const directory = await mkdtemp(
				join(dirname(options.path), ".readiness-"),
			);
			const probeKey = createHash("sha256").update(randomUUID()).digest("hex");
			let bridge: CodexAppServerTransport | undefined;
			let rpc: CodexRpc | undefined;
			const abort = () => {
				void (rpc ? rpc.close() : bridge?.close?.())?.catch(() => {});
			};
			signal.addEventListener("abort", abort, { once: true });
			try {
				signal.throwIfAborted();
				bridge = await openBridge({
					dataDirectory: directory,
					conversationKey: probeKey,
					...(options.launchPath ? { launchPath: options.launchPath } : {}),
					model: containedConfiguration.model,
					reasoningEffort: containedConfiguration.reasoningEffort,
					...(modelTransport
						? { modelAccess: modelTransport.modelAccessFor(probeKey) }
						: {}),
					provenance: CODEX_APP_SERVER_V2_PROVENANCE,
					// The business bridge always installs native callbacks.
					nativeBarrierRequired: true,
					startupTimeoutMs: 3000,
				});
				signal.throwIfAborted();
				rpc = new CodexRpc(bridge, async () => {});
				const deadline = Date.now() + 5000;
				await rpc.request(
					"initialize",
					{
						clientInfo: { name: "agent-infra-readiness", version: "1" },
						capabilities: { experimentalApi: true },
					},
					(value) => {
						if (!isPlainRecord(value)) protocolInvalid();
					},
					false,
					false,
					deadline,
				);
				signal.throwIfAborted();
				await assertContainedConfigurationFor(rpc, containedConfiguration);
				signal.throwIfAborted();
				return configuredCapabilities;
			} finally {
				signal.removeEventListener("abort", abort);
				try {
					if (rpc) await rpc.close();
					else await bridge?.close?.();
				} finally {
					modelTransport?.revokeConversationAccess(probeKey);
					await rm(directory, { recursive: true, force: true });
				}
			}
		};
		// `new this` keeps the transport-sharing policy in the class that needs it
		// instead of carrying a test-only flag through production state.
		try {
			driver = new this(
				file,
				openConversationBridge,
				assertContainedNativeConfiguration,
				modelOptions,
				defaultSelection,
				options.configVersion,
				modelTransport ? () => modelTransport.close() : undefined,
				modelTransport?.revokeConversationAccess,
				modelTransport
					? (deadline, model, threadId, reasoning, conversationKey) => {
							modelTransport.modelAccessFor(conversationKey);
							modelTransport.bindThread(conversationKey, threadId);
							return modelTransport.beginTurnAdmission(
								deadline,
								model,
								threadId,
								reasoning,
								conversationKey,
							);
						}
					: undefined,
				modelTransport?.recognizeTurn,
				modelTransport?.registerTurn,
				modelTransport?.waitForModelRequest,
				modelTransport?.abandonTurnAdmission,
				modelTransport?.cancelTurn,
				modelTransport?.revokeTurn,
				probeNative,
				options.authorizeExternalAction,
				connectionClient,
				runCodexConnectionRecovery,
				`${options.path}.native`,
				options.launchPath,
			);
		} catch (error) {
			await modelTransport?.close().catch(() => {});
			await file.close().catch(() => {});
			throw error;
		}
		try {
			await driver.recoverUnconfirmedModelOperations();
			return driver;
		} catch (error) {
			await driver.close().catch(() => {});
			throw error;
		}
	}

	private static async openState(path: string) {
		try {
			const file = await DurableJsonFile.open<CodexDriverState>(path, {
				schemaVersion: 1,
				sessions: {},
				operations: {},
			});
			await file.update((state) => {
				for (const operation of Object.values(state.operations)) {
					if (
						isPlainRecord(operation) &&
						operation.schemaVersion === undefined
					) {
						operation.schemaVersion = 1;
					}
				}
				assertDriverState(state);
			});
			return file;
		} catch (error) {
			if (error instanceof RuntimeHostError) throw error;
			stateInvalid();
		}
	}

	async execute(command: RuntimeDriverCommand) {
		const key = operationKey(command);
		const inFlight = this.inFlightOperations.get(key);
		if (inFlight) return inFlight;
		const execution =
			command.kind === "submit-turn"
				? this.executeSubmitTurn(command)
				: isCodexInterruptionCommand(command)
					? this.executeInterruption(command)
					: Promise.reject(unavailableError());
		this.inFlightOperations.set(key, execution);
		try {
			return await execution;
		} finally {
			if (this.inFlightOperations.get(key) === execution) {
				this.inFlightOperations.delete(key);
			}
		}
	}

	async validateExternalAction(action: RuntimeExternalActionAuthorization) {
		if (action.runtimeOperationId !== action.executionId)
			runtimeAuthorizationDenied();
		const state = this.readState();
		const session = ownRecordValue(state.sessions, action.nativeSessionRef);
		const execution =
			session && ownRecordValue(session.executions, action.executionId);
		const journal =
			execution &&
			Object.values(session.journals ?? {}).find(
				(value) => value.nativeTurnId === execution.nativeTurnId,
			);
		const facts: RuntimeOperationFactV2[] =
			journal?.events.flatMap((event) =>
				event.type === "operation" &&
				event.payload.operationRef === action.operationRef &&
				event.payload.attemptRef === action.attemptRef &&
				event.payload.kind === action.kind
					? [event.payload]
					: [],
			) ?? [];
		const fact = facts.at(-1);
		const phase = fact?.phase;
		const validSourceReserve =
			action.purpose === "source-reserve" &&
			(phase === "intent" || phase === "started");
		const validSourceBind =
			action.purpose === "source-bind" &&
			facts.some((value) => value.phase === "started") &&
			(phase === "intent" ||
				phase === "started" ||
				phase === "completed" ||
				phase === "failed");
		if (
			!fact ||
			(!validSourceReserve &&
				!validSourceBind &&
				phase !== "intent" &&
				phase !== "started")
		)
			runtimeAuthorizationDenied();
	}

	private async executeSubmitTurn(command: CodexSubmitTurnCommand) {
		if (command.input.attachments.length > 0) unavailable();
		if (command.operationId !== command.executionId) stateInvalid();
		const text = "text" in command.input ? command.input.text : undefined;
		if (!text) unavailable();
		const prepared = await this.prepare(command);
		if (prepared.operation.record) {
			if (
				prepared.operation.admissionPending ||
				prepared.operation.admissionRecoveryPending ||
				!this.canReplaySubmitOperation(prepared.operation)
			)
				unavailable();
			return prepared.operation.record;
		}
		if (!prepared.created) {
			return this.unknown(command, prepared.operation.nativeSessionRef);
		}
		const nativeSelection = this.operationSelection(prepared.operation);
		if (!nativeSelection) stateInvalid();
		const hasPersistedThread =
			this.session(prepared.operation.nativeSessionRef).threadId !== undefined;
		let session: CodexSession;
		try {
			session = await this.ensureThread(prepared.operation.nativeSessionRef);
		} catch (error) {
			if (hasPersistedThread) {
				await this.discardPreparedResume(
					command,
					prepared.operation.nativeSessionRef,
				);
			} else {
				await this.markAcceptanceUncertain(
					command,
					prepared.operation.nativeSessionRef,
				);
			}
			throw error;
		}
		if (
			session.activeExecutionId &&
			session.activeExecutionId !== command.executionId
		) {
			return this.resolve(command, session.nativeSessionRef, {
				outcome: "busy",
			});
		}
		if (!session.threadId) stateInvalid();
		const admissionKey = operationKey(command);
		const admissionDeadline = Date.now() + rpcRequestTimeoutMs;
		this.modelAdmissionDeadlines.set(admissionKey, admissionDeadline);
		if (!prepared.operation.internalModel) stateInvalid();
		const modelAdmission = this.beginModelTurnAdmission?.(
			admissionDeadline,
			prepared.operation.internalModel,
			session.threadId,
			nativeSelection.effort,
			this.modelConversationKey(codexConversationKey(session)),
		);
		if (modelAdmission)
			this.modelTurnAdmissions.set(admissionKey, modelAdmission);
		const abandonModelAdmission = () => {
			if (!modelAdmission) return;
			this.abandonModelTurnAdmission?.(modelAdmission);
			if (this.modelTurnAdmissions.get(admissionKey) === modelAdmission) {
				this.modelTurnAdmissions.delete(admissionKey);
			}
		};
		let candidateModelTurn: CodexModelTurn | undefined;
		let modelTurnAdmitted = false;
		try {
			const turn = await (await this.rpc(session.nativeSessionRef)).request(
				"turn/start",
				{
					threadId: session.threadId,
					clientUserMessageId: command.operationId,
					input: [{ type: "text", text }],
					...(nativeSelection ?? {}),
				},
				(value) => {
					const started = isPlainRecord(value) ? value.turn : undefined;
					if (
						!isPlainRecord(started) ||
						typeof started.id !== "string" ||
						started.id.length === 0
					) {
						protocolInvalid();
					}
					return {
						id: started.id,
						status: statusForTurn(started.status),
					};
				},
				command.schemaVersion === 2,
				false,
				admissionDeadline,
			);
			const nativeTurn = {
				conversationKey: this.modelConversationKey(
					codexConversationKey(session),
				),
				threadId: session.threadId,
				turnId: turn.id,
			};
			candidateModelTurn = nativeTurn;
			const record = await this.resolve(
				command,
				session.nativeSessionRef,
				{ outcome: "accepted", status: turn.status },
				turn.id,
				turn.status === "running",
			);
			if (
				record.result.outcome !== "accepted" ||
				record.result.status !== "running"
			) {
				abandonModelAdmission();
				await this.cancelModelTurn?.(nativeTurn);
				return record;
			}
			const recognized = await this.waitForNativeTurnStarted(
				nativeTurn.conversationKey,
				nativeTurn.threadId,
				nativeTurn.turnId,
				admissionDeadline,
			);
			if (!recognized) {
				const current = this.operationRecord(command);
				if (
					current?.record?.result.outcome === "accepted" &&
					current.record.result.status !== "running"
				) {
					abandonModelAdmission();
					await this.cancelModelTurn?.(nativeTurn);
					await this.confirmModelAdmission(command, session.nativeSessionRef);
					return current.record;
				}
				abandonModelAdmission();
				await this.cancelModelTurn?.(nativeTurn);
				unavailable();
			}
			await this.confirmModelAdmission(command, session.nativeSessionRef, true);
			let modelRequestReady: boolean | undefined;
			const registered =
				this.registerModelTurn === undefined
					? true
					: !!modelAdmission &&
						this.registerModelTurn(modelAdmission, nativeTurn);
			if (Date.now() >= admissionDeadline || !registered) {
				if (!registered && this.waitForModelRequest) {
					modelRequestReady = await this.waitForModelRequest(
						nativeTurn,
						admissionDeadline,
					);
					if (modelRequestReady) {
						modelTurnAdmitted = true;
						if (modelAdmission) this.modelTurnAdmissions.delete(admissionKey);
						await this.confirmModelAdmission(command, session.nativeSessionRef);
						this.initialModelStatusPending.add(
							this.nativeTurnKey(
								nativeTurn.conversationKey,
								nativeTurn.threadId,
								nativeTurn.turnId,
							),
						);
						return record;
					}
				}
				abandonModelAdmission();
				await this.cancelModelTurn?.(nativeTurn);
				const current = this.operationRecord(command);
				if (
					current?.record?.result.outcome === "accepted" &&
					current.record.result.status !== "running"
				) {
					await this.confirmModelAdmission(command, session.nativeSessionRef);
					return current.record;
				}
				unavailable();
			}
			modelTurnAdmitted = true;
			if (modelAdmission) this.modelTurnAdmissions.delete(admissionKey);
			await this.confirmModelAdmission(command, session.nativeSessionRef);
			// A successfully registered native turn has already crossed the durable
			// admission barrier. The first HTTP model request can arrive after this
			// method returns, so defer only the initial status read instead of blocking
			// acceptance on the provider request itself. The waiter above remains the
			// narrow recovery path for a registration race.
			if (this.waitForModelRequest) {
				this.initialModelStatusPending.add(
					this.nativeTurnKey(
						nativeTurn.conversationKey,
						nativeTurn.threadId,
						nativeTurn.turnId,
					),
				);
			}
			return record;
		} catch (error) {
			abandonModelAdmission();
			const pendingModelTurn = this.pendingModelTurn(
				command,
				session.nativeSessionRef,
			);
			const cancelledKeys = new Set<string>();
			for (const turn of [candidateModelTurn, pendingModelTurn]) {
				if (!turn) continue;
				const key = this.nativeTurnKey(
					turn.conversationKey,
					turn.threadId,
					turn.turnId,
				);
				if (cancelledKeys.has(key)) continue;
				cancelledKeys.add(key);
				await this.cancelModelTurn?.(turn);
			}
			if (
				error instanceof CodexModelSelectionRejectedError &&
				!pendingModelTurn
			) {
				return this.resolve(command, session.nativeSessionRef, {
					outcome: "rejected",
					code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
					message: "Runtime model selection is unsupported",
					retryable: false,
				});
			}
			if (modelTurnAdmitted || !this.hasPendingModelAdmission(command)) {
				const operation = this.operationRecord(command);
				if (
					operation?.state === "resolved" &&
					operation.record?.result.outcome === "accepted"
				) {
					await this.update((state) => {
						const current = ownRecordValue(state.operations, admissionKey);
						if (
							current?.state !== "resolved" ||
							current.record?.result.outcome !== "accepted"
						)
							stateInvalid();
						current.admissionRecoveryPending = true;
					});
				} else {
					await this.markAcceptanceUncertain(command, session.nativeSessionRef);
				}
			}
			throw error;
		} finally {
			abandonModelAdmission();
			if (
				this.modelAdmissionDeadlines.get(admissionKey) === admissionDeadline
			) {
				this.modelAdmissionDeadlines.delete(admissionKey);
			}
		}
	}

	private nativeSelection(selection: RuntimeSelectionV1) {
		const option = this.modelOptions.get(selection.modelOptionId);
		if (!option?.reasoningLevels.includes(selection.reasoningLevel)) {
			return undefined;
		}
		return { model: option.internalModel, effort: selection.reasoningLevel };
	}

	private async executeInterruption(command: CodexInterruptionCommand) {
		const prepared = await this.prepareInterruption(command);
		await this.drainConnectionRecoveries(
			command.nativeSessionRef,
			command.kind === "stop" ? command.executionId : undefined,
		);
		if (prepared.operation.record) return prepared.operation.record;
		if (!prepared.created) {
			return this.unknown(command, prepared.operation.nativeSessionRef);
		}
		const nativeTurn = this.interruptionNativeTurn(
			prepared.operation.nativeSessionRef,
			command,
		);
		// The committed stop seals every source in the original Execution before
		// native control. A root inference terminal does not end its descendants.
		const turns = this.executionNativeTurns(
			prepared.operation.nativeSessionRef,
			nativeTurn.turnId,
		);
		for (const turn of turns) this.revokeModelTurn?.(turn);
		try {
			let status: PersistedTurnStatus | "unknown";
			try {
				status = await this.getStatus(
					prepared.operation.nativeSessionRef,
					command.executionId,
				);
			} catch (error) {
				if (
					!(error instanceof RuntimeHostError) ||
					error.driverFailureKind !== "session_recovery_failed"
				) {
					throw error;
				}
				// Native history can be unreadable while its original live Thread
				// still accepts cancellation. Its control ACK is not a terminal proof.
				status = "unknown";
			}
			const results = await Promise.allSettled(
				turns.map(async (turn) => {
					const journal = this.session(prepared.operation.nativeSessionRef)
						.journals?.[nativeTurn.turnId];
					const source = Object.values(journal?.nativeSources ?? {}).find(
						(source) =>
							source.delivery === "started" &&
							!source.bindDenied &&
							source.source?.threadId === turn.threadId &&
							source.source.turnId === turn.turnId,
					);
					const inferenceComplete = source
						? source.terminal !== undefined
						: journal?.nativeCompletionStatus !== undefined;
					try {
						if (
							(status === "running" || status === "unknown") &&
							!inferenceComplete
						) {
							await (
								await this.rpc(prepared.operation.nativeSessionRef)
							).request(
								"turn/interrupt",
								{ threadId: turn.threadId, turnId: turn.turnId },
								(value) => {
									if (!isEmptyRecord(value)) protocolInvalid();
								},
							);
						}
					} finally {
						await this.terminateNativeBackgroundAttempts(
							prepared.operation.nativeSessionRef,
							turn,
							nativeTurn.turnId,
						);
					}
				}),
			);
			const rejected = results.find((result) => result.status === "rejected");
			if (rejected?.status === "rejected") throw rejected.reason;
		} finally {
			await Promise.all(turns.map((turn) => this.cancelModelTurn?.(turn)));
		}
		const status = await this.getStatus(
			prepared.operation.nativeSessionRef,
			command.executionId,
		);
		return this.resolveInterruption(
			command,
			prepared.operation.nativeSessionRef,
			status,
		);
	}

	private executionNativeTurns(
		nativeSessionRef: string,
		rootTurnId: string,
	): CodexModelTurn[] {
		const session = this.session(nativeSessionRef);
		if (!session.threadId) unavailable();
		const conversationKey = this.modelConversationKey(
			codexConversationKey(session),
		);
		return [
			{ conversationKey, threadId: session.threadId, turnId: rootTurnId },
			...Object.values(
				session.journals?.[rootTurnId]?.nativeSources ?? {},
			).flatMap((source) =>
				source.bind &&
				!source.bindDenied &&
				source.delivery === "started" &&
				source.source
					? [{ ...source.source, conversationKey }]
					: [],
			),
		];
	}

	private async terminateNativeBackgroundAttempts(
		nativeSessionRef: string,
		turn: CodexNativeTurn,
		rootTurnId = turn.turnId,
	) {
		const journal = this.session(nativeSessionRef).journals?.[rootTurnId];
		const calls = new Set(
			pendingNativeToolAttempts(journal)
				.filter(
					(attempt) =>
						attempt.permitId &&
						attempt.identity.sessionId === turn.threadId &&
						attempt.identity.turnId === turn.turnId,
				)
				.map((attempt) => attempt.identity.callId),
		);
		if (calls.size === 0) return;
		const rpc = await this.rpc(nativeSessionRef);
		const processes = new Set<string>();
		const cursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < maximumItemsListPages; page++) {
			const result = await rpc.request(
				"thread/backgroundTerminals/list",
				{
					threadId: turn.threadId,
					limit: itemsListPageSize,
					...(cursor ? { cursor } : {}),
				},
				(value) => {
					if (
						!isPlainRecord(value) ||
						!Array.isArray(value.data) ||
						(value.nextCursor !== null &&
							value.nextCursor !== undefined &&
							!nonEmptyString(value.nextCursor))
					)
						protocolInvalid();
					const ids: string[] = [];
					for (const item of value.data) {
						if (
							!isPlainRecord(item) ||
							!nonEmptyString(item.itemId) ||
							!nonEmptyString(item.processId)
						)
							protocolInvalid();
						if (calls.has(item.itemId)) ids.push(item.processId);
					}
					return {
						ids,
						nextCursor:
							typeof value.nextCursor === "string"
								? value.nextCursor
								: undefined,
					};
				},
			);
			for (const id of result.ids) processes.add(id);
			if (!result.nextCursor) break;
			if (cursors.has(result.nextCursor) || page === maximumItemsListPages - 1)
				protocolInvalid();
			cursors.add(result.nextCursor);
			cursor = result.nextCursor;
		}
		for (const processId of processes) {
			await rpc.request(
				"thread/backgroundTerminals/terminate",
				{ threadId: turn.threadId, processId },
				(value) => {
					if (
						!isPlainRecord(value) ||
						!hasOnlyKeys(value, ["terminated"]) ||
						typeof value.terminated !== "boolean"
					)
						protocolInvalid();
				},
			);
		}
		// RPC acknowledgements only request termination. The original native
		// attempt watcher must durably report its outcome before releasing a slot.
	}

	async lookupOperation(
		command: RuntimeDriverCommand,
	): Promise<RuntimeDriverLookup> {
		const operation = ownRecordValue(
			this.readState().operations,
			operationKey(command),
		);
		if (!operation) return { state: "missing" };
		if (!operationMatchesCommand(operation, command))
			return { state: "unknown" };
		if (operation.admissionPending || operation.admissionRecoveryPending)
			return { state: "unknown" };
		// Reading a durable acceptance receipt does not readmit its model route.
		// execute() and native recovery retain their own configuration checks.
		if (operation.record) {
			if (
				command.kind === "generation-cancel" &&
				operation.record.result.outcome === "accepted" &&
				operation.record.result.status === "running"
			) {
				await this.getStatus(operation.nativeSessionRef, command.executionId);
				const current = ownRecordValue(
					this.readState().operations,
					operationKey(command),
				);
				if (!current?.record) stateInvalid();
				return { state: "found", record: current.record };
			}
			return { state: "found", record: operation.record };
		}
		if (!isCodexInterruptionCommand(command)) return { state: "unknown" };
		const rootTurn = this.interruptionNativeTurn(
			operation.nativeSessionRef,
			command,
		);
		const turns = this.executionNativeTurns(
			operation.nativeSessionRef,
			rootTurn.turnId,
		);
		for (const turn of turns) this.revokeModelTurn?.(turn);
		const status = await this.getStatus(
			operation.nativeSessionRef,
			command.executionId,
		);
		if (status === "running") return { state: "unknown" };
		await Promise.all(turns.map((turn) => this.cancelModelTurn?.(turn)));
		return {
			state: "found",
			record: await this.resolveInterruption(
				command,
				operation.nativeSessionRef,
				status,
			),
		};
	}

	async getStatus(nativeSessionRef: string, executionId: string) {
		const status = await this.restoreExecutionStatus(
			nativeSessionRef,
			executionId,
		);
		if (status !== "running") {
			const state = this.readState();
			const hasRunningCancellation = Object.values(state.operations).some(
				(operation) =>
					operation.nativeSessionRef === nativeSessionRef &&
					operation.executionId === executionId &&
					operation.record?.kind === "generation-cancel" &&
					operation.record.result.outcome === "accepted" &&
					operation.record.result.status === "running",
			);
			if (hasRunningCancellation) {
				const session = this.session(nativeSessionRef);
				const execution = ownRecordValue(session.executions, executionId);
				if (!execution) unavailable();
				await Promise.all(
					this.executionNativeTurns(
						nativeSessionRef,
						execution.nativeTurnId,
					).map((turn) => this.cancelModelTurn?.(turn)),
				);
				await this.update((current) => {
					for (const operation of Object.values(current.operations)) {
						const record = operation.record;
						if (
							operation.nativeSessionRef === nativeSessionRef &&
							operation.executionId === executionId &&
							record?.kind === "generation-cancel" &&
							record.result.outcome === "accepted" &&
							record.result.status === "running"
						)
							record.result = { outcome: "accepted", status };
					}
				});
				this.notifyEventStream(
					this.eventStreamKey(nativeSessionRef, executionId),
				);
			}
		}
		return status;
	}

	private async restoreExecutionStatus(
		nativeSessionRef: string,
		executionId: string,
		recoverEventHistory = false,
	) {
		const initialState = this.readState();
		let session = ownRecordValue(initialState.sessions, nativeSessionRef);
		if (!session) unavailable();
		let execution = ownRecordValue(session.executions, executionId);
		if (!execution || !session.threadId) unavailable();
		this.assertModelAdmissionConfirmed(session, execution);
		const journal = session.journals?.[execution.nativeTurnId];
		const latestFact = journal
			? latestModelOperationAttemptFact(journal.events)
			: undefined;
		const initialStatusKey = this.nativeTurnKey(
			this.modelConversationKey(codexConversationKey(session)),
			session.threadId,
			execution.nativeTurnId,
		);
		const deferInitialStatus =
			this.initialModelStatusPending.has(initialStatusKey);
		// The initial status lookup can race the response body of a live model
		// stream. Its durable intent/started fact already proves that this execution
		// is accepted; defer native resume until the stream records its outcome.
		if (
			deferInitialStatus &&
			execution.status === "running" &&
			latestFact?.kind === "model" &&
			(latestFact.phase === "intent" || latestFact.phase === "started")
		) {
			// This is a one-shot race guard. A later status read must not defer
			// forever when the native side never publishes a terminal update.
			this.initialModelStatusPending.delete(initialStatusKey);
			return "running";
		}
		this.initialModelStatusPending.delete(initialStatusKey);
		// A provider HTTP failure is durably recorded by the model transport before
		// it closes the native request. The native app-server may leave its Turn in
		// `running` while processing that rejected response, so status recovery must
		// finish from the committed failure fact instead of treating the native
		// status read as an invalid Driver response.
		if (
			execution.status === "running" &&
			journal?.externalActionsBlocked &&
			latestFact?.kind === "model" &&
			(latestFact.phase === "failed" ||
				(latestFact.phase === "unknown" &&
					latestFact.failureCode === "response_incomplete"))
		) {
			const nativeTurn = {
				conversationKey: this.modelConversationKey(
					codexConversationKey(session),
				),
				threadId: session.threadId,
				turnId: execution.nativeTurnId,
			};
			if (this.cancelModelTurn)
				await this.cancelModelTurn(nativeTurn).catch(() => undefined);
			return this.updateExecutionStatus(
				nativeSessionRef,
				executionId,
				execution.nativeTurnId,
				"failed",
				false,
			);
		}
		if (execution.status !== "running") {
			if (
				!this.executionConfigurationMatches(initialState, session, execution)
			) {
				return execution.status;
			}
			await this.cancelModelTurn?.({
				conversationKey: this.modelConversationKey(
					codexConversationKey(session),
				),
				threadId: session.threadId,
				turnId: execution.nativeTurnId,
			});
			return execution.status;
		}
		this.assertOriginalRecoveryConfiguration(initialState, session, execution);
		const nativeTurn = {
			conversationKey: this.modelConversationKey(codexConversationKey(session)),
			threadId: session.threadId,
			turnId: execution.nativeTurnId,
		};
		const restoreRequired =
			!session.journals?.[execution.nativeTurnId]?.externalActionsBlocked &&
			!session.journals?.[execution.nativeTurnId]?.nativeCompletionStatus &&
			!this.hasInterruption(nativeSessionRef, executionId) &&
			this.beginModelTurnAdmission !== undefined &&
			this.recognizeModelTurn !== undefined &&
			this.registerModelTurn !== undefined;
		let restoreAdmission: CodexModelTurnAdmission | undefined;
		if (restoreRequired) {
			const selection = this.operationSelection(
				this.executionOperation(initialState, session, execution),
			);
			if (!selection) unavailable();
			restoreAdmission = this.beginModelTurnAdmission?.(
				Date.now() + rpcRequestTimeoutMs,
				selection.model,
				nativeTurn.threadId,
				selection.effort,
				this.modelConversationKey(codexConversationKey(session)),
			);
			if (
				restoreAdmission &&
				this.recognizeModelTurn?.(restoreAdmission, nativeTurn) === false
			) {
				this.abandonModelTurnAdmission?.(restoreAdmission);
				restoreAdmission = undefined;
			}
		}
		try {
			await this.resumeSession(nativeSessionRef);
			session = this.session(nativeSessionRef);
			execution = ownRecordValue(session.executions, executionId);
			if (!execution || !session.threadId) unavailable();
			this.assertModelAdmissionConfirmed(session, execution);
			if (execution.status !== "running") {
				await this.cancelModelTurn?.({
					conversationKey: this.modelConversationKey(
						codexConversationKey(session),
					),
					threadId: session.threadId,
					turnId: execution.nativeTurnId,
				});
				if (recoverEventHistory) {
					const items = await this.readNativeAgentMessageItems(
						nativeSessionRef,
						session.threadId,
						execution.nativeTurnId,
					);
					await this.persistRecoveredAgentMessageItems(
						nativeSessionRef,
						executionId,
						execution.nativeTurnId,
						items,
					);
				}
				return execution.status;
			}
			if (
				session.threadId !== nativeTurn.threadId ||
				execution.nativeTurnId !== nativeTurn.turnId
			) {
				stateInvalid();
			}
			const status = await this.readNativeTurnStatus(session, execution);
			if (recoverEventHistory) {
				const items = await this.readNativeAgentMessageItems(
					nativeSessionRef,
					session.threadId,
					execution.nativeTurnId,
				);
				await this.persistRecoveredAgentMessageItems(
					nativeSessionRef,
					executionId,
					execution.nativeTurnId,
					items,
				);
			}
			const persistedStatus = await this.updateExecutionStatus(
				nativeSessionRef,
				executionId,
				execution.nativeTurnId,
				status,
			);
			if (persistedStatus !== "running") {
				await this.cancelModelTurn?.(nativeTurn);
			} else if (
				!this.session(nativeSessionRef).journals?.[execution.nativeTurnId]
					?.nativeCompletionStatus &&
				restoreRequired &&
				(!restoreAdmission ||
					this.hasInterruption(nativeSessionRef, executionId) ||
					this.registerModelTurn?.(restoreAdmission, nativeTurn) !== true)
			) {
				unavailable();
			}
			return persistedStatus;
		} catch (error) {
			// Only an acknowledged failure to restore an existing Turn initiates
			// generation isolation. Transport loss and pre-Turn retries stay uncertain.
			if (error instanceof CodexSessionUnavailableError) {
				throw new RuntimeHostError(
					"RUNTIME_SESSION_RECOVERY_FAILED",
					"Runtime Session recovery failed",
					503,
					false,
					"session_recovery_failed",
				);
			}
			throw error;
		} finally {
			if (restoreAdmission) {
				this.abandonModelTurnAdmission?.(restoreAdmission);
			}
		}
	}

	async getCapabilities() {
		return {
			...capabilities,
			connection: this.connectionClientOptions !== undefined,
		};
	}

	async probeReadiness(signal: AbortSignal) {
		if (this.closed || !this.probeNative) unavailable();
		return this.probeNative(signal);
	}

	async replayEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
	): Promise<RuntimeEvent[]> {
		const existingSession = this.session(nativeSessionRef);
		const existingExecution = ownRecordValue(
			existingSession.executions,
			executionId,
		);
		if (!existingExecution) unavailable();
		this.assertModelAdmissionConfirmed(existingSession, existingExecution);
		// Committed facts remain readable without reopening the old native route.
		// Sealed executions replay their journal before independent status recovery.
		if (
			!existingSession.journals?.[existingExecution.nativeTurnId]
				?.externalActionsBlocked &&
			!this.hasInterruption(nativeSessionRef, executionId) &&
			this.executionConfigurationMatches(
				this.readState(),
				existingSession,
				existingExecution,
			)
		)
			await this.recoverEventHistory(nativeSessionRef, executionId);
		const session = this.session(nativeSessionRef);
		const execution = ownRecordValue(session.executions, executionId);
		if (!execution) unavailable();
		this.assertModelAdmissionConfirmed(session, execution);
		const journal = ownRecordValue(
			session.journals ?? {},
			execution.nativeTurnId,
		);
		if (!journal) return [];
		let events = journal.events;
		if (afterCursor !== undefined) {
			const index = events.findIndex((event) => event.cursor === afterCursor);
			if (index === -1) unavailable();
			events = events.slice(index + 1);
		}
		return events.map((event) => this.runtimeEvent(executionId, event));
	}

	async acknowledgeEvents(
		nativeSessionRef: string,
		executionId: string,
		throughCursor: string,
	) {
		await this.update((state) => {
			const session = ownRecordValue(state.sessions, nativeSessionRef);
			const execution =
				session && ownRecordValue(session.executions, executionId);
			const journal =
				session &&
				execution &&
				ownRecordValue(session.journals ?? {}, execution.nativeTurnId);
			if (!journal) unavailable();
			const index = journal.events.findIndex(
				(event) => event.cursor === throughCursor,
			);
			if (index < 0) unavailable();
			const previous =
				journal.acknowledgedCursor === undefined
					? -1
					: journal.events.findIndex(
							(event) => event.cursor === journal.acknowledgedCursor,
						);
			if (index > previous) journal.acknowledgedCursor = throughCursor;
			// Keep all records in this version. Existing afterCursor replay must
			// remain exact even for cursors older than the confirmed watermark.
		});
	}

	async subscribeEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
		signal?: AbortSignal,
	): Promise<AsyncIterable<RuntimeEvent>> {
		const driver = this;
		const key = this.eventStreamKey(nativeSessionRef, executionId);
		const initialWaiter = this.waitForEvent(key, signal);
		let initialEvents: RuntimeEvent[];
		try {
			initialEvents = await this.replayEvents(
				nativeSessionRef,
				executionId,
				afterCursor,
			);
		} catch (error) {
			initialWaiter.cancel();
			throw error;
		}
		return (async function* () {
			let cursor = afterCursor;
			let pending = initialEvents;
			let waiter = initialWaiter;
			let hasInitialReplay = true;
			while (!signal?.aborted) {
				if (!hasInitialReplay) {
					waiter = driver.waitForEvent(key, signal);
				}
				try {
					if (!hasInitialReplay) {
						pending = await driver.replayEvents(
							nativeSessionRef,
							executionId,
							cursor,
						);
					}
					hasInitialReplay = false;
					if (pending.length > 0) {
						for (const event of pending) {
							if (signal?.aborted) return;
							cursor = event.cursor;
							yield event;
							// A terminal stream may close while an unverified Connection fact
							// remains. Explicit recovery can append its metadata later.
						}
						pending = [];
					}
					if (
						(driver.isExecutionTerminal(nativeSessionRef, executionId) ||
							driver.hasConfirmedGenerationCancellation(
								nativeSessionRef,
								executionId,
							)) &&
						!waiter.wasNotified()
					) {
						return;
					}
					await waiter.promise;
				} finally {
					waiter.cancel();
				}
			}
		})();
	}

	// Concurrent or repeated shutdown joins the first one, so the model transport
	// is closed exactly once and no caller returns before shutdown finished.
	async close() {
		this.closing ??= this.shutdown();
		await this.closing;
	}

	private async shutdown() {
		this.closed = true;
		this.initialModelStatusPending.clear();
		await this.drainConnectionRecoveries();
		for (const client of this.connectionClients.values()) client.close();
		this.connectionClients.clear();
		await this.drainNativeCallbacks();
		const opening = [...this.inFlightConversationRpcs.values()];
		this.inFlightConversationRpcs.clear();
		await Promise.allSettled(opening);
		const rpcs = new Set([
			...this.conversationRpcs.values(),
			...[...this.rpcsByTransport.values()].map(({ rpc }) => rpc),
		]);
		this.conversationRpcs.clear();
		this.rpcsByTransport.clear();
		const results = await Promise.allSettled([
			...[...rpcs].map((rpc) => rpc.close()),
			...(this.closeModelTransport ? [this.closeModelTransport()] : []),
		]);
		try {
			await this.file.readCommitted();
		} finally {
			await this.file.close();
		}
		const rejected = results.find((result) => result.status === "rejected");
		if (rejected?.status === "rejected") throw rejected.reason;
	}

	private readState() {
		const state = this.file.read();
		assertDriverState(state);
		return state;
	}

	private assertModelAdmissionConfirmed(
		session: CodexSession,
		execution: CodexExecution,
	) {
		const operation = ownRecordValue(
			this.readState().operations,
			operationKey({
				agentId: session.agentId,
				conversationId: session.conversationId,
				sessionGeneration: session.sessionGeneration,
				kind: "submit-turn",
				operationId: execution.executionId,
			}),
		);
		if (operation?.admissionPending || operation?.admissionRecoveryPending)
			unavailable();
	}

	private executionOperation(
		state: CodexDriverState,
		session: CodexSession,
		execution: CodexExecution,
	) {
		const operation = ownRecordValue(
			state.operations,
			operationKey({
				agentId: session.agentId,
				conversationId: session.conversationId,
				sessionGeneration: session.sessionGeneration,
				kind: "submit-turn",
				operationId: execution.executionId,
			}),
		);
		if (!operation) stateInvalid();
		return operation;
	}

	private executionConfigurationMatches(
		state: CodexDriverState,
		session: CodexSession,
		execution: CodexExecution,
	) {
		const operation = this.executionOperation(state, session, execution);
		return (
			operation.configVersion === this.configVersion &&
			this.operationSelection(operation) !== undefined
		);
	}

	private assertExecutionConfiguration(
		state: CodexDriverState,
		session: CodexSession,
		execution: CodexExecution,
	) {
		if (!this.executionConfigurationMatches(state, session, execution)) {
			unavailable();
		}
	}

	private assertOriginalRecoveryConfiguration(
		state: CodexDriverState,
		session: CodexSession,
		execution: CodexExecution,
	) {
		if (this.executionConfigurationMatches(state, session, execution)) return;
		const operation = this.executionOperation(state, session, execution);
		const journal = session.journals?.[execution.nativeTurnId];
		// A durable source barrier permits only original status/control RPCs.
		// restoreExecutionStatus never registers admission for this sealed Turn.
		if (
			!operation.configVersion ||
			!operation.internalModel ||
			!operation.reasoningLevel ||
			operation.admissionPending ||
			operation.admissionRecoveryPending ||
			operation.record?.result.outcome !== "accepted" ||
			!journal ||
			(!journal.externalActionsBlocked &&
				!this.hasInterruption(
					session.nativeSessionRef,
					execution.executionId,
					state,
				))
		)
			unavailable();
	}

	private update<R>(change: (state: CodexDriverState) => R) {
		return this.file.update((state) => {
			assertDriverState(state);
			const result = change(state);
			assertDriverState(state);
			return result;
		});
	}

	private handleNativeCallback(
		conversationKey: string,
		request: CodexNativeCallbackRequest,
		signal: AbortSignal,
	): Promise<CodexNativeCallbackResponse> {
		if (this.closed)
			return Promise.reject(new Error("CODEX_NATIVE_CALLBACK_UNAVAILABLE"));
		const abort = new AbortController();
		const callback = {
			conversationKey,
			identity:
				"identity" in request ? request.identity : request.reservation.parent,
			abort,
			finished:
				"identity" in request
					? this.performNativeOperationOrEvidence(
							conversationKey,
							request,
							AbortSignal.any([
								signal,
								abort.signal,
								AbortSignal.timeout(4_500),
							]),
						)
					: this.performNativeSourceCallback(
							conversationKey,
							request,
							AbortSignal.any([
								signal,
								abort.signal,
								AbortSignal.timeout(4_500),
							]),
						),
		};
		this.nativeCallbacks.add(callback);
		return callback.finished.finally(() =>
			this.nativeCallbacks.delete(callback),
		);
	}

	private async drainNativeCallbacks(turn?: {
		conversationKey?: string;
		threadId: string;
		turnId: string;
	}) {
		const callbacks = [...this.nativeCallbacks].filter(
			(callback) =>
				!turn ||
				((turn.conversationKey === undefined ||
					callback.conversationKey === turn.conversationKey) &&
					callback.identity.sessionId === turn.threadId &&
					callback.identity.turnId === turn.turnId),
		);
		for (const callback of callbacks) callback.abort.abort();
		await Promise.allSettled(callbacks.map((callback) => callback.finished));
	}

	private performNativeOperationOrEvidence(
		conversationKey: string,
		request:
			| CodexNativeOperationRequestV1
			| CodexConnectionOperationRequest
			| CodexConnectionEvidenceUpdateRequest,
		signal: AbortSignal,
	): Promise<CodexNativeCallbackResponse> {
		return request.phase === "connection-evidence"
			? this.performNativeConnectionEvidence(conversationKey, request, signal)
			: this.performNativeCallback(conversationKey, request, signal);
	}

	private assertConnectionDispatch(
		conversationKey: string,
		descriptor: CodexConnectionRequest,
		session: CodexSession,
		execution: CodexExecution,
	) {
		const previous = this.connectionAdmission;
		this.connectionAdmission = { conversationKey, request: descriptor };
		try {
			const client = this.connectionClient(conversationKey);
			const binding = client.assertRequest(descriptor);
			if (
				binding.scope.agentId !== session.agentId ||
				binding.scope.conversationId !== session.conversationId ||
				binding.scope.sessionGeneration !== session.sessionGeneration ||
				binding.scope.executionId !== execution.executionId
			)
				unavailable();
			return client.snapshotOriginal(descriptor);
		} finally {
			this.connectionAdmission = previous;
		}
	}

	private async performNativeConnectionEvidence(
		conversationKey: string,
		request: CodexConnectionEvidenceUpdateRequest,
		signal: AbortSignal,
		recovery?: {
			read: RuntimeOriginalEvidenceReadContext;
			original: CodexConnectionRecoveryOriginal;
			queryClient: CodexConnectionQueryMetadata;
		},
	): Promise<CodexConnectionEvidenceUpdateResponse> {
		if (
			!isCodexConnectionRequest(request.connectionRequest) ||
			request.connectionRequest.toolName !== "execute_action" ||
			request.identity.toolName !== "connection/execute_action" ||
			!isCodexConnectionEvidence(request.connectionEvidence)
		)
			protocolInvalid();
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify(
					[
						request.phase,
						request.occurredAt,
						request.permitId,
						request.connectionRequest,
						request.connectionEvidence,
					],
					canonicalCallbackValue,
				),
			)
			.digest("hex");
		const write = (checkAbort = true) =>
			this.update((state) => {
				if (checkAbort) signal.throwIfAborted();
				if (this.closed) unavailable();
				const resolved = this.resolveNativeSourceJournal(
					state,
					conversationKey,
					request.identity.sessionId,
					request.identity.turnId,
				);
				if (!resolved?.execution) unavailable();
				const { session, journal, execution, nativeSessionRef } = resolved;
				const attempt = ownRecordValue(
					journal.nativeToolAttempts ?? {},
					request.identity.attemptRef,
				);
				if (
					!attempt?.permitId ||
					attempt.permitId !== request.permitId ||
					!attempt.outcomeRequestId ||
					attempt.denied ||
					!sameCodexNativeAttemptV1(attempt.identity, request.identity) ||
					!isDeepStrictEqual(
						attempt.connectionRequest,
						request.connectionRequest,
					)
				)
					protocolInvalid();
				const receipts = attempt.connectionEvidenceUpdates ?? [];
				const replay = receipts.find(
					(receipt) => receipt.requestId === request.requestId,
				);
				if (replay) {
					if (replay.fingerprint !== fingerprint) protocolInvalid();
					return { nativeSessionRef, executionId: execution.executionId };
				}
				if (
					[
						attempt.intentRequestId,
						attempt.startedRequestId,
						attempt.outcomeRequestId,
						...receipts.map((receipt) => receipt.requestId),
					].includes(request.requestId)
				)
					protocolInvalid();
				if (
					this.connectionRecoveryClosed(
						state,
						nativeSessionRef,
						execution.executionId,
					)
				)
					unavailable();
				if (recovery) {
					const binding = checkAbort
						? recovery.read.assertCurrent()
						: recovery.original.connectionOrigin.originalBinding;
					if (
						!isDeepStrictEqual(
							binding,
							recovery.original.connectionOrigin.originalBinding,
						) ||
						!isDeepStrictEqual(
							attempt.connectionOrigin,
							recovery.original.connectionOrigin,
						) ||
						!isDeepStrictEqual(
							attempt.connectionEvidence?.originalResponse,
							recovery.original.originalResponse,
						)
					)
						protocolInvalid();
				}
				const fact = latestOperationAttemptFacts(journal.events).find(
					(fact) => operationAttemptKey(fact) === operationAttemptKey(attempt),
				);
				if (
					fact?.kind !== "tool" ||
					(fact.phase !== "completed" &&
						fact.phase !== "failed" &&
						fact.phase !== "unknown")
				)
					protocolInvalid();
				const previous = this.readOnlyQueryAdmission;
				if (recovery) {
					this.readOnlyQueryAdmission = {
						conversationKey,
						request: request.connectionRequest,
						origin: recovery.original.connectionOrigin,
						metadata: recovery.queryClient,
					};
				}
				let association: RuntimeConnectionAssociationV1 | undefined;
				try {
					association = this.connectionClient(conversationKey).associate({
						requestDescriptor: request.connectionRequest,
						evidence: request.connectionEvidence,
						previousEvidence: attempt.connectionEvidence,
						metadataOnly: true,
						occurredAt: request.occurredAt,
						...(recovery
							? {
									origin: recovery.original.connectionOrigin,
								}
							: {}),
					});
				} finally {
					this.readOnlyQueryAdmission = previous;
				}
				if (!association) protocolInvalid();
				if (!isDeepStrictEqual(fact.connection, association))
					this.appendOperationFact(
						session,
						journal,
						{ ...fact, connection: association },
						true,
					);
				attempt.connectionEvidence = structuredClone(
					request.connectionEvidence,
				);
				attempt.connectionEvidenceUpdates ??= [];
				attempt.connectionEvidenceUpdates.push({
					requestId: request.requestId,
					fingerprint,
				});
				return { nativeSessionRef, executionId: execution.executionId };
			});
		let saved: Awaited<ReturnType<typeof write>>;
		if (recovery) {
			// Once Host ordering has admitted this callback, finish the durable
			// evidence commit even if generation cancellation aborts the recovery.
			// A pre-commit abort still prevents the callback from entering write.
			signal.throwIfAborted();
			recovery.read.assertCurrent();
			saved = await recovery.read.commit(() => write(false));
		} else {
			saved = await write();
		}
		this.notifyEventStream(
			this.eventStreamKey(saved.nativeSessionRef, saved.executionId),
		);
		return {
			schemaVersion: 2,
			requestId: request.requestId,
			phase: "connection-evidence",
			identity: request.identity,
			connectionRequest: request.connectionRequest,
			decision: "ack",
		};
	}

	private async performNativeCallback(
		conversationKey: string,
		request: CodexNativeOperationRequestV1 | CodexConnectionOperationRequest,
		signal: AbortSignal,
	): Promise<
		CodexNativeOperationResponseV1 | CodexConnectionOperationResponse
	> {
		const binding =
			request.schemaVersion === 2
				? {
						schemaVersion: 2 as const,
						requestId: request.requestId,
						identity: request.identity,
						connectionRequest: request.connectionRequest,
					}
				: {
						schemaVersion: 1 as const,
						requestId: request.requestId,
						identity: request.identity,
					};
		const descriptor =
			request.schemaVersion === 2 ? request.connectionRequest : undefined;
		if (
			descriptor
				? !isCodexConnectionRequest(descriptor) ||
					request.identity.toolName !== `connection/${descriptor.toolName}`
				: /^(connection\/|mcp__connection__)/.test(request.identity.toolName)
		)
			protocolInvalid();
		if (
			"connectionEvidence" in request &&
			!isCodexConnectionEvidence(request.connectionEvidence)
		)
			protocolInvalid();
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify(
					[
						request.phase,
						request.occurredAt,
						request.phase === "intent" ? null : request.permitId,
						request.phase === "outcome" ? request.outcome : null,
						"reason" in request ? (request.reason ?? null) : null,
						...(descriptor
							? [
									descriptor,
									"connectionEvidence" in request
										? request.connectionEvidence
										: null,
								]
							: []),
					],
					canonicalCallbackValue,
				),
			)
			.digest("hex");
		const locate = (state: CodexDriverState) => {
			const resolved = this.resolveNativeSourceJournal(
				state,
				conversationKey,
				request.identity.sessionId,
				request.identity.turnId,
			);
			if (!resolved?.execution) unavailable();
			const { journal } = resolved;
			const attempt = ownRecordValue(
				journal.nativeToolAttempts ?? {},
				request.identity.attemptRef,
			);
			if (
				attempt &&
				(!sameCodexNativeAttemptV1(attempt.identity, request.identity) ||
					!isDeepStrictEqual(attempt.connectionRequest, descriptor))
			)
				protocolInvalid();
			for (const other of Object.values(
				resolved.session.journals ?? {},
			).flatMap((journal) => Object.values(journal.nativeToolAttempts ?? {}))) {
				if (
					other !== attempt &&
					descriptor &&
					other.connectionRequest &&
					(other.connectionRequest.operationNonce ===
						descriptor.operationNonce ||
						other.connectionRequest.attemptNonce === descriptor.attemptNonce)
				)
					protocolInvalid();
				if (
					other !== attempt &&
					[
						other.intentRequestId,
						other.startedRequestId,
						other.outcomeRequestId,
						...(other.connectionEvidenceUpdates ?? []).map(
							(receipt) => receipt.requestId,
						),
					].includes(request.requestId)
				)
					protocolInvalid();
			}
			return { ...resolved, execution: resolved.execution, attempt };
		};
		const notify = (nativeSessionRef: string, executionId: string) =>
			this.notifyEventStream(
				this.eventStreamKey(nativeSessionRef, executionId),
			);
		signal.throwIfAborted();
		if (request.phase === "intent") {
			const prepared = await this.update((state) => {
				signal.throwIfAborted();
				if (this.closed) unavailable();
				const resolved = locate(state);
				const { session, journal, execution } = resolved;
				if (resolved.attempt?.denied) {
					if (
						resolved.attempt.intentRequestId !== request.requestId ||
						resolved.attempt.intentFingerprint !== fingerprint
					)
						protocolInvalid();
					return { ...resolved, attempt: resolved.attempt, existing: true };
				}
				const connectionOrigin = descriptor
					? this.assertConnectionDispatch(
							conversationKey,
							descriptor,
							session,
							execution,
						)
					: undefined;
				this.assertJournalOpen(journal);
				if (
					journal.externalActionsBlocked ||
					(resolved.sourceRecord
						? resolved.sourceRecord.terminal !== undefined
						: journal.nativeCompletionStatus !== undefined) ||
					this.hasInterruption(
						resolved.nativeSessionRef,
						execution.executionId,
						state,
					) ||
					session.activeExecutionId !== execution.executionId ||
					execution.status !== "running"
				)
					unavailable();
				const operation = this.executionOperation(state, session, execution);
				if (operation.admissionPending || operation.admissionRecoveryPending)
					unavailable();
				this.assertExecutionConfiguration(state, session, execution);
				if (resolved.attempt) {
					if (
						resolved.attempt.intentRequestId !== request.requestId ||
						resolved.attempt.intentFingerprint !== fingerprint
					)
						protocolInvalid();
					const fact = latestOperationAttemptFacts(journal.events).find(
						(fact) =>
							fact.operationRef === resolved.attempt?.operationRef &&
							fact.attemptRef === resolved.attempt?.attemptRef,
					);
					if (
						resolved.attempt.startedRequestId ||
						resolved.attempt.outcomeRequestId ||
						fact?.phase !== "intent"
					)
						unavailable();
					return { ...resolved, attempt: resolved.attempt, existing: true };
				}
				const parent = request.identity.parentAttemptRef
					? ownRecordValue(
							journal.nativeToolAttempts ?? {},
							request.identity.parentAttemptRef,
						)
					: undefined;
				if (
					request.identity.parentAttemptRef &&
					(!parent?.permitId ||
						!parent.startedRequestId ||
						parent.outcomeRequestId)
				)
					protocolInvalid();
				const previousAttempts = Object.values(
					journal.nativeToolAttempts ?? {},
				).filter((attempt) =>
					sameNativeToolOperation(attempt, {
						identity: request.identity,
						connectionRequest: descriptor,
					}),
				);
				const operationRefs = new Set(
					previousAttempts.map((attempt) => attempt.operationRef),
				);
				// Older journals can contain split references for one call. Keep their
				// receipts readable, but never guess which operation a new retry owns.
				if (operationRefs.size > 1) unavailable();
				const latest = latestOperationAttemptFacts(journal.events);
				for (const previous of previousAttempts) {
					const fact = latest.find(
						(fact) =>
							operationAttemptKey(fact) === operationAttemptKey(previous),
					);
					if (
						!previous.outcomeRequestId ||
						(fact?.phase !== "completed" && fact?.phase !== "failed")
					)
						unavailable();
				}
				const attempt: CodexNativeToolAttempt = {
					identity: structuredClone(request.identity),
					operationRef: previousAttempts[0]?.operationRef ?? randomUUID(),
					attemptRef: randomUUID(),
					intentRequestId: request.requestId,
					intentFingerprint: fingerprint,
					...(descriptor && connectionOrigin
						? {
								connectionRequest: structuredClone(descriptor),
								connectionOrigin,
							}
						: {}),
				};
				const toolName = request.identity.toolName;
				const toolId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(toolName)
					? `codex:${toolName}`
					: `codex:${createHash("sha256").update(toolName).digest("hex")}`;
				this.appendOperationFact(session, journal, {
					kind: "tool",
					operationRef: attempt.operationRef,
					attemptRef: attempt.attemptRef,
					phase: "intent",
					toolId,
					...(descriptor?.toolName === "execute_action"
						? {
								connection: {
									serviceRef: descriptor.serviceRef,
									verification: "unverified" as const,
									reason: "receipt_missing" as const,
								},
							}
						: {}),
					...(parent
						? { parentOperationRef: parent.operationRef }
						: resolved.sourceRecord
							? {
									parentOperationRef:
										journal.nativeToolAttempts?.[
											resolved.sourceRecord.reservation.parent.attemptRef
										]?.operationRef,
								}
							: {}),
				});
				journal.nativeToolAttempts ??= {};
				journal.nativeToolAttempts[request.identity.attemptRef] = attempt;
				return { ...resolved, attempt, existing: false };
			});
			notify(prepared.nativeSessionRef, prepared.execution.executionId);
			const originalDecision = (
				attempt: CodexNativeToolAttempt,
			): CodexNativeOperationResponseV1 | CodexConnectionOperationResponse => {
				if (attempt.denied)
					return {
						...binding,
						phase: "intent",
						decision: "deny",
						reason: attempt.denied,
					};
				if (
					!attempt.permitId ||
					!attempt.expiresAt ||
					attempt.expiresAt <= Date.now()
				)
					unavailable();
				return {
					...binding,
					phase: "intent",
					decision: "permit",
					permitId: attempt.permitId,
					expiresAt: attempt.expiresAt,
					sourceOwner: {
						rootThreadId: prepared.session.threadId ?? "",
						rootTurnId: prepared.journal.nativeTurnId,
					},
				};
			};
			if (prepared.attempt.denied) return originalDecision(prepared.attempt);
			let denied: CodexNativeToolAttempt["denied"];
			try {
				if (!this.authorizeExternalAction) unavailable();
				const waiting = new AbortController();
				try {
					signal.throwIfAborted();
					// Host may be queued on its own store. Detach only its result on
					// cancellation; no late continuation may mutate this Driver journal.
					await Promise.race([
						once(signal, "abort", { signal: waiting.signal }).then(() => {
							throw new Error("CODEX_NATIVE_CALLBACK_UNAVAILABLE");
						}),
						this.authorizeExternalAction({
							nativeSessionRef: prepared.nativeSessionRef,
							executionId: prepared.execution.executionId,
							runtimeOperationId: prepared.execution.executionId,
							operationRef: prepared.attempt.operationRef,
							attemptRef: prepared.attempt.attemptRef,
							kind: "tool",
						}),
					]);
				} finally {
					waiting.abort();
				}
				signal.throwIfAborted();
			} catch (error) {
				denied =
					error instanceof RuntimeHostError && error.httpStatus === 403
						? "authorization_denied"
						: "authorization_unavailable";
			}
			signal.throwIfAborted();
			const decision = await this.update((state) => {
				signal.throwIfAborted();
				if (this.closed) unavailable();
				const { session, journal, execution, attempt, sourceRecord } =
					locate(state);
				if (!attempt || attempt.denied) stateInvalid();
				if (descriptor) {
					try {
						this.assertConnectionDispatch(
							conversationKey,
							descriptor,
							session,
							execution,
						);
					} catch {
						denied ??= "authorization_unavailable";
					}
				}
				if (prepared.existing && denied) unavailable();
				this.assertJournalOpen(journal);
				const fact = latestOperationAttemptFacts(journal.events).find(
					(fact) => operationAttemptKey(fact) === operationAttemptKey(attempt),
				);
				if (fact?.kind !== "tool" || fact.phase !== "intent") unavailable();
				if (
					this.closed ||
					signal.aborted ||
					journal.externalActionsBlocked ||
					(sourceRecord
						? sourceRecord.terminal !== undefined
						: journal.nativeCompletionStatus !== undefined) ||
					this.hasInterruption(
						prepared.nativeSessionRef,
						execution.executionId,
						state,
					) ||
					session.activeExecutionId !== execution.executionId ||
					execution.status !== "running"
				)
					denied ??= "authorization_unavailable";
				if (denied) {
					attempt.denied = denied;
					this.appendOperationFact(session, journal, {
						...fact,
						phase: "failed",
						finishedAt: new Date().toISOString(),
						failureCode: denied,
					});
					journal.externalActionsBlocked = true;
				} else if (!attempt.permitId) {
					attempt.permitId = randomUUID();
					attempt.expiresAt = Date.now() + 4_000;
				}
				if (journal.nativeCompletionStatus)
					this.setExecutionStatus(
						state,
						prepared.nativeSessionRef,
						execution.executionId,
						journal.nativeTurnId,
						journal.nativeCompletionStatus,
					);
				return originalDecision(attempt);
			});
			notify(prepared.nativeSessionRef, prepared.execution.executionId);
			return decision;
		}
		const saved = await this.update((state) => {
			signal.throwIfAborted();
			if (this.closed) unavailable();
			const { session, journal, execution, nativeSessionRef, attempt } =
				locate(state);
			if (
				!attempt?.permitId ||
				attempt.permitId !== request.permitId ||
				attempt.denied
			)
				protocolInvalid();
			const receipt =
				request.phase === "started" ? "startedRequestId" : "outcomeRequestId";
			const fingerprintField =
				request.phase === "started"
					? "startedFingerprint"
					: "outcomeFingerprint";
			if (attempt[receipt]) {
				if (
					attempt[receipt] !== request.requestId ||
					attempt[fingerprintField] !== fingerprint
				)
					protocolInvalid();
				return { nativeSessionRef, executionId: execution.executionId };
			}
			if (
				request.phase === "started" &&
				(!attempt.expiresAt || attempt.expiresAt <= Date.now())
			)
				protocolInvalid();
			if (
				[
					attempt.intentRequestId,
					attempt.startedRequestId,
					attempt.outcomeRequestId,
				].includes(request.requestId)
			)
				protocolInvalid();
			this.assertJournalOpen(journal);
			const fact = latestOperationAttemptFacts(journal.events).find(
				(fact) => operationAttemptKey(fact) === operationAttemptKey(attempt),
			);
			if (
				fact?.kind !== "tool" ||
				(fact.phase !== "intent" &&
					fact.phase !== "started" &&
					fact.phase !== "unknown")
			)
				unavailable();
			const occurredAt = new Date(request.occurredAt).toISOString();
			if (request.phase === "started") {
				if (fact.phase !== "intent") protocolInvalid();
				this.appendOperationFact(session, journal, {
					...fact,
					phase: "started",
					startedAt: occurredAt,
				});
			} else {
				const evidence =
					"connectionEvidence" in request
						? request.connectionEvidence
						: undefined;
				const association =
					descriptor && evidence
						? this.connectionClient(conversationKey).associate({
								requestDescriptor: descriptor,
								evidence,
								previousEvidence: attempt.connectionEvidence,
								metadataOnly: false,
								occurredAt: request.occurredAt,
							})
						: undefined;
				if (descriptor?.toolName === "execute_action" && !association)
					protocolInvalid();
				if (evidence) attempt.connectionEvidence = structuredClone(evidence);
				if (
					request.outcome === "completed" &&
					fact.phase !== "started" &&
					fact.phase !== "unknown"
				)
					protocolInvalid();
				if (request.outcome === "unknown" && fact.phase === "unknown") {
					// A recovered unknown is already the same public fact. Preserve it
					// while saving the original native receipt, without emitting a duplicate.
					if (association && !isDeepStrictEqual(fact.connection, association))
						this.appendOperationFact(
							session,
							journal,
							{ ...fact, connection: association },
							true,
						);
					attempt[receipt] = request.requestId;
					attempt[fingerprintField] = fingerprint;
					return { nativeSessionRef, executionId: execution.executionId };
				}
				const durationMs = fact.startedAt
					? request.occurredAt - Date.parse(fact.startedAt)
					: undefined;
				if (durationMs !== undefined && durationMs < 0) protocolInvalid();
				const reason = "reason" in request ? request.reason : undefined;
				const failureCode: RuntimeOperationFactV2["failureCode"] =
					request.outcome === "unknown"
						? "recovery_unconfirmed"
						: reason === "authorization_denied"
							? "authorization_denied"
							: reason === "authorization_unavailable"
								? "authorization_unavailable"
								: reason === "execution_failed"
									? "operation_failed"
									: "interrupted";
				const {
					failureCode: _oldFailure,
					finishedAt: _oldFinish,
					durationMs: _oldDuration,
					...original
				} = fact;
				this.appendOperationFact(session, journal, {
					...original,
					phase: request.outcome,
					...(association ? { connection: association } : {}),
					finishedAt: occurredAt,
					...(durationMs === undefined ? {} : { durationMs }),
					...(request.outcome === "completed" ? {} : { failureCode }),
				});
				if (request.outcome === "unknown")
					journal.externalActionsBlocked = true;
			}
			attempt[receipt] = request.requestId;
			attempt[fingerprintField] = fingerprint;
			if (journal.nativeCompletionStatus)
				this.setExecutionStatus(
					state,
					nativeSessionRef,
					execution.executionId,
					journal.nativeTurnId,
					journal.nativeCompletionStatus,
				);
			return { nativeSessionRef, executionId: execution.executionId };
		});
		notify(saved.nativeSessionRef, saved.executionId);
		return { ...binding, phase: request.phase, decision: "ack" };
	}

	private performNativeSourceCallback(
		conversationKey: string,
		request: CodexNativeSourceRequestV1,
		signal: AbortSignal,
	): Promise<CodexNativeSourceResponseV1> {
		const key = JSON.stringify([
			conversationKey,
			request.requestId,
			nativeSourceFingerprint(request),
		]);
		const existing = this.inFlightNativeSourceCallbacks.get(key);
		if (existing) return existing;
		const operation = this.performNativeSourceCallbackInternal(
			conversationKey,
			request,
			signal,
		);
		this.inFlightNativeSourceCallbacks.set(key, operation);
		const clear = () => {
			if (this.inFlightNativeSourceCallbacks.get(key) === operation)
				this.inFlightNativeSourceCallbacks.delete(key);
		};
		void operation.then(clear, clear);
		return operation;
	}

	private async performNativeSourceCallbackInternal(
		conversationKey: string,
		request: CodexNativeSourceRequestV1,
		signal: AbortSignal,
	): Promise<CodexNativeSourceResponseV1> {
		const fingerprint = nativeSourceFingerprint(request);
		const receipt = { requestId: request.requestId, fingerprint };
		const locate = (state: CodexDriverState) => {
			const parentId = request.reservation.parent;
			const resolved = this.resolveNativeSourceJournal(
				state,
				conversationKey,
				parentId.sessionId,
				parentId.turnId,
			);
			if (!resolved?.execution) unavailable();
			const parent = ownRecordValue(
				resolved.journal.nativeToolAttempts ?? {},
				parentId.attemptRef,
			);
			if (
				!parent ||
				!sameCodexNativeAttemptV1(parent.identity, parentId) ||
				parent.permitId !== request.reservation.parentPermitId ||
				parent.denied
			)
				protocolInvalid();
			const source = ownRecordValue(
				resolved.journal.nativeSources ?? {},
				request.reservation.reservationId,
			);
			if (
				source &&
				(source.reservation.childThreadId !==
					request.reservation.childThreadId ||
					source.reservation.submissionId !==
						request.reservation.submissionId ||
					source.reservation.parentPermitId !==
						request.reservation.parentPermitId ||
					!sameCodexNativeAttemptV1(source.reservation.parent, parentId))
			)
				protocolInvalid();
			return { ...resolved, execution: resolved.execution, parent, source };
		};
		const isClosed = (
			state: CodexDriverState,
			resolved: ReturnType<typeof locate>,
		) =>
			this.closed ||
			resolved.journal.externalActionsBlocked ||
			resolved.execution.status !== "running" ||
			resolved.session.activeExecutionId !== resolved.execution.executionId ||
			this.hasInterruption(
				resolved.nativeSessionRef,
				resolved.execution.executionId,
				state,
			);
		const checkReceipt = (prior: CodexNativeSourceReceipt) => {
			if (
				prior.requestId !== receipt.requestId ||
				prior.fingerprint !== receipt.fingerprint
			)
				protocolInvalid();
		};
		const denyBind = (
			source: CodexNativeSourceRecord,
			reason: "authorization_denied" | "authorization_unavailable",
		) => {
			source.bindDenied = reason;
			source.bindDeniedReceipt = receipt;
		};
		const checkUniqueRequest = (state: CodexDriverState) => {
			for (const session of Object.values(state.sessions)) {
				if (codexConversationKey(session) !== conversationKey) continue;
				for (const journal of Object.values(session.journals ?? {})) {
					for (const attempt of Object.values(journal.nativeToolAttempts ?? {}))
						if (
							[
								attempt.intentRequestId,
								attempt.startedRequestId,
								attempt.outcomeRequestId,
							].includes(request.requestId)
						)
							protocolInvalid();
					for (const source of Object.values(journal.nativeSources ?? {}))
						for (const value of [
							source.reserve,
							source.bindPending,
							source.bind,
							source.bindDeniedReceipt,
							source.notStarted,
							source.terminal,
						])
							if (value?.requestId === request.requestId) protocolInvalid();
				}
			}
		};
		const reply = (
			resolved: ReturnType<typeof locate>,
			currentReserveDenial?: CodexNativeSourceRecord["reserveDenied"],
		): CodexNativeSourceResponseV1 => {
			const common = {
				schemaVersion: 1 as const,
				requestId: request.requestId,
			};
			if (
				request.phase === "source-reserve" ||
				request.phase === "source-bind"
			) {
				const denied =
					request.phase === "source-reserve"
						? (resolved.source?.reserveDenied ?? currentReserveDenial)
						: resolved.source?.bindDenied;
				if (denied)
					return {
						...common,
						phase: request.phase,
						request,
						decision: "deny",
						reason: denied,
					};
				if (!resolved.session.threadId) stateInvalid();
				return {
					...common,
					phase: request.phase,
					request,
					decision: "ack",
					sourceOwner: {
						rootThreadId: resolved.session.threadId,
						rootTurnId: resolved.journal.nativeTurnId,
					},
				};
			}
			return { ...common, phase: request.phase, request, decision: "ack" };
		};
		const validateTransition = (
			state: CodexDriverState,
			resolved: ReturnType<typeof locate>,
		) => {
			if (request.phase === "source-reserve") return;
			const { source, parent, journal } = resolved;

			if (!source?.reserveAuthorized || source.reserveDenied) protocolInvalid();
			if (request.phase === "source-bind") {
				if (
					source.bindPending &&
					source.bindPending.requestId !== request.requestId
				)
					protocolInvalid();
				if (
					!parent.startedRequestId ||
					source.notStarted ||
					source.terminal ||
					request.source.threadId !== request.reservation.childThreadId
				)
					protocolInvalid();
				if (
					request.delivery === "started" &&
					request.source.turnId !== request.reservation.submissionId
				)
					protocolInvalid();
				const target = this.resolveNativeSourceJournal(
					state,
					conversationKey,
					request.source.threadId,
					request.source.turnId,
				);
				if (request.delivery === "started" && target && !source.bindPending)
					protocolInvalid();
				if (
					request.delivery === "steered" &&
					(!target ||
						target.nativeSessionRef !== resolved.nativeSessionRef ||
						target.journal.nativeTurnId !== journal.nativeTurnId)
				)
					protocolInvalid();
			} else if (request.phase === "source-not-started") {
				if (source.terminal || (source.bind && !source.bindDenied))
					protocolInvalid();
				if (
					request.stage === "gate_rejected" &&
					(request.source.threadId !== request.reservation.childThreadId ||
						request.source.turnId !== request.reservation.submissionId)
				)
					protocolInvalid();
			} else if (
				!source.bind ||
				source.bindDenied ||
				source.delivery !== "started" ||
				!source.source ||
				source.source.threadId !== request.source.threadId ||
				source.source.turnId !== request.source.turnId ||
				source.notStarted
			)
				protocolInvalid();
		};
		const priorReceipt = (source: CodexNativeSourceRecord | undefined) =>
			request.phase === "source-reserve"
				? source?.reserve
				: request.phase === "source-bind"
					? (source?.bind ?? source?.bindPending ?? source?.bindDeniedReceipt)
					: request.phase === "source-not-started"
						? source?.notStarted
						: source?.terminal;
		const decisionRecorded = (source: CodexNativeSourceRecord | undefined) =>
			request.phase === "source-reserve"
				? source?.reserveAuthorized === true ||
					source?.reserveDenied !== undefined
				: request.phase === "source-bind"
					? source?.bind !== undefined ||
						source?.bindDenied !== undefined ||
						source?.bindDeniedReceipt !== undefined
					: true;

		signal.throwIfAborted();
		const prepared = await this.update((state) => {
			signal.throwIfAborted();
			if (this.closed) unavailable();
			const resolved = locate(state);
			const { source, journal, parent } = resolved;
			if (
				request.phase === "source-bind" &&
				source?.bindDenied !== undefined &&
				source.bindDeniedReceipt === undefined
			)
				unavailable();
			const prior = priorReceipt(source);
			if (prior) {
				checkReceipt(prior);
				return { ...resolved, replay: decisionRecorded(source) };
			}
			checkUniqueRequest(state);
			this.assertJournalOpen(journal);
			if (request.phase === "source-reserve") {
				if (
					isClosed(state, resolved) ||
					(resolved.sourceRecord
						? resolved.sourceRecord.terminal !== undefined
						: journal.nativeCompletionStatus !== undefined) ||
					parent.outcomeRequestId ||
					(!parent.startedRequestId &&
						(!parent.expiresAt || parent.expiresAt <= Date.now()))
				)
					unavailable();
				this.assertExecutionConfiguration(
					state,
					resolved.session,
					resolved.execution,
				);
				for (const session of Object.values(state.sessions)) {
					if (codexConversationKey(session) !== conversationKey) continue;
					for (const otherJournal of Object.values(session.journals ?? {}))
						for (const other of Object.values(otherJournal.nativeSources ?? {}))
							if (
								other.reservation.reservationId ===
									request.reservation.reservationId ||
								(other.reservation.childThreadId ===
									request.reservation.childThreadId &&
									other.reservation.submissionId ===
										request.reservation.submissionId)
							)
								protocolInvalid();
				}
				const created: CodexNativeSourceRecord = {
					reservation: structuredClone(request.reservation),
					reserve: receipt,
				};
				journal.nativeSources ??= {};
				journal.nativeSources[request.reservation.reservationId] = created;
				return { ...resolved, source: created, replay: false };
			}
			validateTransition(state, resolved);
			return { ...resolved, replay: false };
		});
		let denied:
			| "authorization_denied"
			| "authorization_unavailable"
			| undefined;
		const needsAdmission =
			request.phase === "source-reserve" ||
			(request.phase === "source-bind" && request.delivery === "started");
		// A source-reserve replay must still cross the Host authorization boundary;
		// only a completed bind/terminal decision may skip the external check.
		const requiresAuthorization =
			needsAdmission &&
			(!prepared.replay || request.phase === "source-reserve");
		if (requiresAuthorization) {
			const waiting = new AbortController();
			try {
				if (!this.authorizeExternalAction) unavailable();
				signal.throwIfAborted();
				await Promise.race([
					once(signal, "abort", { signal: waiting.signal }).then(() => {
						throw unavailableError();
					}),
					this.authorizeExternalAction({
						nativeSessionRef: prepared.nativeSessionRef,
						executionId: prepared.execution.executionId,
						runtimeOperationId: prepared.execution.executionId,
						operationRef: prepared.parent.operationRef,
						attemptRef: prepared.parent.attemptRef,
						kind: "tool",
						purpose:
							request.phase === "source-reserve"
								? "source-reserve"
								: "source-bind",
					}),
				]);
			} catch (error) {
				denied =
					error instanceof RuntimeHostError && error.httpStatus === 403
						? "authorization_denied"
						: "authorization_unavailable";
			} finally {
				waiting.abort();
			}
		}
		if (!prepared.replay && request.phase === "source-terminal") {
			try {
				await this.cancelModelTurn?.({ ...request.source, conversationKey });
			} catch {
				// The native terminal receipt remains authoritative even if model cleanup
				// is already closed or otherwise unavailable.
			}
		}
		signal.throwIfAborted();
		let saved = await this.update((state) => {
			signal.throwIfAborted();
			if (this.closed) unavailable();
			const resolved = locate(state);
			const source = resolved.source;
			if (!source) stateInvalid();
			// Host authorization and model draining run outside the file queue.
			// Re-read phase identity and prerequisites before committing; another
			// callback may already have settled this reservation in the meantime.
			const prior = priorReceipt(source);
			if (prior) {
				checkReceipt(prior);
				if (decisionRecorded(source)) {
					// Keep the committed receipt and source lineage immutable. A fresh
					// authorization denial refuses this response, not the prior admission.
					return resolved;
				}
			}
			// An identical callback may already have a pending bind receipt. Its
			// fingerprint was checked above, so do not reject the coalesced update
			// as a reused request while the first admission is being committed.
			if (request.phase !== "source-reserve") {
				if (!prior) checkUniqueRequest(state);
				this.assertJournalOpen(resolved.journal);
				validateTransition(state, resolved);
			}
			if (
				needsAdmission &&
				(isClosed(state, resolved) ||
					!this.executionConfigurationMatches(
						state,
						resolved.session,
						resolved.execution,
					))
			)
				denied ??= "authorization_unavailable";
			if (request.phase === "source-bind" && source.bindDenied) {
				if (
					source.delivery !== request.delivery ||
					!source.source ||
					!isDeepStrictEqual(source.source, request.source)
				)
					protocolInvalid();
				return resolved;
			}
			if (request.phase === "source-reserve") {
				if (
					(resolved.sourceRecord
						? resolved.sourceRecord.terminal !== undefined
						: resolved.journal.nativeCompletionStatus !== undefined) ||
					resolved.parent.outcomeRequestId ||
					(!resolved.parent.startedRequestId &&
						(!resolved.parent.expiresAt ||
							resolved.parent.expiresAt <= Date.now()))
				)
					denied ??= "authorization_unavailable";
				if (denied) source.reserveDenied = denied;
				else source.reserveAuthorized = true;
			} else if (request.phase === "source-bind") {
				source.bindPending = receipt;
				source.source = structuredClone(request.source);
				source.delivery = request.delivery;
				if (denied) {
					delete source.bindPending;
					denyBind(source, denied);
				}
			} else if (request.phase === "source-not-started") {
				source.notStarted = receipt;
				source.notStartedStage = request.stage;
				source.notStartedReason = request.reason;
				if (request.stage === "gate_rejected")
					source.source = structuredClone(request.source);
			} else {
				source.terminal = receipt;
				source.nativeStatus = request.nativeStatus;
			}
			if (resolved.journal.nativeCompletionStatus)
				this.setExecutionStatus(
					state,
					resolved.nativeSessionRef,
					resolved.execution.executionId,
					resolved.journal.nativeTurnId,
					resolved.journal.nativeCompletionStatus,
				);
			return resolved;
		});
		if (
			request.phase === "source-bind" &&
			request.delivery === "started" &&
			!saved.source?.bindDenied &&
			!saved.source?.terminal
		) {
			const current = locate(this.readState());
			if (!isClosed(this.readState(), current)) {
				if (saved.source?.bindPending) {
					const selection = this.operationSelection(
						this.executionOperation(
							this.readState(),
							current.session,
							current.execution,
						),
					);
					if (!selection) unavailable();
					const beginAdmission = this.beginModelTurnAdmission;
					const recognizeTurn = this.recognizeModelTurn;
					const registerTurn = this.registerModelTurn;
					const hasAdmissionHook =
						beginAdmission !== undefined ||
						recognizeTurn !== undefined ||
						registerTurn !== undefined;
					const turn = { ...request.source, conversationKey };
					const turnKey = this.nativeTurnKey(
						conversationKey,
						request.source.threadId,
						request.source.turnId,
					);
					let admission: CodexModelTurnAdmission | undefined;
					let pendingSourceRetained = false;
					let lateClose = false;
					const cleanupTurnRegistration = () => {
						if (pendingSourceRetained) {
							this.releasePendingSourceTurn(turnKey, receipt.requestId);
							pendingSourceRetained = false;
						}
						if (admission) this.abandonModelTurnAdmission?.(admission);
						this.revokeModelTurn?.(turn);
					};
					if (hasAdmissionHook) {
						if (!beginAdmission || !recognizeTurn || !registerTurn) {
							await this.update((state) => {
								const resolved = locate(state);
								const source = resolved.source;
								if (
									!source ||
									source.bindPending?.requestId !== receipt.requestId
								)
									stateInvalid();
								delete source.bindPending;
								denyBind(source, "authorization_unavailable");
							});
							unavailable();
						}
						admission = beginAdmission(
							Date.now() + rpcRequestTimeoutMs,
							selection.model,
							request.source.threadId,
							selection.effort,
							conversationKey,
						);
						if (
							admission === undefined ||
							recognizeTurn(admission, turn) !== true ||
							registerTurn(admission, turn) !== true
						) {
							if (admission) this.abandonModelTurnAdmission?.(admission);
							await this.update((state) => {
								const resolved = locate(state);
								const source = resolved.source;
								if (
									!source ||
									source.bindPending?.requestId !== receipt.requestId
								)
									stateInvalid();
								delete source.bindPending;
								denyBind(source, "authorization_unavailable");
							});
							unavailable();
						}
						this.retainPendingSourceTurn(turnKey, receipt.requestId);
						pendingSourceRetained = true;
					}
					try {
						saved = await this.update((state) => {
							const resolved = locate(state);
							const source = resolved.source;
							if (
								!source ||
								source.bindPending?.requestId !== receipt.requestId
							)
								stateInvalid();
							if (
								isClosed(state, resolved) ||
								!this.executionConfigurationMatches(
									state,
									resolved.session,
									resolved.execution,
								)
							) {
								lateClose = true;
								delete source.bindPending;
								denyBind(source, "authorization_unavailable");
							} else {
								source.bind = source.bindPending;
							}
							delete source.bindPending;
							return resolved;
						});
					} catch (error) {
						cleanupTurnRegistration();
						throw error;
					}
					if (lateClose) cleanupTurnRegistration();
					else {
						this.releasePendingSourceTurn(turnKey, receipt.requestId);
						pendingSourceRetained = false;
					}
				}
			} else unavailable();
		}
		if (request.phase === "source-bind" && saved.source?.bindPending) {
			saved = await this.update((state) => {
				const resolved = locate(state);
				const source = resolved.source;
				if (!source || source.bindPending?.requestId !== receipt.requestId)
					stateInvalid();
				if (
					request.delivery === "started" &&
					(isClosed(state, resolved) ||
						!this.executionConfigurationMatches(
							state,
							resolved.session,
							resolved.execution,
						))
				) {
					delete source.bindPending;
					denyBind(source, "authorization_unavailable");
				} else {
					source.bind = source.bindPending;
				}
				delete source.bindPending;
				return resolved;
			});
		}
		this.notifyEventStream(
			this.eventStreamKey(saved.nativeSessionRef, saved.execution.executionId),
		);
		return reply(
			saved,
			request.phase === "source-reserve" ? denied : undefined,
		);
	}

	private async prepareModelRequest(
		context: CodexModelRequestContext,
		signal: AbortSignal,
	): Promise<CodexModelRequestJournal> {
		signal.throwIfAborted();
		const submitting = this.resolveNativeSourceJournal(
			this.readState(),
			this.sharesOneNativeTransport() ? undefined : context.conversationKey,
			context.threadId,
			context.turnId,
		);
		const submittingSession = submitting?.session;
		const submittingExecution = submitting?.execution;
		if (submittingSession && submittingExecution) {
			// Await only the final durable admission write, never execute() itself:
			// a failed submission drains this very HTTP request while unwinding.
			const confirmation = this.finalModelAdmissionConfirmations.get(
				operationKey({
					...submittingSession,
					kind: "submit-turn",
					operationId: submittingExecution.executionId,
				}),
			);
			if (confirmation && !(await confirmation)) unavailable();
		}
		const prepared = await this.update((state) => {
			signal.throwIfAborted();
			if (this.closed) unavailable();
			const resolved = this.resolveNativeSourceJournal(
				state,
				this.sharesOneNativeTransport() ? undefined : context.conversationKey,
				context.threadId,
				context.turnId,
			);
			if (!resolved?.execution) unavailable();
			const { session, execution, journal, sourceRecord } = resolved;
			this.assertJournalOpen(journal);
			if (
				journal.externalActionsBlocked ||
				(sourceRecord
					? sourceRecord.terminal !== undefined
					: journal.nativeCompletionStatus !== undefined) ||
				execution.status !== "running" ||
				session.activeExecutionId !== execution.executionId
			)
				unavailable();
			const operation = this.executionOperation(state, session, execution);
			const selection = this.operationSelection(operation);
			if (
				operation.admissionPending ||
				operation.admissionRecoveryPending ||
				operation.configVersion !== this.configVersion ||
				selection?.model !== context.internalModel ||
				selection.effort !== context.reasoningLevel
			)
				unavailable();
			const model = [...this.modelOptions.values()].find(
				(option) => option.internalModel === context.internalModel,
			);
			if (!model) unavailable();
			const fact: RuntimeOperationFactV2 = {
				kind: "model",
				operationRef: randomUUID(),
				attemptRef: randomUUID(),
				phase: "intent",
				...(sourceRecord
					? {
							parentOperationRef:
								journal.nativeToolAttempts?.[
									sourceRecord.reservation.parent.attemptRef
								]?.operationRef,
						}
					: {}),
				model: {
					modelOptionId: model.modelOptionId,
					modelId: model.model,
					configVersion: this.configVersion,
					reasoningLevel: context.reasoningLevel,
				},
			};
			this.appendOperationFact(session, journal, fact);
			return {
				nativeSessionRef: resolved.nativeSessionRef,
				executionId: execution.executionId,
				journalTurnId: journal.nativeTurnId,
				fact,
			};
		});
		const streamKey = this.eventStreamKey(
			prepared.nativeSessionRef,
			prepared.executionId,
		);
		this.notifyEventStream(streamKey);
		const record = async (
			phase: "started" | "completed" | "failed" | "unknown",
			details: {
				startedAt?: string;
				finishedAt?: string;
				failureCode?: RuntimeOperationFactV2["failureCode"];
				durationMs?: number;
				usage?: Extract<RuntimeOperationFactV2, { kind: "model" }>["usage"];
			} = {},
		) => {
			const finishedAt =
				phase === "started"
					? undefined
					: (details.finishedAt ?? new Date().toISOString());
			await this.update((state) => {
				const session = ownRecordValue(
					state.sessions,
					prepared.nativeSessionRef,
				);
				const journal =
					session &&
					ownRecordValue(session.journals ?? {}, prepared.journalTurnId);
				if (!session || !journal) stateInvalid();
				const previous = latestOperationAttemptFacts(journal.events).find(
					(fact) =>
						operationAttemptKey(fact) === operationAttemptKey(prepared.fact),
				);
				if (
					previous?.kind !== "model" ||
					(previous.phase !== "intent" && previous.phase !== "started")
				)
					stateInvalid();
				this.appendOperationFact(session, journal, {
					...previous,
					...details,
					phase,
					...(finishedAt ? { finishedAt } : {}),
				});
				if (phase === "unknown" || phase === "failed")
					journal.externalActionsBlocked = true;
			});
			this.notifyEventStream(streamKey);
		};
		try {
			// Never call Host while holding the Driver durable-file queue. Host may
			// still be awaiting this Driver's original submit result.
			// Model and tool actions require the Host authorization seam; fail closed
			// when this deployment did not supply it.
			if (!this.authorizeExternalAction) unavailable();
			const waiting = new AbortController();
			try {
				signal.throwIfAborted();
				await Promise.race([
					once(signal, "abort", { signal: waiting.signal }).then(() => {
						throw unavailableError();
					}),
					this.authorizeExternalAction({
						nativeSessionRef: prepared.nativeSessionRef,
						executionId: prepared.executionId,
						runtimeOperationId: prepared.executionId,
						operationRef: prepared.fact.operationRef,
						attemptRef: prepared.fact.attemptRef,
						kind: "model",
					}),
				]);
				signal.throwIfAborted();
			} finally {
				waiting.abort();
			}
			// Authorization may have waited while another original action failed
			// or stop sealed this Execution. Recheck the committed Driver state.
			const state = this.readState();
			const session = ownRecordValue(state.sessions, prepared.nativeSessionRef);
			const execution =
				session && ownRecordValue(session.executions, prepared.executionId);
			const journal =
				session &&
				ownRecordValue(session.journals ?? {}, prepared.journalTurnId);
			const currentSource = this.resolveNativeSourceJournal(
				state,
				this.sharesOneNativeTransport() ? undefined : context.conversationKey,
				context.threadId,
				context.turnId,
			);
			const sourceRecord = currentSource?.sourceRecord;
			if (
				!currentSource ||
				currentSource.journal.nativeTurnId !== prepared.journalTurnId ||
				this.closed ||
				!session ||
				!execution ||
				!journal ||
				journal.externalActionsBlocked ||
				(sourceRecord
					? sourceRecord.terminal !== undefined
					: journal.nativeCompletionStatus !== undefined) ||
				execution.status !== "running" ||
				session.activeExecutionId !== execution.executionId ||
				this.hasInterruption(
					prepared.nativeSessionRef,
					prepared.executionId,
					state,
				)
			)
				unavailable();
			this.assertExecutionConfiguration(state, session, execution);
		} catch (error) {
			if (signal.aborted) {
				await record("unknown", { failureCode: "interrupted" });
			} else {
				await record("failed", {
					failureCode:
						error instanceof RuntimeHostError && error.httpStatus === 403
							? "authorization_denied"
							: "authorization_unavailable",
				});
			}
			throw error;
		}
		return {
			started: (startedAt) => record("started", { startedAt }),
			finish: (outcome) =>
				record(outcome.phase === "succeeded" ? "completed" : outcome.phase, {
					...(outcome.finishedAt ? { finishedAt: outcome.finishedAt } : {}),
					...(outcome.durationMs === undefined
						? {}
						: { durationMs: outcome.durationMs }),
					...(outcome.phase === "succeeded"
						? outcome.usage
							? { usage: outcome.usage }
							: {}
						: { failureCode: modelOperationFailure(outcome.failureCode) }),
				}),
		};
	}

	private async recoverUnconfirmedModelOperations() {
		const pending = Object.values(this.readState().sessions).some((session) =>
			Object.values(session.journals ?? {}).some(
				(journal) =>
					pendingNativeSources(journal).length > 0 ||
					latestOperationAttemptFacts(journal.events).some(
						(fact) => fact.phase === "intent" || fact.phase === "started",
					),
			),
		);
		if (!pending) return;
		await this.update((state) => {
			for (const session of Object.values(state.sessions)) {
				for (const journal of Object.values(session.journals ?? {})) {
					// Persisted lineage identifies the original source, but cannot prove
					// its live task/queue survived. Keep occupancy and seal new actions.
					if (pendingNativeSources(journal).length > 0)
						journal.externalActionsBlocked = true;
					for (const fact of latestOperationAttemptFacts(journal.events)) {
						if (fact.phase !== "intent" && fact.phase !== "started") continue;
						// The process may have died on either side of dispatch. Preserve the
						// original attempt and close new actions; never manufacture a retry.
						this.appendOperationFact(session, journal, {
							...fact,
							phase: "unknown",
							failureCode: "recovery_unconfirmed",
						});
						journal.externalActionsBlocked = true;
					}
				}
			}
		});
	}

	private appendOperationFact(
		session: CodexSession,
		journal: CodexEventJournal,
		fact: RuntimeOperationFactV2,
		connectionMetadataOnly = false,
	) {
		if (connectionMetadataOnly) {
			const previous = latestOperationAttemptFacts(journal.events).find(
				(previous) =>
					operationAttemptKey(previous) === operationAttemptKey(fact),
			);
			if (!previous || !isConnectionMetadataSuccessor(previous, fact))
				protocolInvalid();
		} else this.assertJournalOpen(journal);
		const { cursor, adapterEventKey } = this.nextEventIdentity(session);
		journal.events.push({
			cursor,
			adapterEventKey,
			occurredAt: new Date().toISOString(),
			type: "operation",
			payload: RuntimeOperationFactV2Schema.parse(fact),
		});
	}

	private async recordNotification(
		frame: CodexAppServerFrame,
		conversationKey: string | undefined,
	) {
		const started = turnStartedNotification(frame);
		if (started) {
			const recorded = await this.update((state) => {
				const resolved = this.resolveNotificationJournal(
					state,
					conversationKey,
					started.threadId,
					started.nativeTurnId,
				);
				if (!resolved) return;
				this.assertJournalOpen(resolved.journal);
				if (started.status !== "running") protocolInvalid();
				const appended = this.appendStatusEvent(
					resolved.session,
					resolved.journal,
				);
				return {
					pendingOperationKey: resolved.pendingOperationKey,
					modelConversationKey: this.modelConversationKey(
						codexConversationKey(resolved.session),
					),
					streamKey:
						resolved.execution && appended
							? this.eventStreamKey(
									resolved.nativeSessionRef,
									resolved.execution.executionId,
								)
							: undefined,
				};
			});
			const admissionDeadline = recorded?.pendingOperationKey
				? this.modelAdmissionDeadlines.get(recorded.pendingOperationKey)
				: undefined;
			const modelAdmission = recorded?.pendingOperationKey
				? this.modelTurnAdmissions.get(recorded.pendingOperationKey)
				: undefined;
			if (
				recorded &&
				admissionDeadline !== undefined &&
				modelAdmission !== undefined
			) {
				this.recognizeModelTurn?.(modelAdmission, {
					conversationKey: recorded.modelConversationKey,
					threadId: started.threadId,
					turnId: started.nativeTurnId,
				});
			}
			if (recorded) {
				this.recordNativeTurnStarted(
					recorded?.modelConversationKey,
					started.threadId,
					started.nativeTurnId,
				);
			}
			if (recorded?.streamKey) this.notifyEventStream(recorded.streamKey);
			return;
		}

		const completed = turnCompletedNotification(frame);
		if (completed) {
			// A cancelled native Turn may still have an in-flight provider request;
			// drain it before publishing the terminal event. Normal completion and
			// failure already represent a settled provider request and must not cancel
			// a transport that may be finishing its final response.
			const completedState = this.readState();
			const resolvedCompleted = this.resolveNotificationJournal(
				completedState,
				conversationKey,
				completed.threadId,
				completed.nativeTurnId,
			);
			const owningSession = Object.values(completedState.sessions).find(
				(session) =>
					session.threadId === completed.threadId &&
					(conversationKey === undefined ||
						codexConversationKey(session) === conversationKey),
			);
			const admissionPending =
				resolvedCompleted?.pendingOperationKey !== undefined &&
				this.modelTurnAdmissions.has(resolvedCompleted.pendingOperationKey);
			if (
				owningSession &&
				(completed.status === "cancelled" || admissionPending)
			)
				await this.cancelModelTurn?.({
					conversationKey: this.modelConversationKey(
						codexConversationKey(owningSession),
					),
					threadId: completed.threadId,
					turnId: completed.nativeTurnId,
				});
			const streamKey = await this.update((state) => {
				const resolved = this.resolveNotificationJournal(
					state,
					conversationKey,
					completed.threadId,
					completed.nativeTurnId,
				);
				if (!resolved) return;
				const appended = this.appendCompletedEvent(
					resolved.session,
					resolved.journal,
					completed.status,
				);
				if (!resolved.execution) return;
				this.setExecutionStatus(
					state,
					resolved.nativeSessionRef,
					resolved.execution.executionId,
					completed.nativeTurnId,
					completed.status,
				);
				return appended
					? this.eventStreamKey(
							resolved.nativeSessionRef,
							resolved.execution.executionId,
						)
					: undefined;
			});
			this.recordNativeTurnCompleted(
				owningSession
					? this.modelConversationKey(codexConversationKey(owningSession))
					: conversationKey === undefined
						? undefined
						: this.modelConversationKey(conversationKey),
				completed.threadId,
				completed.nativeTurnId,
			);
			if (streamKey) this.notifyEventStream(streamKey);
			return;
		}

		const message = agentMessageCompletedNotification(frame);
		if (message) {
			// The pinned native release only streams agent message deltas on some
			// transports, so the completed item is the canonical replay source.
			const messageStreamKey = await this.update((state) => {
				const resolved = this.resolveNotificationJournal(
					state,
					conversationKey,
					message.threadId,
					message.nativeTurnId,
				);
				if (!resolved) return;
				if (resolved.journal.events.some((event) => event.type === "completed"))
					return;
				const emitted = resolved.journal.events
					.filter(
						(event): event is CodexJournalTextEvent =>
							event.type === "text" &&
							event.nativeItemId === message.nativeItemId,
					)
					.map((event) => event.payload.delta)
					.join("");
				if (!message.text.startsWith(emitted)) protocolInvalid();
				const delta = message.text.slice(emitted.length);
				if (delta.length === 0) return;
				this.appendTextEvent(
					resolved.session,
					resolved.journal,
					message.nativeItemId,
					delta,
				);
				return resolved.execution
					? this.eventStreamKey(
							resolved.nativeSessionRef,
							resolved.execution.executionId,
						)
					: undefined;
			});
			if (messageStreamKey) this.notifyEventStream(messageStreamKey);
			return;
		}

		const delta = agentMessageDeltaNotification(frame);
		if (!delta || delta.delta.length === 0) return;
		const streamKey = await this.update((state) => {
			const resolved = this.resolveNotificationJournal(
				state,
				conversationKey,
				delta.threadId,
				delta.nativeTurnId,
			);
			if (!resolved) return;
			this.assertJournalOpen(resolved.journal);
			this.appendTextEvent(
				resolved.session,
				resolved.journal,
				delta.nativeItemId,
				delta.delta,
			);
			return resolved.execution
				? this.eventStreamKey(
						resolved.nativeSessionRef,
						resolved.execution.executionId,
					)
				: undefined;
		});
		if (streamKey) this.notifyEventStream(streamKey);
	}

	private resolveNativeSourceJournal(
		state: CodexDriverState,
		conversationKey: string | undefined,
		threadId: string,
		nativeTurnId: string,
	) {
		const root = this.resolveNotificationJournal(
			state,
			conversationKey,
			threadId,
			nativeTurnId,
		);
		if (root)
			return {
				...root,
				sourceRecord: undefined as CodexNativeSourceRecord | undefined,
			};
		const matches = Object.values(state.sessions).flatMap((session) => {
			const sessionConversationKey = codexConversationKey(session);
			if (
				conversationKey !== undefined &&
				sessionConversationKey !== conversationKey
			)
				return [];
			return Object.values(session.journals ?? {}).flatMap((journal) =>
				Object.values(journal.nativeSources ?? {})
					.filter((source) => {
						const pendingAdmission =
							source.bindPending !== undefined &&
							source.source !== undefined &&
							this.hasPendingSourceTurn(
								this.nativeTurnKey(
									sessionConversationKey,
									threadId,
									nativeTurnId,
								),
								source.bindPending.requestId,
							);
						return (
							source.delivery === "started" &&
							((source.bind !== undefined && !source.bindDenied) ||
								pendingAdmission) &&
							source.source?.threadId === threadId &&
							source.source.turnId === nativeTurnId
						);
					})
					.map((sourceRecord) => ({ session, journal, sourceRecord })),
			);
		});
		if (matches.length === 0) return undefined;
		if (matches.length !== 1) protocolInvalid();
		const match = matches[0];
		if (!match?.session.threadId) stateInvalid();
		const resolved = this.resolveNotificationJournal(
			state,
			conversationKey,
			match.session.threadId,
			match.journal.nativeTurnId,
		);
		if (!resolved) stateInvalid();
		return { ...resolved, sourceRecord: match.sourceRecord };
	}

	private resolveNotificationJournal(
		state: CodexDriverState,
		conversationKey: string | undefined,
		threadId: string,
		nativeTurnId: string,
	) {
		// A native ID only means anything inside the process that issued it, so the
		// owning Conversation is part of the match, not just the thread ID.
		const matchingSessions = Object.entries(state.sessions).filter(
			([, session]) =>
				session.threadId === threadId &&
				(conversationKey === undefined ||
					codexConversationKey({
						agentId: session.agentId,
						conversationId: session.conversationId,
						sessionGeneration: session.sessionGeneration,
					}) === conversationKey),
		);
		if (matchingSessions.length === 0) return undefined;
		if (matchingSessions.length !== 1) stateInvalid();
		const [nativeSessionRef, session] = matchingSessions[0] ?? [];
		if (!nativeSessionRef || !session) stateInvalid();
		const execution = Object.values(session.executions).find(
			(candidate) => candidate.nativeTurnId === nativeTurnId,
		);
		const executionOperationKey = execution
			? operationKey({
					agentId: session.agentId,
					conversationId: session.conversationId,
					sessionGeneration: session.sessionGeneration,
					kind: "submit-turn",
					operationId: execution.executionId,
				})
			: undefined;
		const executionOperation = executionOperationKey
			? ownRecordValue(state.operations, executionOperationKey)
			: undefined;
		const preparedOperations = Object.entries(state.operations).filter(
			([, operation]) =>
				operation.nativeSessionRef === nativeSessionRef &&
				operation.state === "prepared" &&
				operation.executionId === undefined &&
				operation.turnId === undefined,
		);
		if (preparedOperations.length > 1) stateInvalid();
		const pendingOperationKey = executionOperation?.admissionPending
			? executionOperationKey
			: preparedOperations[0]?.[0];
		if (!execution && !pendingOperationKey) return undefined;
		return {
			nativeSessionRef,
			session,
			execution,
			pendingOperationKey,
			journal: this.ensureJournal(
				session,
				nativeTurnId,
				execution ? undefined : preparedOperations[0]?.[0],
			),
		};
	}

	private ensureJournal(
		session: CodexSession,
		nativeTurnId: string,
		pendingOperationKey?: string,
	) {
		if (session.journals === undefined) {
			Object.defineProperty(session, "journals", {
				value: {},
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		const journals = session.journals;
		if (!journals) stateInvalid();
		const existing = ownRecordValue(journals, nativeTurnId);
		if (existing) {
			if (existing.pendingOperationKey !== pendingOperationKey) stateInvalid();
			return existing;
		}
		const journal: CodexEventJournal = {
			nativeTurnId,
			...(pendingOperationKey === undefined ? {} : { pendingOperationKey }),
			events: [],
		};
		Object.defineProperty(journals, nativeTurnId, {
			value: journal,
			enumerable: true,
			writable: true,
			configurable: true,
		});
		return journal;
	}

	private assertJournalOpen(journal: CodexEventJournal) {
		if (journal.events.some((event) => event.type === "completed")) {
			protocolInvalid();
		}
	}

	private appendStatusEvent(session: CodexSession, journal: CodexEventJournal) {
		if (journal.events.some((event) => event.type === "status")) return false;
		const { cursor, adapterEventKey } = this.nextEventIdentity(session);
		journal.events.push({
			cursor,
			adapterEventKey,
			occurredAt: new Date().toISOString(),
			type: "status",
			payload: { status: "running" },
		});
		return true;
	}

	private appendTextEvent(
		session: CodexSession,
		journal: CodexEventJournal,
		nativeItemId: string,
		delta: string,
	) {
		this.assertJournalOpen(journal);
		const { cursor, adapterEventKey } = this.nextEventIdentity(session);
		const event: CodexJournalTextEvent = {
			cursor,
			adapterEventKey,
			occurredAt: new Date().toISOString(),
			nativeItemId,
			type: "text",
			payload: { delta },
		};
		journal.events.push(event);
	}

	private appendCompletedEvent(
		session: CodexSession,
		journal: CodexEventJournal,
		status: Exclude<PersistedTurnStatus, "running">,
	) {
		const existing = journal.events.find((event) => event.type === "completed");
		if (existing) {
			if (existing.payload.status !== status) protocolInvalid();
			return false;
		}
		// Native supports background processes across inference Turns. Keep the
		// Execution occupied until each original source returns its own receipt.
		if (
			journal.nativeCompletionStatus &&
			journal.nativeCompletionStatus !== status
		)
			protocolInvalid();
		journal.nativeCompletionStatus = status;
		if (
			pendingNativeToolAttempts(journal).length > 0 ||
			pendingNativeSources(journal).length > 0
		)
			return false;
		// Provider transport has drained before this native terminal is consumed.
		// Preserve its unknown external result before closing the fact journal.
		for (const fact of latestOperationAttemptFacts(journal.events)) {
			if (fact.phase !== "intent" && fact.phase !== "started") continue;
			this.appendOperationFact(session, journal, {
				...fact,
				phase: "unknown",
				failureCode: "recovery_unconfirmed",
			});
			journal.externalActionsBlocked = true;
		}
		const { cursor, adapterEventKey } = this.nextEventIdentity(session);
		journal.events.push({
			cursor,
			adapterEventKey,
			occurredAt: new Date().toISOString(),
			type: "completed",
			payload: { status },
		});
		return true;
	}

	private runtimeEvent(executionId: string, event: CodexJournalEvent) {
		const base = {
			schemaVersion: 1 as const,
			adapterEventKey: event.adapterEventKey,
			executionId,
			cursor: event.cursor,
			occurredAt: event.occurredAt,
		};
		if (event.type === "operation") {
			return {
				...base,
				schemaVersion: 2 as const,
				type: "operation" as const,
				payload: event.payload,
			};
		}
		if (event.type === "status") {
			return { ...base, type: "status" as const, payload: event.payload };
		}
		if (event.type === "text") {
			return { ...base, type: "text" as const, payload: event.payload };
		}
		return { ...base, type: "completed" as const, payload: event.payload };
	}

	private nextEventIdentity(session: CodexSession) {
		const existingEvents = Object.values(session.journals ?? {}).flatMap(
			(candidate) => candidate.events,
		).length;
		const sequence = Math.max(session.eventSequence ?? 0, existingEvents) + 1;
		session.eventSequence = sequence;
		return {
			sequence,
			cursor: `codex-cursor-${sequence}`,
			adapterEventKey: `codex-event-${sequence}`,
		};
	}

	private eventStreamKey(nativeSessionRef: string, executionId: string) {
		return JSON.stringify([nativeSessionRef, executionId]);
	}

	private nativeTurnKey(
		conversationKey: string | undefined,
		threadId: string,
		nativeTurnId: string,
	) {
		return JSON.stringify([conversationKey ?? null, threadId, nativeTurnId]);
	}

	private recordNativeTurnStarted(
		conversationKey: string | undefined,
		threadId: string,
		nativeTurnId: string,
	) {
		const key = this.nativeTurnKey(conversationKey, threadId, nativeTurnId);
		this.observedNativeTurnStarts.add(key);
		for (const wake of this.nativeTurnStartWaiters.get(key) ?? []) wake();
		this.nativeTurnStartWaiters.delete(key);
	}

	private recordNativeTurnCompleted(
		conversationKey: string | undefined,
		threadId: string,
		nativeTurnId: string,
	) {
		const key = this.nativeTurnKey(conversationKey, threadId, nativeTurnId);
		this.observedNativeTurnStarts.delete(key);
		for (const wake of this.nativeTurnStartWaiters.get(key) ?? []) wake();
		this.nativeTurnStartWaiters.delete(key);
	}

	private isExecutionTerminal(nativeSessionRef: string, executionId: string) {
		const execution = ownRecordValue(
			this.session(nativeSessionRef).executions,
			executionId,
		);
		if (!execution) unavailable();
		return execution.status !== "running";
	}

	private notifyEventStream(key: string) {
		for (const wake of this.eventWaiters.get(key) ?? []) wake();
	}

	private waitForEvent(key: string, signal?: AbortSignal) {
		let wakeForEvent: () => void = () => undefined;
		let notified = false;
		let abort: () => void = () => undefined;
		const promise = new Promise<void>((resolve) => {
			const settle = () => {
				cleanup();
				resolve();
			};
			wakeForEvent = () => {
				notified = true;
				settle();
			};
			abort = settle;
		});
		const waiters = this.eventWaiters.get(key) ?? new Set<() => void>();
		this.eventWaiters.set(key, waiters);
		waiters.add(wakeForEvent);
		const cleanup = () => {
			waiters.delete(wakeForEvent);
			if (waiters.size === 0) this.eventWaiters.delete(key);
			signal?.removeEventListener("abort", abort);
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		return { promise, cancel: cleanup, wasNotified: () => notified };
	}

	private async recoverEventHistory(
		nativeSessionRef: string,
		executionId: string,
	) {
		const key = this.eventStreamKey(nativeSessionRef, executionId);
		if (this.recoveredEventExecutions.has(key)) return;
		const inFlight = this.inFlightEventRecoveries.get(key);
		if (inFlight) return inFlight;
		const recovery = this.recoverEventHistoryOnce(
			nativeSessionRef,
			executionId,
		);
		this.inFlightEventRecoveries.set(key, recovery);
		try {
			await recovery;
			this.recoveredEventExecutions.add(key);
		} finally {
			if (this.inFlightEventRecoveries.get(key) === recovery) {
				this.inFlightEventRecoveries.delete(key);
			}
		}
	}

	private async recoverEventHistoryOnce(
		nativeSessionRef: string,
		executionId: string,
	) {
		const initialState = this.readState();
		let session = ownRecordValue(initialState.sessions, nativeSessionRef);
		if (!session) unavailable();
		let execution = ownRecordValue(session.executions, executionId);
		if (!execution || !session.threadId) unavailable();
		this.assertModelAdmissionConfirmed(session, execution);
		// A durable cancellation receipt closes this generation's source/event
		// barrier. History recovery must not reopen its damaged native Session.
		if (this.hasConfirmedGenerationCancellation(nativeSessionRef, executionId))
			return;
		if (execution.status === "running") {
			await this.restoreExecutionStatus(nativeSessionRef, executionId, true);
			return;
		}
		if (!this.executionConfigurationMatches(initialState, session, execution)) {
			return;
		}
		await this.resumeSession(nativeSessionRef);
		session = this.session(nativeSessionRef);
		execution = ownRecordValue(session.executions, executionId);
		if (!execution || !session.threadId) unavailable();
		this.assertModelAdmissionConfirmed(session, execution);
		const items = await this.readNativeAgentMessageItems(
			nativeSessionRef,
			session.threadId,
			execution.nativeTurnId,
		);
		await this.persistRecoveredAgentMessageItems(
			nativeSessionRef,
			executionId,
			execution.nativeTurnId,
			items,
		);
	}

	private hasConfirmedGenerationCancellation(
		nativeSessionRef: string,
		executionId: string,
	) {
		const session = this.session(nativeSessionRef);
		return Object.values(this.readState().operations).some((operation) => {
			const record = operation.record;
			const result = record?.result;
			return (
				record?.kind === "generation-cancel" &&
				record.agentId === session.agentId &&
				record.conversationId === session.conversationId &&
				record.sessionGeneration === session.sessionGeneration &&
				operation.executionId === executionId &&
				operation.nativeSessionRef === nativeSessionRef &&
				operation.state === "resolved" &&
				result?.outcome === "accepted" &&
				["completed", "failed", "cancelled"].includes(result.status)
			);
		});
	}

	private async readNativeAgentMessageItems(
		nativeSessionRef: string,
		threadId: string,
		nativeTurnId: string,
	) {
		const items: { nativeItemId: string; text: string }[] = [];
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		for (let page = 0; page < maximumItemsListPages; page += 1) {
			const result = await (await this.rpc(nativeSessionRef)).request(
				"thread/items/list",
				{
					threadId,
					turnId: nativeTurnId,
					limit: itemsListPageSize,
					sortDirection: "asc",
					...(cursor === undefined ? {} : { cursor }),
				},
				(value) => this.agentMessageItemsFromList(value, nativeTurnId),
			);
			items.push(...result.items);
			if (result.nextCursor === undefined) return items;
			if (seenCursors.has(result.nextCursor)) protocolInvalid();
			seenCursors.add(result.nextCursor);
			cursor = result.nextCursor;
		}
		unavailable();
	}

	private agentMessageItemsFromList(value: unknown, nativeTurnId: string) {
		if (!isPlainRecord(value) || !Array.isArray(value.data)) protocolInvalid();
		const items: { nativeItemId: string; text: string }[] = [];
		for (const entry of value.data) {
			if (
				!isPlainRecord(entry) ||
				!hasOnlyKeys(entry, ["turnId", "item"]) ||
				entry.turnId !== nativeTurnId ||
				!isPlainRecord(entry.item) ||
				!nonEmptyString(entry.item.id) ||
				!nonEmptyString(entry.item.type)
			) {
				protocolInvalid();
			}
			if (entry.item.type !== "agentMessage") continue;
			if (typeof entry.item.text !== "string") protocolInvalid();
			items.push({ nativeItemId: entry.item.id, text: entry.item.text });
		}
		if (value.nextCursor === undefined || value.nextCursor === null) {
			return { items, nextCursor: undefined };
		}
		if (!nonEmptyString(value.nextCursor)) protocolInvalid();
		return { items, nextCursor: value.nextCursor };
	}

	private async persistRecoveredAgentMessageItems(
		nativeSessionRef: string,
		executionId: string,
		nativeTurnId: string,
		items: { nativeItemId: string; text: string }[],
	) {
		const streamKey = await this.update((state) => {
			const session = ownRecordValue(state.sessions, nativeSessionRef);
			const execution = session
				? ownRecordValue(session.executions, executionId)
				: undefined;
			if (!session || !execution || execution.nativeTurnId !== nativeTurnId) {
				stateInvalid();
			}
			const journal = this.ensureJournal(session, nativeTurnId);
			let appended = false;
			for (const item of items) {
				const emittedText = journal.events
					.filter(
						(event): event is CodexJournalTextEvent =>
							event.type === "text" && event.nativeItemId === item.nativeItemId,
					)
					.map((event) => event.payload.delta)
					.join("");
				if (!item.text.startsWith(emittedText)) protocolInvalid();
				const delta = item.text.slice(emittedText.length);
				if (delta.length === 0) continue;
				this.appendTextEvent(session, journal, item.nativeItemId, delta);
				appended = true;
			}
			return appended
				? this.eventStreamKey(nativeSessionRef, execution.executionId)
				: undefined;
		});
		if (streamKey) this.notifyEventStream(streamKey);
	}

	private async readNativeTurnStatus(
		session: CodexSession,
		execution: CodexExecution,
	) {
		if (!session.threadId) unavailable();
		try {
			return await this.readNativeTurnStatusPage(
				session.nativeSessionRef,
				session.threadId,
				execution.nativeTurnId,
			);
		} catch (error) {
			if (
				!(error instanceof CodexHistoryNotMaterializedError) ||
				!this.canReadLiveTurnHistory(session, execution)
			) {
				if (error instanceof CodexHistoryNotMaterializedError)
					protocolInvalid();
				throw error;
			}
			const current = ownRecordValue(
				this.session(session.nativeSessionRef).executions,
				execution.executionId,
			);
			if (!current) unavailable();
			if (current.status !== "running") return current.status;
			const started = await this.waitForNativeTurnStarted(
				this.modelConversationKey(codexConversationKey(session)),
				session.threadId,
				execution.nativeTurnId,
			);
			if (!started) {
				const completed = ownRecordValue(
					this.session(session.nativeSessionRef).executions,
					execution.executionId,
				);
				if (completed?.status && completed.status !== "running")
					return completed.status;
				unavailable();
			}
			try {
				return await this.readNativeTurnStatusPage(
					session.nativeSessionRef,
					session.threadId,
					execution.nativeTurnId,
				);
			} catch (retryError) {
				if (!(retryError instanceof CodexHistoryNotMaterializedError)) {
					throw retryError;
				}
				const persistedSession = this.session(session.nativeSessionRef);
				if (persistedSession.threadId !== session.threadId) stateInvalid();
				const persistedExecution = ownRecordValue(
					persistedSession.executions,
					execution.executionId,
				);
				if (!persistedExecution) unavailable();
				if (persistedExecution.nativeTurnId !== execution.nativeTurnId) {
					stateInvalid();
				}
				if (persistedExecution.status === "running") protocolInvalid();
				return persistedExecution.status;
			}
		}
	}

	private canReadLiveTurnHistory(
		session: CodexSession,
		execution: CodexExecution,
	) {
		return (
			session.historyMode === "paginated" &&
			session.activeExecutionId === execution.executionId &&
			Object.keys(session.executions).length === 1
		);
	}

	private async readNativeTurnStatusPage(
		nativeSessionRef: string,
		threadId: string,
		nativeTurnId: string,
	) {
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		for (let page = 0; page < maximumTurnsListPages; page += 1) {
			const result = await (await this.rpc(nativeSessionRef)).request(
				"thread/turns/list",
				{
					threadId,
					itemsView: "notLoaded",
					limit: turnsListPageSize,
					...(cursor === undefined ? {} : { cursor }),
				},
				(value) => this.statusFromTurnsList(value, nativeTurnId),
				false,
				page === 0,
			);
			if (result.status !== undefined) return result.status;
			if (result.nextCursor === undefined) unavailable();
			if (seenCursors.has(result.nextCursor)) protocolInvalid();
			seenCursors.add(result.nextCursor);
			cursor = result.nextCursor;
		}
		unavailable();
	}

	private async waitForNativeTurnStarted(
		conversationKey: string | undefined,
		threadId: string,
		nativeTurnId: string,
		deadline = Date.now() + rpcRequestTimeoutMs,
	) {
		const key = this.nativeTurnKey(conversationKey, threadId, nativeTurnId);
		if (this.observedNativeTurnStarts.has(key)) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let wake: () => void = () => undefined;
		try {
			await new Promise<void>((resolve) => {
				wake = resolve;
				const waiters = this.nativeTurnStartWaiters.get(key) ?? new Set();
				this.nativeTurnStartWaiters.set(key, waiters);
				if (this.observedNativeTurnStarts.has(key)) {
					resolve();
					return;
				}
				waiters.add(wake);
				timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
			});
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			const waiters = this.nativeTurnStartWaiters.get(key);
			if (waiters) {
				waiters.delete(wake);
				if (waiters.size === 0) this.nativeTurnStartWaiters.delete(key);
			}
		}
		if (this.observedNativeTurnStarts.has(key)) return true;
		return false;
	}

	private statusFromTurnsList(value: unknown, nativeTurnId: string) {
		if (!isPlainRecord(value) || !Array.isArray(value.data)) protocolInvalid();
		let status: PersistedTurnStatus | undefined;
		for (const turn of value.data) {
			if (
				!isPlainRecord(turn) ||
				!nonEmptyString(turn.id) ||
				!Array.isArray(turn.items)
			) {
				protocolInvalid();
			}
			const turnStatus = statusForTurn(turn.status);
			if (turn.id !== nativeTurnId) continue;
			if (status !== undefined) protocolInvalid();
			status = turnStatus;
		}
		if (value.nextCursor === undefined || value.nextCursor === null) {
			return { status, nextCursor: undefined };
		}
		if (!nonEmptyString(value.nextCursor)) protocolInvalid();
		return { status, nextCursor: value.nextCursor };
	}

	private async updateExecutionStatus(
		nativeSessionRef: string,
		executionId: string,
		nativeTurnId: string,
		status: PersistedTurnStatus,
		cancelNative = true,
	) {
		if (status !== "running" && cancelNative) {
			const session = this.session(nativeSessionRef);
			if (session.threadId)
				await this.cancelModelTurn?.({
					conversationKey: this.modelConversationKey(
						codexConversationKey(session),
					),
					threadId: session.threadId,
					turnId: nativeTurnId,
				});
		}
		const result = await this.update((state) => {
			const session = ownRecordValue(state.sessions, nativeSessionRef);
			if (!session) stateInvalid();
			const before = ownRecordValue(session.journals ?? {}, nativeTurnId)
				?.events.length;
			const persistedStatus = this.setExecutionStatus(
				state,
				nativeSessionRef,
				executionId,
				nativeTurnId,
				status,
			);
			const after = ownRecordValue(session.journals ?? {}, nativeTurnId)?.events
				.length;
			return {
				persistedStatus,
				appended: after !== undefined && after !== before,
			};
		});
		if (result.appended) {
			this.notifyEventStream(
				this.eventStreamKey(nativeSessionRef, executionId),
			);
		}
		return result.persistedStatus;
	}

	private setExecutionStatus(
		state: CodexDriverState,
		nativeSessionRef: string,
		executionId: string,
		nativeTurnId: string,
		status: PersistedTurnStatus,
	) {
		const session = ownRecordValue(state.sessions, nativeSessionRef);
		const execution = session
			? ownRecordValue(session.executions, executionId)
			: undefined;
		if (!session || !execution || execution.nativeTurnId !== nativeTurnId) {
			stateInvalid();
		}
		const operation = ownRecordValue(
			state.operations,
			operationKey({
				agentId: session.agentId,
				conversationId: session.conversationId,
				sessionGeneration: session.sessionGeneration,
				kind: "submit-turn",
				operationId: executionId,
			}),
		);
		if (!operation?.record) stateInvalid();
		if (operation.record.result.outcome !== "accepted") stateInvalid();
		if (execution.status !== "running") {
			if (status !== execution.status) protocolInvalid();
			this.appendCompletedEvent(
				session,
				this.ensureJournal(session, nativeTurnId),
				execution.status,
			);
			return execution.status;
		}
		if (
			status === "running" &&
			session.activeExecutionId !== undefined &&
			session.activeExecutionId !== executionId
		) {
			stateInvalid();
		}
		const journal = this.ensureJournal(session, nativeTurnId);
		if (status !== "running") {
			this.appendCompletedEvent(session, journal, status);
			if (!journal.events.some((event) => event.type === "completed"))
				return execution.status;
		} else if (journal.nativeCompletionStatus) {
			// A repeated status query cannot reopen an inference Turn whose
			// background effects are still being observed through native callbacks.
			return execution.status;
		}
		execution.status = status;
		if (status === "running") {
			session.activeExecutionId = executionId;
		} else if (session.activeExecutionId === executionId) {
			session.activeExecutionId = undefined;
		}
		operation.record.result = {
			outcome: "accepted",
			status: execution.status,
		};
		if (execution.status !== "running") {
			this.appendCompletedEvent(
				session,
				this.ensureJournal(session, nativeTurnId),
				execution.status,
			);
		}
		return execution.status;
	}

	private operationSelection(operation: CodexOperation) {
		const model = operation.internalModel;
		const effort = operation.reasoningLevel;
		if (
			model === undefined ||
			effort === undefined ||
			![...this.modelOptions.values()].some(
				(option) =>
					option.internalModel === model &&
					option.reasoningLevels.includes(effort),
			)
		)
			return undefined;
		return { model, effort };
	}

	private canReplaySubmitOperation(operation: CodexOperation) {
		return (
			operation.record?.result.outcome !== "accepted" ||
			operation.record.result.status !== "running" ||
			(operation.configVersion === this.configVersion &&
				this.operationSelection(operation) !== undefined)
		);
	}

	private async prepare(command: CodexSubmitTurnCommand) {
		return this.update((state) => {
			const key = operationKey(command);
			const existing = ownRecordValue(state.operations, key);
			if (existing) {
				if (!operationMatchesCommand(existing, command)) stateInvalid();
				return { operation: existing, created: false };
			}
			const matchingSessions = command.nativeSessionRef
				? []
				: Object.entries(state.sessions).filter(
						([, candidate]) =>
							candidate.agentId === command.agentId &&
							candidate.conversationId === command.conversationId &&
							candidate.sessionGeneration === command.sessionGeneration,
					);
			if (matchingSessions.length > 1) stateInvalid();
			const nativeSessionRef =
				command.nativeSessionRef ?? matchingSessions[0]?.[0] ?? randomUUID();
			const session = ownRecordValue(state.sessions, nativeSessionRef);
			if (session) {
				if (
					session.agentId !== command.agentId ||
					session.conversationId !== command.conversationId ||
					session.sessionGeneration !== command.sessionGeneration
				) {
					protocolInvalid();
				}
				if (
					session.acceptanceUncertainOperationKey !== undefined ||
					Object.values(state.operations).some(
						(operation) =>
							operation.nativeSessionRef === nativeSessionRef &&
							operation.state === "prepared",
					)
				) {
					unavailable();
				}
				if (session.activeExecutionId !== undefined) {
					const activeExecution = ownRecordValue(
						session.executions,
						session.activeExecutionId,
					);
					if (!activeExecution) stateInvalid();
					this.assertExecutionConfiguration(state, session, activeExecution);
				}
			} else if (command.nativeSessionRef) {
				unavailable();
			} else {
				state.sessions[nativeSessionRef] = {
					nativeSessionRef,
					agentId: command.agentId,
					conversationId: command.conversationId,
					sessionGeneration: command.sessionGeneration,
					executions: {},
				};
			}
			const selection =
				command.schemaVersion === 2
					? this.nativeSelection(command.selection)
					: this.defaultSelection;
			const operation: CodexOperation = {
				schemaVersion: command.schemaVersion,
				state: "prepared",
				nativeSessionRef,
				configVersion: this.configVersion,
				internalModel: selection?.model,
				reasoningLevel: selection?.effort,
			};
			// Persist deterministic local refusal atomically with the operation;
			// a crash must not leave a never-submitted request acceptance-uncertain.
			if (
				command.schemaVersion === 2 &&
				operation.internalModel === undefined
			) {
				operation.state = "resolved";
				operation.record = driverRecord(command, {
					schemaVersion: command.schemaVersion,
					agentId: command.agentId,
					conversationId: command.conversationId,
					sessionGeneration: command.sessionGeneration,
					kind: command.kind,
					operationId: command.operationId,
					nativeSessionRef,
					result: {
						outcome: "rejected",
						code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
						message: "Runtime model selection is unsupported",
						retryable: false,
					},
				});
			}
			state.operations[key] = operation;
			return { operation, created: true };
		});
	}

	private async prepareInterruption(command: CodexInterruptionCommand) {
		return this.update((state) => {
			const key = operationKey(command);
			const existing = ownRecordValue(state.operations, key);
			if (existing) {
				if (!operationMatchesCommand(existing, command)) stateInvalid();
				return { operation: existing, created: false };
			}
			const session = ownRecordValue(state.sessions, command.nativeSessionRef);
			if (
				!session ||
				session.agentId !== command.agentId ||
				session.conversationId !== command.conversationId ||
				session.sessionGeneration !== command.sessionGeneration ||
				!session.threadId
			) {
				unavailable();
			}
			const execution = ownRecordValue(session.executions, command.executionId);
			if (!execution || execution.turnId !== command.turnId) unavailable();
			this.assertOriginalRecoveryConfiguration(state, session, execution);
			const operation: CodexOperation = {
				schemaVersion: 1,
				state: "prepared",
				nativeSessionRef: command.nativeSessionRef,
				executionId: command.executionId,
				turnId: command.turnId,
			};
			state.operations[key] = operation;
			this.abortConnectionRecoveries(
				command.nativeSessionRef,
				command.kind === "stop" ? command.executionId : undefined,
			);
			return { operation, created: true };
		});
	}

	private interruptionNativeTurn(
		nativeSessionRef: string,
		command: CodexInterruptionCommand,
	) {
		const state = this.readState();
		const session = ownRecordValue(state.sessions, nativeSessionRef);
		if (!session) unavailable();
		const execution = ownRecordValue(session.executions, command.executionId);
		if (
			!session.threadId ||
			!execution ||
			execution.turnId !== command.turnId
		) {
			unavailable();
		}
		this.assertOriginalRecoveryConfiguration(state, session, execution);
		return {
			conversationKey: this.modelConversationKey(codexConversationKey(session)),
			threadId: session.threadId,
			turnId: execution.nativeTurnId,
		};
	}

	private pendingModelTurn(
		command: CodexSubmitTurnCommand,
		nativeSessionRef: string,
	) {
		const session = this.session(nativeSessionRef);
		if (!session.threadId) return undefined;
		const pending = Object.values(session.journals ?? {}).filter(
			(journal) => journal.pendingOperationKey === operationKey(command),
		);
		if (pending.length > 1) stateInvalid();
		const journal = pending[0];
		return journal
			? {
					conversationKey: this.modelConversationKey(
						codexConversationKey(session),
					),
					threadId: session.threadId,
					turnId: journal.nativeTurnId,
				}
			: undefined;
	}

	private operationRecord(command: CodexSubmitTurnCommand) {
		return ownRecordValue(this.readState().operations, operationKey(command));
	}

	private hasPendingModelAdmission(command: CodexSubmitTurnCommand) {
		const operation = this.operationRecord(command);
		return (
			operation?.admissionPending === true ||
			operation?.admissionRecoveryPending === true
		);
	}

	private hasInterruption(
		nativeSessionRef: string,
		executionId: string,
		state = this.readState(),
	) {
		return Object.values(state.operations).some(
			(operation) =>
				operation.nativeSessionRef === nativeSessionRef &&
				operation.executionId === executionId &&
				operation.turnId !== undefined,
		);
	}

	private async confirmModelAdmission(
		command: CodexSubmitTurnCommand,
		nativeSessionRef: string,
		recoveryPending = false,
	) {
		const confirmation = this.update((state) => {
			const operation = ownRecordValue(state.operations, operationKey(command));
			if (
				operation?.state !== "resolved" ||
				operation.nativeSessionRef !== nativeSessionRef ||
				operation.record?.result.outcome !== "accepted" ||
				(operation.admissionPending !== true &&
					operation.admissionRecoveryPending !== true)
			) {
				stateInvalid();
			}
			delete operation.admissionPending;
			delete operation.admissionRecoveryPending;
			if (recoveryPending) operation.admissionRecoveryPending = true;
		});
		if (!recoveryPending) {
			const key = operationKey(command);
			const confirmationResult = confirmation.then(
				() => true,
				() => false,
			);
			this.finalModelAdmissionConfirmations.set(key, confirmationResult);
			try {
				await confirmation;
			} finally {
				if (
					this.finalModelAdmissionConfirmations.get(key) === confirmationResult
				)
					this.finalModelAdmissionConfirmations.delete(key);
			}
			return;
		}
		await confirmation;
	}

	private async markAcceptanceUncertain(
		command: CodexSubmitTurnCommand,
		nativeSessionRef: string,
	) {
		const key = operationKey(command);
		await this.update((state) => {
			const session = ownRecordValue(state.sessions, nativeSessionRef);
			const operation = ownRecordValue(state.operations, key);
			if (
				!session ||
				!operation ||
				operation.nativeSessionRef !== nativeSessionRef ||
				operation.state !== "prepared" ||
				(session.acceptanceUncertainOperationKey !== undefined &&
					session.acceptanceUncertainOperationKey !== key)
			) {
				stateInvalid();
			}
			session.acceptanceUncertainOperationKey = key;
		});
	}

	private async discardPreparedResume(
		command: CodexSubmitTurnCommand,
		nativeSessionRef: string,
	) {
		const key = operationKey(command);
		await this.update((state) => {
			const session = ownRecordValue(state.sessions, nativeSessionRef);
			const operation = ownRecordValue(state.operations, key);
			if (
				!session?.threadId ||
				!operation ||
				operation.nativeSessionRef !== nativeSessionRef ||
				operation.state !== "prepared" ||
				session.acceptanceUncertainOperationKey !== undefined
			) {
				stateInvalid();
			}
			delete state.operations[key];
		});
	}

	private session(nativeSessionRef: string) {
		const session = ownRecordValue(this.readState().sessions, nativeSessionRef);
		if (!session) unavailable();
		return session;
	}

	private async ensureThread(nativeSessionRef: string) {
		const session = this.session(nativeSessionRef);
		if (session.threadId) {
			await this.resumeSession(nativeSessionRef);
			return this.session(nativeSessionRef);
		}
		const threadId = await (await this.rpc(nativeSessionRef)).request(
			"thread/start",
			{ historyMode: "paginated" },
			(value) => {
				const thread = isPlainRecord(value) ? value.thread : undefined;
				if (
					!isPlainRecord(thread) ||
					typeof thread.id !== "string" ||
					thread.id.length === 0
				) {
					protocolInvalid();
				}
				return thread.id;
			},
		);
		await this.update((state) => {
			const stored = ownRecordValue(state.sessions, nativeSessionRef);
			if (!stored || stored.threadId) protocolInvalid();
			if (
				Object.entries(state.sessions).some(
					([candidateRef, candidate]) =>
						candidateRef !== nativeSessionRef &&
						candidate.threadId === threadId,
				)
			) {
				protocolInvalid();
			}
			stored.threadId = threadId;
			stored.historyMode = "paginated";
		});
		this.resumedSessions.add(nativeSessionRef);
		return this.session(nativeSessionRef);
	}

	private async resumeSession(nativeSessionRef: string) {
		if (this.resumedSessions.has(nativeSessionRef)) return;
		const inFlight = this.inFlightSessionResumes.get(nativeSessionRef);
		if (inFlight) return inFlight;
		const resume = this.resumeSessionOnce(nativeSessionRef);
		this.inFlightSessionResumes.set(nativeSessionRef, resume);
		try {
			await resume;
		} finally {
			if (this.inFlightSessionResumes.get(nativeSessionRef) === resume) {
				this.inFlightSessionResumes.delete(nativeSessionRef);
			}
		}
	}

	private async resumeSessionOnce(nativeSessionRef: string) {
		const session = this.session(nativeSessionRef);
		if (!session.threadId) unavailable();
		await (await this.rpc(nativeSessionRef)).request(
			"thread/resume",
			{ threadId: session.threadId, excludeTurns: true },
			(value) => {
				const thread = isPlainRecord(value) ? value.thread : undefined;
				if (!isPlainRecord(thread) || thread.id !== session.threadId) {
					protocolInvalid();
				}
			},
		);
		this.resumedSessions.add(nativeSessionRef);
	}

	private async resolve(
		command: CodexSubmitTurnCommand,
		nativeSessionRef: string,
		result: RuntimeDriverOperationRecord["result"],
		nativeTurnId?: string,
		admissionPending = false,
	) {
		let record = driverRecord(command, {
			schemaVersion: command.schemaVersion,
			agentId: command.agentId,
			conversationId: command.conversationId,
			sessionGeneration: command.sessionGeneration,
			kind: command.kind,
			operationId: command.operationId,
			nativeSessionRef,
			result,
		});
		await this.update((state) => {
			const operation = ownRecordValue(state.operations, operationKey(command));
			const session = ownRecordValue(state.sessions, nativeSessionRef);
			if (!operation || !session) protocolInvalid();
			if (result.outcome !== "accepted") {
				if (admissionPending) protocolInvalid();
				operation.state = "resolved";
				operation.record = record;
				return;
			}
			if (!nativeTurnId) protocolInvalid();
			if (
				Object.values(session.executions).some(
					(execution) => execution.nativeTurnId === nativeTurnId,
				)
			) {
				protocolInvalid();
			}
			const journal = this.ensureJournal(
				session,
				nativeTurnId,
				operationKey(command),
			);
			if (journal.pendingOperationKey !== operationKey(command)) stateInvalid();
			delete journal.pendingOperationKey;
			const terminalEvent = journal.events.find(
				(event): event is CodexJournalCompletedEvent =>
					event.type === "completed",
			);
			const status = terminalEvent?.payload.status ?? result.status;
			if (
				terminalEvent &&
				result.status !== "running" &&
				result.status !== terminalEvent.payload.status
			) {
				protocolInvalid();
			}
			if (status === "running") {
				this.appendStatusEvent(session, journal);
			} else if (
				status === "completed" ||
				status === "failed" ||
				status === "cancelled"
			) {
				this.appendCompletedEvent(session, journal, status);
			} else {
				protocolInvalid();
			}
			record = { ...record, result: { outcome: "accepted", status } };
			operation.state = "resolved";
			operation.record = record;
			if (admissionPending && status === "running") {
				operation.admissionPending = true;
			}
			Object.defineProperty(session.executions, command.executionId, {
				value: {
					executionId: command.executionId,
					turnId: command.turnId,
					nativeTurnId,
					status,
				},
				enumerable: true,
				writable: true,
				configurable: true,
			});
			session.activeExecutionId =
				status === "running" ? command.executionId : undefined;
		});
		if (result.outcome === "accepted") {
			this.recoveredEventExecutions.add(
				this.eventStreamKey(nativeSessionRef, command.executionId),
			);
		}
		return record;
	}

	private async resolveInterruption(
		command: CodexInterruptionCommand,
		nativeSessionRef: string,
		status: PersistedTurnStatus,
	) {
		if (command.kind === "generation-cancel")
			await this.drainConnectionRecoveries(nativeSessionRef);
		const record: RuntimeDriverOperationRecordV1 = {
			schemaVersion: 1,
			agentId: command.agentId,
			conversationId: command.conversationId,
			sessionGeneration: command.sessionGeneration,
			kind: command.kind,
			operationId: command.operationId,
			nativeSessionRef,
			result: { outcome: "accepted", status },
		};
		const resolved = await this.update((state) => {
			const operation = ownRecordValue(state.operations, operationKey(command));
			if (!operation || !operationMatchesCommand(operation, command)) {
				stateInvalid();
			}
			if (operation.state === "resolved") {
				if (!operation.record) stateInvalid();
				return operation.record;
			}
			if (operation.state !== "prepared") stateInvalid();
			operation.state = "resolved";
			operation.record = record;
			return record;
		});
		if (command.kind === "generation-cancel" && status !== "running") {
			this.notifyEventStream(
				this.eventStreamKey(nativeSessionRef, command.executionId),
			);
		}
		return resolved;
	}

	private unknown(command: RuntimeDriverCommand, nativeSessionRef: string) {
		return driverRecord(command, {
			schemaVersion: command.schemaVersion,
			agentId: command.agentId,
			conversationId: command.conversationId,
			sessionGeneration: command.sessionGeneration,
			kind: command.kind,
			operationId: command.operationId,
			nativeSessionRef,
			result: {
				outcome: "unknown" as const,
				code: "RUNTIME_ACCEPTANCE_UNKNOWN" as const,
				message: "Runtime command acceptance could not be confirmed" as const,
			},
		});
	}
}
