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
	status: RuntimeStatusV1;
}

interface CodexSession {
	nativeSessionRef: string;
	agentId: string;
	conversationId: string;
	sessionGeneration: number;
	threadId?: string;
	activeExecutionId?: string;
	acceptanceUncertainOperationKey?: string;
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

const capabilities: RuntimeCapabilitiesV1 = {
	modelSelection: true,
	attachments: false,
	resultFiles: false,
	connection: false,
	supplementaryInstruction: false,
};

const turnsListPageSize = 100;
const maximumTurnsListPages = 8;

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
		!isPlainRecord(value.executions)
	) {
		return false;
	}
	let runningExecutionId: string | undefined;
	const nativeTurnIds = new Set<string>();
	for (const [executionId, execution] of Object.entries(value.executions)) {
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
	const session = sessions[value.nativeSessionRef];
	if (!session) return false;
	if (value.state === "prepared") return value.record === undefined;
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
	const execution = session.executions[record.data.operationId];
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
			const matchingOperations = Object.values(operations).filter(
				(operation) => {
					const record = operation.record;
					return (
						operation.state === "resolved" &&
						operation.nativeSessionRef === nativeSessionRef &&
						record?.nativeSessionRef === nativeSessionRef &&
						record.agentId === session.agentId &&
						record.conversationId === session.conversationId &&
						record.sessionGeneration === session.sessionGeneration &&
						record.kind === "submit-turn" &&
						record.operationId === executionId &&
						record.result.outcome === "accepted" &&
						record.result.status === execution.status
					);
				},
			);
			if (matchingOperations.length !== 1) stateInvalid();
		}
		const operationKey = session.acceptanceUncertainOperationKey;
		if (!operationKey) continue;
		const operation = operations[operationKey];
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

class CodexRpc {
	private readonly pending = new Map<number, PendingRequest>();
	private nextRequestId = 1;
	private failed = false;

	constructor(private readonly bridge: CodexAppServerTransport) {
		void this.consume();
	}

	async request(method: string, params: Record<string, unknown>) {
		if (this.failed) unavailable();
		const id = this.nextRequestId++;
		const response = new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
		try {
			await this.bridge.send({ id, method, params });
		} catch {
			this.pending.delete(id);
			this.fail();
			unavailable();
		}
		return response;
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
				this.receive(frame);
				if (this.failed) return;
			}
		} catch {
			// The bridge is an unavailable dependency from the Driver's perspective.
		}
		this.fail();
	}

	private receive(frame: CodexAppServerFrame) {
		if (!isPlainRecord(frame)) {
			this.fail(protocolInvalidError());
			return;
		}
		if (!("id" in frame)) {
			this.fail(
				typeof frame.method === "string"
					? unavailableError()
					: protocolInvalidError(),
			);
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
		this.pending.delete(frame.id);
		pending.resolve(frame.result);
	}

	private fail(error = unavailableError()) {
		if (this.failed) return;
		this.failed = true;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

export class CodexRuntimeDriver implements RuntimeDriver {
	private readonly resumedSessions = new Set<string>();

	protected constructor(
		private readonly file: DurableJsonFile<CodexDriverState>,
		private readonly rpc: CodexRpc,
	) {}

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
		const rpc = new CodexRpc(bridge);
		try {
			const initialized = await rpc.request("initialize", {
				clientInfo: { name: "agent-infra-runtime", version: "1" },
			});
			if (!isPlainRecord(initialized)) protocolInvalid();
			return new CodexRuntimeDriver(file, rpc);
		} catch (error) {
			await rpc.close();
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
		const prepared = await this.prepare(command);
		if (prepared.operation.record) return prepared.operation.record;
		if (!prepared.created) {
			return this.unknown(command, prepared.operation.nativeSessionRef);
		}
		const session = await this.ensureThread(
			prepared.operation.nativeSessionRef,
		);
		if (
			session.activeExecutionId &&
			session.activeExecutionId !== command.executionId
		) {
			return this.resolve(command, session.nativeSessionRef, {
				outcome: "busy",
			});
		}
		const text = "text" in command.input ? command.input.text : undefined;
		if (!text) unavailable();
		try {
			const started = await this.rpc.request("turn/start", {
				threadId: session.threadId,
				clientUserMessageId: command.operationId,
				input: [{ type: "text", text }],
			});
			const turn = isPlainRecord(started) ? started.turn : undefined;
			if (
				!isPlainRecord(turn) ||
				typeof turn.id !== "string" ||
				turn.id.length === 0
			) {
				protocolInvalid();
			}
			return await this.resolve(
				command,
				session.nativeSessionRef,
				{ outcome: "accepted", status: statusForTurn(turn.status) },
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
		const operation = this.readState().operations[operationKey(command)];
		if (!operation) return { state: "missing" };
		if (!operation.record) return { state: "unknown" };
		return { state: "found", record: operation.record };
	}

	async getStatus(nativeSessionRef: string, executionId: string) {
		await this.resumeSession(nativeSessionRef);
		const session = this.session(nativeSessionRef);
		const execution = session.executions[executionId];
		if (!execution || !session.threadId) unavailable();
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
		_nativeSessionRef: string,
		_executionId: string,
		_afterCursor?: string,
	): Promise<RuntimeEventV1[]> {
		unavailable();
	}

	async subscribeEvents(
		_nativeSessionRef: string,
		_executionId: string,
		_afterCursor?: string,
		_signal?: AbortSignal,
	): Promise<AsyncIterable<RuntimeEventV1>> {
		unavailable();
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

	private async readNativeTurnStatus(threadId: string, nativeTurnId: string) {
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		for (let page = 0; page < maximumTurnsListPages; page += 1) {
			const value = await this.rpc.request("thread/turns/list", {
				threadId,
				itemsView: "notLoaded",
				limit: turnsListPageSize,
				...(cursor === undefined ? {} : { cursor }),
			});
			const result = this.statusFromTurnsList(value, nativeTurnId);
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
		return this.update((state) => {
			const session = state.sessions[nativeSessionRef];
			const execution = session?.executions[executionId];
			if (!session || !execution || execution.nativeTurnId !== nativeTurnId) {
				stateInvalid();
			}
			const operation = Object.values(state.operations).find(
				(candidate) =>
					candidate.state === "resolved" &&
					candidate.nativeSessionRef === nativeSessionRef &&
					candidate.record?.operationId === executionId,
			);
			if (!operation?.record) stateInvalid();
			if (operation.record.result.outcome !== "accepted") stateInvalid();
			if (execution.status !== "running") return execution.status;
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
			return execution.status;
		});
	}

	private async prepare(
		command: Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>,
	) {
		return this.update((state) => {
			const key = operationKey(command);
			const existing = state.operations[key];
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
			const session = state.sessions[nativeSessionRef];
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
			const session = state.sessions[nativeSessionRef];
			const operation = state.operations[key];
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

	private session(nativeSessionRef: string) {
		const session = this.readState().sessions[nativeSessionRef];
		if (!session) unavailable();
		return session;
	}

	private async ensureThread(nativeSessionRef: string) {
		const session = this.session(nativeSessionRef);
		if (session.threadId) {
			await this.resumeSession(nativeSessionRef);
			return this.session(nativeSessionRef);
		}
		const started = await this.rpc.request("thread/start", {});
		const thread = isPlainRecord(started) ? started.thread : undefined;
		if (
			!isPlainRecord(thread) ||
			typeof thread.id !== "string" ||
			thread.id.length === 0
		) {
			protocolInvalid();
		}
		const threadId = thread.id;
		await this.update((state) => {
			const stored = state.sessions[nativeSessionRef];
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
		const session = this.session(nativeSessionRef);
		if (!session.threadId) unavailable();
		const resumed = await this.rpc.request("thread/resume", {
			threadId: session.threadId,
			excludeTurns: true,
		});
		const thread = isPlainRecord(resumed) ? resumed.thread : undefined;
		if (!isPlainRecord(thread) || thread.id !== session.threadId) {
			protocolInvalid();
		}
		this.resumedSessions.add(nativeSessionRef);
	}

	private async resolve(
		command: Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>,
		nativeSessionRef: string,
		result: RuntimeDriverOperationRecordV1["result"],
		nativeTurnId?: string,
	) {
		const record: RuntimeDriverOperationRecordV1 = {
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
			const operation = state.operations[operationKey(command)];
			const session = state.sessions[nativeSessionRef];
			if (!operation || !session) protocolInvalid();
			operation.state = "resolved";
			operation.record = record;
			if (result.outcome !== "accepted") return;
			if (!nativeTurnId) protocolInvalid();
			if (
				Object.values(session.executions).some(
					(execution) => execution.nativeTurnId === nativeTurnId,
				)
			) {
				protocolInvalid();
			}
			session.executions[command.executionId] = {
				executionId: command.executionId,
				turnId: command.turnId,
				nativeTurnId,
				status: result.status,
			};
			session.activeExecutionId =
				result.status === "running" ? command.executionId : undefined;
		});
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
