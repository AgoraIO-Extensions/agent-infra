import { randomUUID } from "node:crypto";

import type {
	RuntimeCapabilitiesV1,
	RuntimeDriverCommandV1,
	RuntimeDriverOperationRecordV1,
	RuntimeEventV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";

import {
	CODEX_APP_SERVER_V2_PROVENANCE,
	CodexAppServerBridge,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import type { RuntimeDriver, RuntimeDriverLookup } from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";

export interface CodexAppServerTransport {
	send(frame: CodexAppServerFrame): Promise<void>;
	frames(): AsyncIterable<CodexAppServerFrame>;
	close?(): Promise<void>;
}

export interface CodexRuntimeDriverOptions {
	path: string;
	bridgeOptions: CodexAppServerBridgeOptions;
	openBridge?: (
		options: CodexAppServerBridgeOptions,
	) => Promise<CodexAppServerTransport>;
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

function operationKey(command: RuntimeDriverCommandV1) {
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
		if (!("id" in frame)) return;
		if (typeof frame.id !== "number" || !Number.isSafeInteger(frame.id)) {
			this.fail(protocolInvalidError());
			return;
		}
		const pending = this.pending.get(frame.id);
		if (!pending) {
			this.fail(protocolInvalidError());
			return;
		}
		this.pending.delete(frame.id);
		if ("error" in frame || !("result" in frame)) {
			pending.reject(protocolInvalidError());
			return;
		}
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

	private constructor(
		private readonly file: DurableJsonFile<CodexDriverState>,
		private readonly rpc: CodexRpc,
	) {}

	static async open(options: CodexRuntimeDriverOptions) {
		const openBridge = options.openBridge ?? CodexAppServerBridge.open;
		let bridge: CodexAppServerTransport;
		try {
			bridge = await openBridge({
				...options.bridgeOptions,
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
			return new CodexRuntimeDriver(
				await DurableJsonFile.open(options.path, {
					schemaVersion: 1,
					sessions: {},
					operations: {},
				}),
				rpc,
			);
		} catch (error) {
			await rpc.close();
			if (error instanceof RuntimeHostError) throw error;
			unavailable();
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
		return this.resolve(
			command,
			session.nativeSessionRef,
			{ outcome: "accepted", status: statusForTurn(turn.status) },
			turn.id,
		);
	}

	async lookupOperation(
		command: RuntimeDriverCommandV1,
	): Promise<RuntimeDriverLookup> {
		const operation = this.file.read().operations[operationKey(command)];
		if (!operation) return { state: "missing" };
		if (!operation.record) return { state: "unknown" };
		return { state: "found", record: operation.record };
	}

	async getStatus(nativeSessionRef: string, executionId: string) {
		await this.resumeSession(nativeSessionRef);
		const execution = this.session(nativeSessionRef).executions[executionId];
		if (!execution) unavailable();
		return execution.status;
	}

	async getCapabilities() {
		return capabilities;
	}

	async replayEvents(
		nativeSessionRef: string,
		executionId: string,
		_afterCursor?: string,
	) {
		const execution = this.session(nativeSessionRef).executions[executionId];
		if (!execution) unavailable();
		return [] as RuntimeEventV1[];
	}

	async subscribeEvents(
		nativeSessionRef: string,
		executionId: string,
		afterCursor?: string,
		_signal?: AbortSignal,
	) {
		await this.replayEvents(nativeSessionRef, executionId, afterCursor);
		return (async function* (): AsyncIterable<RuntimeEventV1> {})();
	}

	async close() {
		await this.rpc.close();
	}

	private async prepare(
		command: Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>,
	) {
		return this.file.update((state) => {
			const key = operationKey(command);
			const existing = state.operations[key];
			if (existing) return { operation: existing, created: false };
			const nativeSessionRef = command.nativeSessionRef ?? randomUUID();
			const session = state.sessions[nativeSessionRef];
			if (session) {
				if (
					session.agentId !== command.agentId ||
					session.conversationId !== command.conversationId ||
					session.sessionGeneration !== command.sessionGeneration
				) {
					protocolInvalid();
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

	private session(nativeSessionRef: string) {
		const session = this.file.read().sessions[nativeSessionRef];
		if (
			!session ||
			session.nativeSessionRef !== nativeSessionRef ||
			!isPlainRecord(session.executions)
		) {
			protocolInvalid();
		}
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
		await this.file.update((state) => {
			const stored = state.sessions[nativeSessionRef];
			if (!stored || stored.threadId) protocolInvalid();
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
		await this.file.update((state) => {
			const operation = state.operations[operationKey(command)];
			const session = state.sessions[nativeSessionRef];
			if (!operation || !session) protocolInvalid();
			operation.state = "resolved";
			operation.record = record;
			if (result.outcome !== "accepted") return;
			if (!nativeTurnId) protocolInvalid();
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
