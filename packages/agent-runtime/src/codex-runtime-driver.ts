import { randomUUID } from "node:crypto";
import type {
	RuntimeCapabilitiesV1,
	RuntimeDriverCommandV1,
	RuntimeDriverOperationRecordV1,
	RuntimeEventV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";
import { RuntimeDriverOperationRecordV1Schema } from "@agent-infra/contracts/runtime";

import {
	CODEX_APP_SERVER_V2_PROVENANCE,
	CodexAppServerBridge,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import type { RuntimeDriver, RuntimeDriverLookup } from "./driver.js";
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
	readonly model: string;
	readonly reasoningEffort: string;
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
	activeExecutionId?: string;
	acceptanceUncertainOperationKey?: string;
	eventSequence?: number;
	journals?: Record<string, CodexEventJournal>;
	executions: Record<string, CodexExecution>;
}

interface CodexOperation {
	state: "prepared" | "resolved";
	nativeSessionRef: string;
	record?: RuntimeDriverOperationRecordV1;
}

interface CodexDriverState {
	schemaVersion: 1;
	sessions: Record<string, CodexSession>;
	operations: Record<string, CodexOperation>;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: RuntimeHostError) => void;
}

type CodexNotificationHandler = (frame: CodexAppServerFrame) => Promise<void>;

const capabilities: RuntimeCapabilitiesV1 = {
	modelSelection: true,
	attachments: false,
	resultFiles: false,
	connection: false,
	supplementaryInstruction: false,
};

const turnsListPageSize = 100;
const maximumTurnsListPages = 8;
const itemsListPageSize = 100;
const maximumItemsListPages = 8;
const rpcRequestTimeoutMs = 30_000;

const persistedTurnStatuses = [
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;

type PersistedTurnStatus = (typeof persistedTurnStatuses)[number];

function operationKey(
	command: Pick<
		RuntimeDriverCommandV1,
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
		!hasOnlyKeys(value, ["state", "nativeSessionRef", "record"]) ||
		!nonEmptyString(value.nativeSessionRef)
	) {
		return false;
	}
	const session = ownRecordValue(sessions, value.nativeSessionRef);
	if (!session) return false;
	if (value.state === "prepared") {
		if (value.record !== undefined) return false;
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
			kind !== "submit-turn" ||
			!nonEmptyString(operationId)
		) {
			return false;
		}
		return (
			operationKey({
				agentId: session.agentId,
				conversationId: session.conversationId,
				sessionGeneration: session.sessionGeneration,
				kind: "submit-turn",
				operationId,
			}) === key
		);
	}
	if (value.state !== "resolved" || value.record === undefined) return false;
	const record = RuntimeDriverOperationRecordV1Schema.safeParse(value.record);
	if (
		!record.success ||
		record.data.kind !== "submit-turn" ||
		record.data.nativeSessionRef !== value.nativeSessionRef ||
		record.data.agentId !== session.agentId ||
		record.data.conversationId !== session.conversationId ||
		record.data.sessionGeneration !== session.sessionGeneration ||
		operationKey(record.data) !== key
	) {
		return false;
	}
	if (record.data.result.outcome !== "accepted") {
		return record.data.result.outcome !== "unknown";
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
			const execution = Object.values(session.executions).find(
				(candidate) => candidate.nativeTurnId === nativeTurnId,
			);
			if (execution) {
				if (journal.pendingOperationKey !== undefined) stateInvalid();
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
	);
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

function stateInvalid(): never {
	throw new RuntimeHostError(
		"RUNTIME_CODEX_STATE_INVALID",
		"Codex Runtime session state is unavailable",
		503,
	);
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
	private nextRequestId = 1;
	private failed = false;

	constructor(
		private readonly bridge: CodexAppServerTransport,
		private readonly onNotification: CodexNotificationHandler,
	) {
		void this.consume();
	}

	async request<T>(
		method: string,
		params: Record<string, unknown>,
		parse: (value: unknown) => T,
	) {
		if (this.failed) unavailable();
		const id = this.nextRequestId++;
		const response = new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(parse(value)),
				reject,
			});
		});
		void response.catch(() => {});
		const timeoutError = unavailableError();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				this.fail(timeoutError);
				reject(timeoutError);
			}, rpcRequestTimeoutMs);
		});
		try {
			await Promise.race([this.bridge.send({ id, method, params }), deadline]);
			return await Promise.race([response, deadline]);
		} catch (error) {
			this.pending.delete(id);
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
		if (typeof frame.id !== "number" || !Number.isSafeInteger(frame.id)) {
			this.fail(protocolInvalidError());
			return;
		}
		const pending = this.pending.get(frame.id);
		if (!pending) {
			this.fail(protocolInvalidError());
			return;
		}
		if ("error" in frame || !("result" in frame)) {
			this.fail(protocolInvalidError());
			return;
		}
		try {
			pending.resolve(frame.result);
		} catch {
			this.fail(protocolInvalidError());
			return;
		}
		this.pending.delete(frame.id);
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
	private readonly inFlightExecutions = new Map<
		string,
		Promise<RuntimeDriverOperationRecordV1>
	>();

	protected constructor(
		private readonly file: DurableJsonFile<CodexDriverState>,
		bridge: CodexAppServerTransport,
	) {
		this.rpc = new CodexRpc(bridge, (frame) => this.recordNotification(frame));
	}

	private readonly rpc: CodexRpc;

	static async open(options: CodexRuntimeDriverOptions) {
		return CodexRuntimeDriver.openWithBridge(
			options,
			CodexAppServerBridge.open,
		);
	}

	protected static async openWithBridge(
		options: CodexRuntimeDriverOptions,
		openBridge: OpenCodexBridge,
	) {
		const file = await CodexRuntimeDriver.openState(options.path);
		let bridge: CodexAppServerTransport;
		try {
			bridge = await openBridge({
				model: options.model,
				reasoningEffort: options.reasoningEffort,
				provenance: CODEX_APP_SERVER_V2_PROVENANCE,
			});
		} catch {
			unavailable();
		}
		const driver = new CodexRuntimeDriver(file, bridge);
		try {
			await driver.rpc.request(
				"initialize",
				{ clientInfo: { name: "agent-infra-runtime", version: "1" } },
				(value) => {
					if (!isPlainRecord(value)) protocolInvalid();
				},
			);
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
				assertDriverState(state);
			});
			return file;
		} catch (error) {
			if (error instanceof RuntimeHostError) throw error;
			stateInvalid();
		}
	}

	async execute(command: RuntimeDriverCommandV1) {
		if (
			command.kind !== "submit-turn" ||
			command.input.attachments.length > 0
		) {
			unavailable();
		}
		if (command.operationId !== command.executionId) stateInvalid();
		const text = "text" in command.input ? command.input.text : undefined;
		if (!text) unavailable();
		const key = operationKey(command);
		const inFlight = this.inFlightExecutions.get(key);
		if (inFlight) return inFlight;
		const execution = this.executeOnce(command, text);
		this.inFlightExecutions.set(key, execution);
		try {
			return await execution;
		} finally {
			if (this.inFlightExecutions.get(key) === execution) {
				this.inFlightExecutions.delete(key);
			}
		}
	}

	private async executeOnce(
		command: Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>,
		text: string,
	) {
		const prepared = await this.prepare(command);
		if (prepared.operation.record) return prepared.operation.record;
		if (!prepared.created) {
			return this.unknown(command, prepared.operation.nativeSessionRef);
		}
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
		try {
			const turn = await this.rpc.request(
				"turn/start",
				{
					threadId: session.threadId,
					clientUserMessageId: command.operationId,
					input: [{ type: "text", text }],
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
			);
			return await this.resolve(
				command,
				session.nativeSessionRef,
				{ outcome: "accepted", status: turn.status },
				turn.id,
			);
		} catch (error) {
			await this.markAcceptanceUncertain(command, session.nativeSessionRef);
			throw error;
		}
	}

	async lookupOperation(
		command: RuntimeDriverCommandV1,
	): Promise<RuntimeDriverLookup> {
		const operation = ownRecordValue(
			this.readState().operations,
			operationKey(command),
		);
		if (!operation) return { state: "missing" };
		if (!operation.record) return { state: "unknown" };
		return { state: "found", record: operation.record };
	}

	async getStatus(nativeSessionRef: string, executionId: string) {
		const session = this.session(nativeSessionRef);
		const execution = ownRecordValue(session.executions, executionId);
		if (!execution || !session.threadId) unavailable();
		if (execution.status !== "running") return execution.status;
		await this.resumeSession(nativeSessionRef);
		const status = await this.readNativeTurnStatus(
			session.threadId,
			execution.nativeTurnId,
		);
		return this.updateExecutionStatus(
			nativeSessionRef,
			executionId,
			execution.nativeTurnId,
			status,
		);
	}

	async getCapabilities() {
		return capabilities;
	}

	async replayEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
	): Promise<RuntimeEventV1[]> {
		await this.recoverEventHistory(nativeSessionRef, executionId);
		const session = this.session(nativeSessionRef);
		const execution = ownRecordValue(session.executions, executionId);
		if (!execution) unavailable();
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
		return (async function* () {
			let cursor = afterCursor;
			while (!signal?.aborted) {
				const waiter = driver.waitForEvent(
					driver.eventStreamKey(nativeSessionRef, executionId),
					signal,
				);
				try {
					const pending = await driver.replayEvents(
						nativeSessionRef,
						executionId,
						cursor,
					);
					if (pending.length > 0) {
						for (const event of pending) {
							cursor = event.cursor;
							yield event;
							if (event.type === "completed") return;
						}
						continue;
					}
					if (
						driver.isExecutionTerminal(nativeSessionRef, executionId) &&
						!waiter.wasWoken()
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
			const streamKey = await this.update((state) => {
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
				return resolved.execution && appended
					? this.eventStreamKey(
							resolved.nativeSessionRef,
							resolved.execution.executionId,
						)
					: undefined;
			});
			if (streamKey) this.notifyEventStream(streamKey);
			return;
		}

		const completed = turnCompletedNotification(frame);
		if (completed) {
			const streamKey = await this.update((state) => {
				const resolved = this.resolveNotificationJournal(
					state,
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
		const preparedOperations = Object.entries(state.operations).filter(
			([, operation]) =>
				operation.nativeSessionRef === nativeSessionRef &&
				operation.state === "prepared",
		);
		if (preparedOperations.length > 1) stateInvalid();
		const pendingOperationKey = preparedOperations[0]?.[0];
		if (!execution && !pendingOperationKey) return undefined;
		return {
			nativeSessionRef,
			session,
			execution,
			journal: this.ensureJournal(
				session,
				nativeTurnId,
				execution ? undefined : pendingOperationKey,
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
		const { cursor, adapterEventKey } = this.nextEventIdentity(session);
		journal.events.push({
			cursor,
			adapterEventKey,
			occurredAt: new Date().toISOString(),
			nativeItemId,
			type: "text",
			payload: { delta },
		});
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
		let wake: () => void = () => undefined;
		let wasWoken = false;
		const promise = new Promise<void>((resolve) => {
			wake = () => {
				wasWoken = true;
				cleanup();
				resolve();
			};
		});
		const waiters = this.eventWaiters.get(key) ?? new Set<() => void>();
		this.eventWaiters.set(key, waiters);
		waiters.add(wake);
		const cleanup = () => {
			waiters.delete(wake);
			if (waiters.size === 0) this.eventWaiters.delete(key);
			signal?.removeEventListener("abort", wake);
		};
		signal?.addEventListener("abort", wake, { once: true });
		if (signal?.aborted) wake();
		return { promise, cancel: cleanup, wasWoken: () => wasWoken };
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
		const session = this.session(nativeSessionRef);
		const execution = ownRecordValue(session.executions, executionId);
		if (!execution || !session.threadId) unavailable();
		await this.resumeSession(nativeSessionRef);
		const status = await this.readNativeTurnStatus(
			session.threadId,
			execution.nativeTurnId,
		);
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
		await this.updateExecutionStatus(
			nativeSessionRef,
			executionId,
			execution.nativeTurnId,
			status,
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

	private async readNativeTurnStatus(threadId: string, nativeTurnId: string) {
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
			);
			if (result.status !== undefined) return result.status;
			if (result.nextCursor === undefined) unavailable();
			if (seenCursors.has(result.nextCursor)) protocolInvalid();
			seenCursors.add(result.nextCursor);
			cursor = result.nextCursor;
		}
		unavailable();
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

	private async prepare(
		command: Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>,
	) {
		return this.update((state) => {
			const key = operationKey(command);
			const existing = ownRecordValue(state.operations, key);
			if (existing) return { operation: existing, created: false };
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
				state: "prepared",
				nativeSessionRef,
			};
			state.operations[key] = operation;
			return { operation, created: true };
		});
	}

	private async markAcceptanceUncertain(
		command: Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>,
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
		command: Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>,
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
		const threadId = await this.rpc.request("thread/start", {}, (value) => {
			const thread = isPlainRecord(value) ? value.thread : undefined;
			if (
				!isPlainRecord(thread) ||
				typeof thread.id !== "string" ||
				thread.id.length === 0
			) {
				protocolInvalid();
			}
			return thread.id;
		});
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
		command: Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>,
		nativeSessionRef: string,
		result: RuntimeDriverOperationRecordV1["result"],
		nativeTurnId?: string,
	) {
		let record: RuntimeDriverOperationRecordV1 = {
			schemaVersion: 1,
			agentId: command.agentId,
			conversationId: command.conversationId,
			sessionGeneration: command.sessionGeneration,
			kind: command.kind,
			operationId: command.operationId,
			nativeSessionRef,
			result,
		};
		await this.update((state) => {
			const operation = ownRecordValue(state.operations, operationKey(command));
			const session = ownRecordValue(state.sessions, nativeSessionRef);
			if (!operation || !session) protocolInvalid();
			if (result.outcome !== "accepted") {
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

	private unknown(
		command: Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>,
		nativeSessionRef: string,
	) {
		return {
			schemaVersion: 1 as const,
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
		};
	}
}
