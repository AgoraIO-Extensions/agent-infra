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

function isJsonRpcRequestId(value: unknown): value is string | number {
	return (
		typeof value === "string" ||
		(typeof value === "number" && Number.isSafeInteger(value))
	);
}

function isEmptyRecord(value: unknown) {
	return isPlainRecord(value) && Object.keys(value).length === 0;
}

function assertOnlySessionFlagOrigins(value: Record<string, unknown>) {
	for (const origin of Object.values(value)) {
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
	expected: Pick<CodexRuntimeDriverOptions, "model" | "reasoningEffort">,
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
}

class CodexRpc {
	private readonly pending = new Map<number, PendingRequest>();
	private nextRequestId = 1;
	private failed = false;

	constructor(private readonly bridge: CodexAppServerTransport) {
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
			if (typeof frame.method === "string") return;
			this.fail(protocolInvalidError());
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
		if ("error" in frame || !("result" in frame)) {
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
	private readonly inFlightExecutions = new Map<
		string,
		Promise<RuntimeDriverOperationRecordV1>
	>();

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
			await rpc.request(
				"initialize",
				{ clientInfo: { name: "agent-infra-runtime", version: "1" } },
				(value) => {
					if (!isPlainRecord(value)) protocolInvalid();
				},
			);
			await rpc.request("config/read", { includeLayers: false }, (value) => {
				assertContainedConfiguration(value, options);
			});
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
		return this.update((state) => {
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
			const operation = ownRecordValue(state.operations, operationKey(command));
			const session = ownRecordValue(state.sessions, nativeSessionRef);
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
			Object.defineProperty(session.executions, command.executionId, {
				value: {
					executionId: command.executionId,
					turnId: command.turnId,
					nativeTurnId,
					status: result.status,
				},
				enumerable: true,
				writable: true,
				configurable: true,
			});
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
