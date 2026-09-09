import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
	RuntimeCapabilitiesV1,
	RuntimeDriverOperationRecordV1,
	RuntimeEventV1,
	RuntimeSelectionV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";
import {
	RuntimeDriverOperationRecordV1Schema,
	RuntimeDriverSubmitTurnOperationRecordV2Schema,
} from "@agent-infra/contracts/runtime";

import {
	CODEX_APP_SERVER_V2_PROVENANCE,
	CodexAppServerBridge,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
	type CodexModelAccess,
	validateModelAccess,
} from "./codex-app-server-bridge.js";
import {
	type CodexModelRoute,
	type CodexModelTurnAdmission,
	type CodexNativeTurn,
	openCodexModelTransport,
} from "./codex-model-transport.js";
import type {
	RuntimeDriver,
	RuntimeDriverCommand,
	RuntimeDriverLookup,
	RuntimeDriverOperationRecord,
} from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";

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
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly modelOptions: readonly CodexRuntimeModelOption[];
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

type CodexJournalEvent =
	| CodexJournalStatusEvent
	| CodexJournalTextEvent
	| CodexJournalCompletedEvent;

interface CodexEventJournal {
	nativeTurnId: string;
	pendingOperationKey?: string;
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
	// Recovery must not expose or re-register the accepted record until this clears.
	admissionPending?: true;
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
		hasOnlyKeys(value, ["nativeTurnId", "pendingOperationKey", "events"]) &&
		value.nativeTurnId === nativeTurnId &&
		(value.pendingOperationKey === undefined ||
			nonEmptyString(value.pendingOperationKey)) &&
		Array.isArray(value.events) &&
		value.events.every(isCodexJournalEvent)
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
	let eventCount = 0;
	for (const journal of Object.values(journals)) {
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
			"admissionPending",
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
		return value.admissionPending === undefined && value.record === undefined;
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
			record.data.result.outcome !== "unknown"
		);
	}
	if (isInterruption) return value.admissionPending === undefined;
	if (value.admissionPending !== undefined && value.admissionPending !== true) {
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
			if (
				completedEvents.length > 1 ||
				(completedEvent !== undefined &&
					journal.events.at(-1) !== completedEvent)
			) {
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
		modelAccess?: CodexModelAccess;
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
		if (!isEmptyRecord(value.config[key])) configurationInvalid();
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
		profiles.push(...result.profiles);
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
	private readonly modelAdmissionDeadlines = new Map<string, number>();
	private readonly modelTurnAdmissions = new Map<
		string,
		CodexModelTurnAdmission
	>();
	private readonly inFlightOperations = new Map<
		string,
		Promise<RuntimeDriverOperationRecord>
	>();

	protected constructor(
		private readonly file: DurableJsonFile<CodexDriverState>,
		bridge: CodexAppServerTransport,
		private readonly modelOptions: ReadonlyMap<
			string,
			ConfiguredCodexRuntimeModelOption
		>,
		private readonly defaultSelection: { model: string; effort: string },
		private readonly configVersion: string,
		private readonly beginModelTurnAdmission?: (
			deadline: number,
			internalModel: string,
		) => CodexModelTurnAdmission,
		private readonly recognizeModelTurn?: (
			admission: CodexModelTurnAdmission,
			turn: CodexNativeTurn,
		) => boolean,
		private readonly registerModelTurn?: (
			admission: CodexModelTurnAdmission,
			turn: CodexNativeTurn,
		) => boolean,
		private readonly abandonModelTurnAdmission?: (
			admission: CodexModelTurnAdmission,
		) => void,
		private readonly cancelModelTurn?: (turn: CodexNativeTurn) => Promise<void>,
	) {
		this.rpc = new CodexRpc(bridge, (frame) => this.recordNotification(frame));
	}

	private readonly rpc: CodexRpc;

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

	protected static async openWithBridge(
		options: CodexRuntimeDriverOptions,
		openBridge: OpenCodexBridge,
	) {
		const {
			configured: modelOptions,
			defaultSelection,
			routes,
		} = configuredModelOptions(options);
		const file = await CodexRuntimeDriver.openState(options.path);
		const modelTransport =
			routes.length > 0 ? await openCodexModelTransport(routes) : undefined;
		const containedConfiguration = {
			model: defaultSelection.model,
			reasoningEffort: defaultSelection.effort,
			...(modelTransport ? { modelAccess: modelTransport.modelAccess } : {}),
		};
		let nativeBridge: CodexAppServerTransport;
		try {
			nativeBridge = await openBridge({
				dataDirectory: `${options.path}.native`,
				model: defaultSelection.model,
				reasoningEffort: defaultSelection.effort,
				provenance: CODEX_APP_SERVER_V2_PROVENANCE,
				...(containedConfiguration.modelAccess
					? { modelAccess: containedConfiguration.modelAccess }
					: {}),
			});
		} catch {
			await modelTransport?.close();
			unavailable();
		}
		let closePromise: Promise<void> | undefined;
		const bridge: CodexAppServerTransport = modelTransport
			? {
					send: (frame) => nativeBridge.send(frame),
					frames: () => nativeBridge.frames(),
					close: () => {
						closePromise ??= (async () => {
							const results = await Promise.allSettled([
								nativeBridge.close?.(),
								modelTransport.close(),
							]);
							const rejected = results.find(
								(result) => result.status === "rejected",
							);
							if (rejected?.status === "rejected") throw rejected.reason;
						})();
						return closePromise;
					},
				}
			: nativeBridge;
		const driver = new CodexRuntimeDriver(
			file,
			bridge,
			modelOptions,
			defaultSelection,
			options.configVersion,
			modelTransport?.beginTurnAdmission,
			modelTransport?.recognizeTurn,
			modelTransport?.registerTurn,
			modelTransport?.abandonTurnAdmission,
			modelTransport?.cancelTurn,
		);
		try {
			await driver.rpc.request(
				"initialize",
				{
					clientInfo: { name: "agent-infra-runtime", version: "1" },
					capabilities: { experimentalApi: true },
				},
				(value) => {
					if (!isPlainRecord(value)) protocolInvalid();
				},
			);
			await driver.rpc.request(
				"config/read",
				{ includeLayers: false },
				(value) => {
					assertContainedConfiguration(value, containedConfiguration);
				},
			);
			if (modelTransport) {
				await assertPinnedModelProfiles(driver.rpc, modelOptions);
			}
			return driver;
		} catch (error) {
			await driver.close();
			if (error instanceof RuntimeHostError) throw error;
			unavailable();
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

	private async executeSubmitTurn(command: CodexSubmitTurnCommand) {
		if (command.input.attachments.length > 0) unavailable();
		if (command.operationId !== command.executionId) stateInvalid();
		const text = "text" in command.input ? command.input.text : undefined;
		if (!text) unavailable();
		const prepared = await this.prepare(command);
		if (prepared.operation.record) {
			if (
				prepared.operation.admissionPending ||
				!this.canReplaySubmitOperation(prepared.operation)
			)
				unavailable();
			return prepared.operation.record;
		}
		if (!prepared.created) {
			return this.unknown(command, prepared.operation.nativeSessionRef);
		}
		const nativeSelection =
			command.schemaVersion === 2
				? this.nativeSelection(command.selection)
				: this.defaultSelection;
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
		let candidateModelTurn: CodexNativeTurn | undefined;
		try {
			const turn = await this.rpc.request(
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
			if (
				Date.now() >= admissionDeadline ||
				(this.registerModelTurn !== undefined &&
					(!modelAdmission ||
						this.registerModelTurn(modelAdmission, nativeTurn) === false))
			) {
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
			if (modelAdmission) this.modelTurnAdmissions.delete(admissionKey);
			await this.confirmModelAdmission(command, session.nativeSessionRef);
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
				const key = this.nativeTurnKey(turn.threadId, turn.turnId);
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
			if (!this.hasPendingModelAdmission(command)) {
				await this.markAcceptanceUncertain(command, session.nativeSessionRef);
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
		if (prepared.operation.record) return prepared.operation.record;
		if (!prepared.created) {
			return this.unknown(command, prepared.operation.nativeSessionRef);
		}
		const nativeTurn = this.interruptionNativeTurn(
			prepared.operation.nativeSessionRef,
			command,
		);
		await this.cancelModelTurn?.(nativeTurn);
		let status = await this.getStatus(
			prepared.operation.nativeSessionRef,
			command.executionId,
		);
		if (status === "running") {
			try {
				await this.rpc.request("turn/interrupt", nativeTurn, (value) => {
					if (!isEmptyRecord(value)) protocolInvalid();
				});
			} finally {
				await this.cancelModelTurn?.(nativeTurn);
			}
			status = await this.getStatus(
				prepared.operation.nativeSessionRef,
				command.executionId,
			);
		} else {
			await this.cancelModelTurn?.(nativeTurn);
		}
		return this.resolveInterruption(
			command,
			prepared.operation.nativeSessionRef,
			status,
		);
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
		if (operation.admissionPending) return { state: "unknown" };
		if (
			command.kind === "submit-turn" &&
			!this.canReplaySubmitOperation(operation)
		)
			return { state: "unknown" };
		if (operation.record) return { state: "found", record: operation.record };
		if (!isCodexInterruptionCommand(command)) return { state: "unknown" };
		await this.cancelModelTurn?.(
			this.interruptionNativeTurn(operation.nativeSessionRef, command),
		);
		const status = await this.getStatus(
			operation.nativeSessionRef,
			command.executionId,
		);
		if (status === "running") return { state: "unknown" };
		await this.cancelModelTurn?.(
			this.interruptionNativeTurn(operation.nativeSessionRef, command),
		);
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
		return this.restoreExecutionStatus(nativeSessionRef, executionId);
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
		if (execution.status !== "running") {
			if (
				!this.executionConfigurationMatches(initialState, session, execution)
			) {
				return execution.status;
			}
			await this.cancelModelTurn?.({
				threadId: session.threadId,
				turnId: execution.nativeTurnId,
			});
			return execution.status;
		}
		this.assertExecutionConfiguration(initialState, session, execution);
		const nativeTurn = {
			threadId: session.threadId,
			turnId: execution.nativeTurnId,
		};
		const restoreRequired =
			!this.hasInterruption(nativeSessionRef, executionId) &&
			this.beginModelTurnAdmission !== undefined &&
			this.recognizeModelTurn !== undefined &&
			this.registerModelTurn !== undefined;
		let restoreAdmission: CodexModelTurnAdmission | undefined;
		if (restoreRequired) {
			const internalModel = this.executionOperation(
				initialState,
				session,
				execution,
			).internalModel;
			if (
				!internalModel ||
				![...this.modelOptions.values()].some(
					(option) => option.internalModel === internalModel,
				)
			)
				unavailable();
			restoreAdmission = this.beginModelTurnAdmission?.(
				Date.now() + rpcRequestTimeoutMs,
				internalModel,
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
					threadId: session.threadId,
					turnId: execution.nativeTurnId,
				});
				if (recoverEventHistory) {
					const items = await this.readNativeAgentMessageItems(
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
				restoreRequired &&
				(!restoreAdmission ||
					this.hasInterruption(nativeSessionRef, executionId) ||
					this.registerModelTurn?.(restoreAdmission, nativeTurn) !== true)
			) {
				unavailable();
			}
			return persistedStatus;
		} finally {
			if (restoreAdmission) {
				this.abandonModelTurnAdmission?.(restoreAdmission);
			}
		}
	}

	async getCapabilities() {
		return capabilities;
	}

	async replayEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
	): Promise<RuntimeEventV1[]> {
		const existingSession = this.session(nativeSessionRef);
		const existingExecution = ownRecordValue(
			existingSession.executions,
			executionId,
		);
		if (!existingExecution) unavailable();
		this.assertModelAdmissionConfirmed(existingSession, existingExecution);
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

	async subscribeEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
		signal?: AbortSignal,
	): Promise<AsyncIterable<RuntimeEventV1>> {
		const driver = this;
		const key = this.eventStreamKey(nativeSessionRef, executionId);
		const initialWaiter = this.waitForEvent(key, signal);
		let initialEvents: RuntimeEventV1[];
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
							if (event.type === "completed") return;
						}
						pending = [];
					}
					if (
						driver.isExecutionTerminal(nativeSessionRef, executionId) &&
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

	async close() {
		await this.rpc.close();
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
		if (operation?.admissionPending) unavailable();
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
		return (
			this.executionOperation(state, session, execution).configVersion ===
			this.configVersion
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

	private update<R>(change: (state: CodexDriverState) => R) {
		return this.file.update((state) => {
			assertDriverState(state);
			const result = change(state);
			assertDriverState(state);
			return result;
		});
	}

	private async recordNotification(frame: CodexAppServerFrame) {
		const started = turnStartedNotification(frame);
		if (started) {
			const recorded = await this.update((state) => {
				const resolved = this.resolveNotificationJournal(
					state,
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
			if (admissionDeadline !== undefined && modelAdmission !== undefined) {
				this.recognizeModelTurn?.(modelAdmission, {
					threadId: started.threadId,
					turnId: started.nativeTurnId,
				});
			}
			if (recorded) {
				this.recordNativeTurnStarted(started.threadId, started.nativeTurnId);
			}
			if (recorded?.streamKey) this.notifyEventStream(recorded.streamKey);
			return;
		}

		const completed = turnCompletedNotification(frame);
		if (completed) {
			let recognized = false;
			const streamKey = await this.update((state) => {
				const resolved = this.resolveNotificationJournal(
					state,
					completed.threadId,
					completed.nativeTurnId,
				);
				if (!resolved) return;
				recognized = true;
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
				completed.threadId,
				completed.nativeTurnId,
			);
			if (recognized) {
				await this.cancelModelTurn?.({
					threadId: completed.threadId,
					turnId: completed.nativeTurnId,
				});
			}
			if (streamKey) this.notifyEventStream(streamKey);
			return;
		}

		const delta = agentMessageDeltaNotification(frame);
		if (!delta || delta.delta.length === 0) return;
		const streamKey = await this.update((state) => {
			const resolved = this.resolveNotificationJournal(
				state,
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

	private resolveNotificationJournal(
		state: CodexDriverState,
		threadId: string,
		nativeTurnId: string,
	) {
		const matchingSessions = Object.entries(state.sessions).filter(
			([, session]) => session.threadId === threadId,
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

	private nativeTurnKey(threadId: string, nativeTurnId: string) {
		return JSON.stringify([threadId, nativeTurnId]);
	}

	private recordNativeTurnStarted(threadId: string, nativeTurnId: string) {
		const key = this.nativeTurnKey(threadId, nativeTurnId);
		this.observedNativeTurnStarts.add(key);
		for (const wake of this.nativeTurnStartWaiters.get(key) ?? []) wake();
		this.nativeTurnStartWaiters.delete(key);
	}

	private recordNativeTurnCompleted(threadId: string, nativeTurnId: string) {
		const key = this.nativeTurnKey(threadId, nativeTurnId);
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

	private async readNativeAgentMessageItems(
		threadId: string,
		nativeTurnId: string,
	) {
		const items: { nativeItemId: string; text: string }[] = [];
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		for (let page = 0; page < maximumItemsListPages; page += 1) {
			const result = await this.rpc.request(
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
		threadId: string,
		nativeTurnId: string,
	) {
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		for (let page = 0; page < maximumTurnsListPages; page += 1) {
			const result = await this.rpc.request(
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
		threadId: string,
		nativeTurnId: string,
		deadline = Date.now() + rpcRequestTimeoutMs,
	) {
		const key = this.nativeTurnKey(threadId, nativeTurnId);
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
	) {
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

	private canReplaySubmitOperation(operation: CodexOperation) {
		return (
			operation.record?.result.outcome !== "accepted" ||
			operation.record.result.status !== "running" ||
			(operation.configVersion === this.configVersion &&
				operation.internalModel !== undefined &&
				[...this.modelOptions.values()].some(
					(option) => option.internalModel === operation.internalModel,
				))
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
			const operation: CodexOperation = {
				schemaVersion: command.schemaVersion,
				state: "prepared",
				nativeSessionRef,
				configVersion: this.configVersion,
				internalModel: (command.schemaVersion === 2
					? this.nativeSelection(command.selection)
					: this.defaultSelection
				)?.model,
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
			this.assertExecutionConfiguration(state, session, execution);
			const operation: CodexOperation = {
				schemaVersion: 1,
				state: "prepared",
				nativeSessionRef: command.nativeSessionRef,
				executionId: command.executionId,
				turnId: command.turnId,
			};
			state.operations[key] = operation;
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
		this.assertExecutionConfiguration(state, session, execution);
		return {
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
			? { threadId: session.threadId, turnId: journal.nativeTurnId }
			: undefined;
	}

	private operationRecord(command: CodexSubmitTurnCommand) {
		return ownRecordValue(this.readState().operations, operationKey(command));
	}

	private hasPendingModelAdmission(command: CodexSubmitTurnCommand) {
		return this.operationRecord(command)?.admissionPending === true;
	}

	private hasInterruption(nativeSessionRef: string, executionId: string) {
		return Object.values(this.readState().operations).some(
			(operation) =>
				operation.nativeSessionRef === nativeSessionRef &&
				operation.executionId === executionId &&
				operation.turnId !== undefined,
		);
	}

	private async confirmModelAdmission(
		command: CodexSubmitTurnCommand,
		nativeSessionRef: string,
	) {
		await this.update((state) => {
			const operation = ownRecordValue(state.operations, operationKey(command));
			if (
				operation?.state !== "resolved" ||
				operation.nativeSessionRef !== nativeSessionRef ||
				operation.record?.result.outcome !== "accepted" ||
				operation.admissionPending !== true
			) {
				stateInvalid();
			}
			delete operation.admissionPending;
		});
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
		const threadId = await this.rpc.request(
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
		await this.rpc.request(
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
		return this.update((state) => {
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
