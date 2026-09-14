import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	RuntimeDriverCommandV1Schema,
	RuntimeDriverOperationRecordV1Schema,
	RuntimeDriverSubmitTurnCommandV2Schema,
	RuntimeDriverSubmitTurnOperationRecordV2Schema,
	type RuntimeEventV1,
	RuntimeEventV1Schema,
	RuntimeModelConfigurationV3Schema,
	type RuntimeSelectionV1,
	RuntimeSelectionV1Schema,
	type RuntimeStatusV1,
	RuntimeStatusV1Schema,
} from "@agent-infra/contracts/runtime";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { verifyClaudeInstallation } from "./claude-installation.js";
import { openClaudeModelTransport } from "./claude-model-transport.js";
import { claudeQuery } from "./claude-query.js";
import { readClaudeSessionHistory } from "./claude-session-history.js";
import { claudeWorkspaceTools } from "./claude-workspace.js";
import { validateModelAccess } from "./codex-app-server-bridge.js";
import type {
	RuntimeDriver,
	RuntimeDriverCommand,
	RuntimeDriverLookup,
	RuntimeDriverOperationRecord,
} from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";

export interface ClaudeRuntimeModelOption {
	readonly modelOptionId: string;
	readonly model: string;
	readonly reasoningLevels: readonly string[];
	readonly endpoint: string;
	readonly credential: string;
	readonly authentication: "api-key" | "bearer";
}
export interface ClaudeRuntimeDriverOptions {
	readonly path: string;
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly modelOptions: readonly ClaudeRuntimeModelOption[];
}
interface Binding {
	ref: string;
	agentId: string;
	conversationId: string;
	sessionGeneration: number;
}
interface Operation {
	key: string;
	digest: string;
	record?: RuntimeDriverOperationRecord;
}
interface Turn {
	executionId: string;
	turnId: string;
	operationKey: string;
	userMessageId: string;
	configVersion: string;
	selection: RuntimeSelectionV1;
	modelResponse?: {
		state: "sent" | "completed" | "failed" | "unknown";
		endTurn: boolean;
	};
	status: RuntimeStatusV1;
	events: RuntimeEventV1[];
}
interface Session {
	schemaVersion: 1;
	binding: Binding;
	nativeId: string;
	started: boolean;
	cancelled: boolean;
	sequence: number;
	operations: Operation[];
	turns: Turn[];
}
interface Handle {
	native: ReturnType<typeof claudeQuery>;
	transport: Awaited<ReturnType<typeof openClaudeModelTransport>>;
	pump: Promise<void>;
	retiring: boolean;
}
type Submit = Extract<RuntimeDriverCommand, { kind: "submit-turn" }>;
const terminal = (status: RuntimeStatusV1) =>
	["completed", "cancelled", "failed"].includes(status);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function unavailable(): never {
	throw new RuntimeHostError(
		"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
		"Runtime session could not be recovered",
		503,
		false,
		"unavailable",
	);
}
function conflict(): never {
	throw new RuntimeHostError(
		"RUNTIME_OPERATION_CONFLICT",
		"Runtime operation conflicts with the original request",
		409,
	);
}
const operationKey = (command: RuntimeDriverCommand) =>
	JSON.stringify([command.kind, command.operationId]);
const digest = (command: RuntimeDriverCommand) =>
	createHash("sha256")
		.update(
			JSON.stringify(
				(command.schemaVersion === 2
					? RuntimeDriverSubmitTurnCommandV2Schema
					: RuntimeDriverCommandV1Schema
				).parse(command),
			),
		)
		.digest("hex");
function result(
	command: RuntimeDriverCommand,
	ref: string,
	value: RuntimeDriverOperationRecord["result"],
): RuntimeDriverOperationRecord {
	return (
		command.schemaVersion === 2
			? RuntimeDriverSubmitTurnOperationRecordV2Schema
			: RuntimeDriverOperationRecordV1Schema
	).parse({
		schemaVersion: command.schemaVersion,
		agentId: command.agentId,
		conversationId: command.conversationId,
		sessionGeneration: command.sessionGeneration,
		kind: command.kind,
		operationId: command.operationId,
		nativeSessionRef: ref,
		result: value,
	});
}
const unknownResult = {
	outcome: "unknown",
	code: "RUNTIME_ACCEPTANCE_UNKNOWN",
	message: "Runtime command acceptance could not be confirmed",
} as const;

export class ClaudeRuntimeDriver implements RuntimeDriver {
	private readonly files = new Map<string, Promise<DurableJsonFile<Session>>>();
	private readonly locks = new Map<string, Promise<unknown>>();
	private readonly handles = new Map<string, Handle>();
	private readonly waiters = new Map<string, Set<() => void>>();
	private closed = false;
	private readonly pending = new Set<Promise<RuntimeDriverOperationRecord>>();
	private closing?: Promise<void>;
	private constructor(
		private readonly options: ClaudeRuntimeDriverOptions,
		private readonly executable: string,
		private readonly index: DurableJsonFile<{
			schemaVersion: 1;
			sessions: Binding[];
		}>,
	) {}
	static async open(options: ClaudeRuntimeDriverOptions) {
		try {
			if (!isAbsolute(options.path) || options.path === "/") throw new Error();
			RuntimeModelConfigurationV3Schema.parse({
				configVersion: options.configVersion,
				defaultModelOptionId: options.defaultModelOptionId,
				defaultReasoningLevel: options.defaultReasoningLevel,
				schemaVersion: 3,
				modelOptions: options.modelOptions.map((option) => ({
					modelOptionId: option.modelOptionId,
					model: option.model,
					endpoint: option.endpoint,
					reasoningLevels: [...option.reasoningLevels],
					protocol: "anthropic-messages-v1",
					authentication: option.authentication,
					credentialEnvironmentVariable:
						"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_VALIDATED",
				})),
			});
		} catch {
			throw new Error("RUNTIME_CONFIGURATION_INVALID");
		}
		for (const option of options.modelOptions) {
			validateModelAccess({
				endpoint: option.endpoint,
				credential: option.credential,
			});
			if (
				option.reasoningLevels.some(
					(level) => !["low", "medium", "high", "xhigh", "max"].includes(level),
				)
			)
				throw new Error("RUNTIME_CONFIGURATION_INVALID");
		}
		const { executable } = await verifyClaudeInstallation();
		await mkdir(options.path, { recursive: true, mode: 0o700 });
		const path = await realpath(options.path);
		const existing = await readdir(path);
		if (existing.length && !existing.includes("index.json")) unavailable();
		if (
			existing.includes("index.json") &&
			!(await lstat(join(path, "index.json"))).isFile()
		)
			unavailable();
		const index = await DurableJsonFile.open(join(path, "index.json"), {
			schemaVersion: 1 as const,
			sessions: [] as Binding[],
		});
		const state = index.read();
		if (
			state.schemaVersion !== 1 ||
			!Array.isArray(state.sessions) ||
			state.sessions.some(
				(binding) =>
					!uuid.test(binding.ref) ||
					!binding.agentId ||
					!binding.conversationId ||
					!Number.isSafeInteger(binding.sessionGeneration) ||
					binding.sessionGeneration < 1,
			) ||
			new Set(state.sessions.map((binding) => binding.ref)).size !==
				state.sessions.length ||
			new Set(
				state.sessions.map(({ agentId, conversationId, sessionGeneration }) =>
					JSON.stringify([agentId, conversationId, sessionGeneration]),
				),
			).size !== state.sessions.length
		)
			unavailable();
		return new ClaudeRuntimeDriver(
			{ ...options, path, modelOptions: structuredClone(options.modelOptions) },
			executable,
			index,
		);
	}

	private async binding(command: RuntimeDriverCommand, create: boolean) {
		return this.index.update(async (state) => {
			const matches = (entry: Binding) =>
				entry.agentId === command.agentId &&
				entry.conversationId === command.conversationId &&
				entry.sessionGeneration === command.sessionGeneration;
			const entry = command.nativeSessionRef
				? state.sessions.find((entry) => entry.ref === command.nativeSessionRef)
				: state.sessions.find(matches);
			if (entry) {
				if (!matches(entry)) unavailable();
				return entry;
			}
			if (command.nativeSessionRef || command.kind !== "submit-turn")
				unavailable();
			if (!create) return undefined;
			const binding = {
				ref: randomUUID(),
				agentId: command.agentId,
				conversationId: command.conversationId,
				sessionGeneration: command.sessionGeneration,
			};
			await DurableJsonFile.open<Session>(
				join(this.options.path, binding.ref, "state.json"),
				{
					schemaVersion: 1,
					binding,
					nativeId: randomUUID(),
					started: false,
					cancelled: false,
					sequence: 0,
					operations: [],
					turns: [],
				},
			);
			state.sessions.push(binding);
			return binding;
		});
	}
	private file(binding: Binding) {
		let file = this.files.get(binding.ref);
		if (!file) {
			file = (async () => {
				const directory = join(this.options.path, binding.ref);
				if ((await realpath(directory)) !== directory) unavailable();
				if (
					!(
						await lstat(join(this.options.path, binding.ref, "state.json"))
					).isFile()
				)
					unavailable();
				const file = await DurableJsonFile.open<Session>(
					join(this.options.path, binding.ref, "state.json"),
					{
						schemaVersion: 1,
						binding,
						nativeId: randomUUID(),
						started: false,
						cancelled: false,
						sequence: 0,
						operations: [],
						turns: [],
					},
				);
				const state = file.read();
				if (
					state.schemaVersion !== 1 ||
					JSON.stringify(state.binding) !== JSON.stringify(binding) ||
					!uuid.test(state.nativeId) ||
					typeof state.started !== "boolean" ||
					typeof state.cancelled !== "boolean" ||
					!Number.isSafeInteger(state.sequence) ||
					state.sequence < 0 ||
					!Array.isArray(state.turns) ||
					!Array.isArray(state.operations)
				)
					unavailable();
				const operationKeys = new Set<string>();
				for (const operation of state.operations) {
					if (
						typeof operation.key !== "string" ||
						operationKeys.has(operation.key) ||
						!/^[a-f0-9]{64}$/.test(operation.digest)
					)
						unavailable();
					const key: unknown = JSON.parse(operation.key);
					if (
						!Array.isArray(key) ||
						key.length !== 2 ||
						![
							"submit-turn",
							"supplement",
							"stop",
							"generation-cancel",
						].includes(key[0]) ||
						typeof key[1] !== "string" ||
						!key[1]
					)
						unavailable();
					operationKeys.add(operation.key);
					if (operation.record) {
						const record = (
							operation.record.schemaVersion === 2
								? RuntimeDriverSubmitTurnOperationRecordV2Schema
								: RuntimeDriverOperationRecordV1Schema
						).parse(operation.record);
						if (
							record.agentId !== binding.agentId ||
							record.conversationId !== binding.conversationId ||
							record.sessionGeneration !== binding.sessionGeneration ||
							record.nativeSessionRef !== binding.ref ||
							record.kind !== key[0] ||
							record.operationId !== key[1]
						)
							unavailable();
					}
				}
				const executions = new Set<string>();
				const turns = new Set<string>();
				const users = new Set<string>();
				const eventKeys = new Set<string>();
				let sequence = 0;
				for (const turn of state.turns) {
					if (
						!turn.executionId ||
						!turn.turnId ||
						!uuid.test(turn.userMessageId) ||
						!turn.configVersion ||
						!Array.isArray(turn.events) ||
						!RuntimeStatusV1Schema.safeParse(turn.status).success ||
						!RuntimeSelectionV1Schema.safeParse(turn.selection).success ||
						executions.has(turn.executionId) ||
						turns.has(turn.turnId) ||
						users.has(turn.userMessageId) ||
						!operationKeys.has(turn.operationKey) ||
						JSON.parse(turn.operationKey)[0] !== "submit-turn"
					)
						unavailable();
					if (
						turn.modelResponse !== undefined &&
						(!turn.modelResponse ||
							!["sent", "completed", "failed", "unknown"].includes(
								turn.modelResponse.state,
							) ||
							typeof turn.modelResponse.endTurn !== "boolean" ||
							(turn.modelResponse.endTurn &&
								turn.modelResponse.state !== "completed"))
					)
						unavailable();
					executions.add(turn.executionId);
					turns.add(turn.turnId);
					users.add(turn.userMessageId);
					let completed = false;
					for (const event of turn.events) {
						sequence++;
						if (
							completed ||
							!RuntimeEventV1Schema.safeParse(event).success ||
							event.executionId !== turn.executionId ||
							event.cursor !== `claude-${sequence}` ||
							eventKeys.has(event.adapterEventKey)
						)
							unavailable();
						eventKeys.add(event.adapterEventKey);
						if (event.type === "completed") {
							completed = true;
							if (event.payload.status !== turn.status) unavailable();
						}
					}
					if (terminal(turn.status) !== completed) unavailable();
				}
				if (
					sequence !== state.sequence ||
					state.turns.filter((turn) => !terminal(turn.status)).length > 1
				)
					unavailable();
				await file.update((state) => {
					for (const turn of state.turns)
						if (turn.status === "running") turn.status = "unknown";
				});
				for (const turn of file.read().turns) {
					if (
						!terminal(turn.status) &&
						turn.configVersion === this.options.configVersion &&
						turn.modelResponse?.state === "failed"
					) {
						await this.status(file, turn.executionId, "failed");
						continue;
					}
					if (
						terminal(turn.status) ||
						turn.configVersion !== this.options.configVersion ||
						turn.modelResponse?.state !== "completed" ||
						!turn.modelResponse.endTurn
					)
						continue;
					const history = await readClaudeSessionHistory(
						state.nativeId,
						join(directory, "workspace"),
						join(directory, "config"),
						turn.userMessageId,
					);
					if (!history.users.includes(turn.userMessageId) || !history.completed)
						continue;
					const recovered: Pick<RuntimeEventV1, "type" | "payload">[] = [];
					const tools = new Map<string, string>();
					for (const event of history.events) {
						if (
							event.type === "text" &&
							typeof event.payload.delta === "string"
						)
							recovered.push({
								type: "text",
								payload: { delta: event.payload.delta },
							});
						else if (
							event.type === "tool" &&
							typeof event.payload.id === "string"
						) {
							if (event.payload.phase === "started")
								tools.set(
									event.payload.id,
									["Read", "Write", "Edit"].includes(event.payload.name ?? "")
										? (event.payload.name ?? unavailable())
										: "unavailable",
								);
							const name = tools.get(event.payload.id) ?? unavailable();
							recovered.push({
								type: "tool",
								payload: {
									toolCallId: createHash("sha256")
										.update(event.payload.id)
										.digest("hex"),
									name,
									phase: event.payload.phase ?? unavailable(),
								},
							});
						} else unavailable();
					}
					// Native blocks can contain many live deltas. Consume only the already durable prefix.
					let offset = 0;
					for (const event of turn.events.filter(
						(event) => event.type === "text" || event.type === "tool",
					)) {
						const expected = recovered[offset];
						if (
							event.type === "text" &&
							expected?.type === "text" &&
							"delta" in expected.payload &&
							typeof expected.payload.delta === "string" &&
							expected.payload.delta.startsWith(event.payload.delta)
						) {
							const remaining = expected.payload.delta.slice(
								event.payload.delta.length,
							);
							if (remaining)
								recovered[offset] = {
									type: "text",
									payload: { delta: remaining },
								};
							else offset++;
						} else if (
							event.type === "tool" &&
							expected?.type === "tool" &&
							JSON.stringify(event.payload) === JSON.stringify(expected.payload)
						)
							offset++;
						else unavailable();
					}
					for (const event of recovered.slice(offset))
						await this.event(file, turn.executionId, event);
					await this.status(file, turn.executionId, "completed");
				}
				return file;
			})().catch(() => unavailable());
			this.files.set(binding.ref, file);
		}
		return file;
	}
	private async forReference(ref: string) {
		const binding = this.index
			.read()
			.sessions.find((entry) => entry.ref === ref);
		if (!binding) unavailable();
		return this.file(binding);
	}
	private exclusive<T>(ref: string, action: () => Promise<T>): Promise<T> {
		const task = (this.locks.get(ref) ?? Promise.resolve())
			.catch(() => {})
			.then(action);
		this.locks.set(ref, task);
		return task;
	}
	execute(value: RuntimeDriverCommand): Promise<RuntimeDriverOperationRecord> {
		if (this.closed)
			return Promise.reject(
				new RuntimeHostError(
					"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
					"Runtime session could not be recovered",
					503,
				),
			);
		const operation = this.executeCommand(value);
		this.pending.add(operation);
		void operation.then(
			() => this.pending.delete(operation),
			() => this.pending.delete(operation),
		);
		return operation;
	}
	private async executeCommand(
		value: RuntimeDriverCommand,
	): Promise<RuntimeDriverOperationRecord> {
		const command = (
			value.schemaVersion === 2
				? RuntimeDriverSubmitTurnCommandV2Schema
				: RuntimeDriverCommandV1Schema
		).parse(value);
		if (this.closed) unavailable();
		const binding = await this.binding(command, true);
		if (!binding) unavailable();
		return this.exclusive(binding.ref, async () => {
			if (this.closed) unavailable();
			const file = await this.file(binding);
			const previous = file
				.read()
				.operations.find((entry) => entry.key === operationKey(command));
			if (previous) {
				if (previous.digest !== digest(command)) conflict();
				if (previous.record) return previous.record;
				if (command.kind !== "stop" && command.kind !== "generation-cancel")
					return result(command, binding.ref, unknownResult);
			}
			if (command.kind === "submit-turn") return this.submit(file, command);
			if (command.kind === "supplement")
				return this.resolve(file, command, { outcome: "busy" });
			const turn = file
				.read()
				.turns.find(
					(turn) =>
						turn.executionId === command.executionId &&
						turn.turnId === command.turnId,
				);
			if (!turn) unavailable();
			await file.update((state) => {
				if (!previous)
					state.operations.push({
						key: operationKey(command),
						digest: digest(command),
					});
				if (command.kind === "generation-cancel") state.cancelled = true;
			});
			if (!terminal(turn.status)) {
				await this.retire(binding.ref);
				await this.status(file, turn.executionId, "cancelled");
			}
			return this.resolve(file, command, {
				outcome: "accepted",
				status:
					file
						.read()
						.turns.find((entry) => entry.executionId === turn.executionId)
						?.status ?? unavailable(),
			});
		});
	}
	private async resolve(
		file: DurableJsonFile<Session>,
		command: RuntimeDriverCommand,
		value: RuntimeDriverOperationRecord["result"],
	) {
		const record = result(command, file.read().binding.ref, value);
		await file.update((state) => {
			let operation = state.operations.find(
				(entry) => entry.key === operationKey(command),
			);
			if (!operation) {
				operation = { key: operationKey(command), digest: digest(command) };
				state.operations.push(operation);
			}
			operation.record = record;
		});
		return record;
	}
	private async submit(file: DurableJsonFile<Session>, command: Submit) {
		const before = file.read();
		const ref = before.binding.ref;
		if (before.cancelled) unavailable();
		const selection =
			command.schemaVersion === 2
				? command.selection
				: {
						schemaVersion: 1 as const,
						modelOptionId: this.options.defaultModelOptionId,
						reasoningLevel: this.options.defaultReasoningLevel,
					};
		const option = this.options.modelOptions.find(
			(option) =>
				option.modelOptionId === selection.modelOptionId &&
				option.reasoningLevels.includes(selection.reasoningLevel),
		);
		if (!option) {
			if (command.schemaVersion === 1) unavailable();
			return this.resolve(file, command, {
				outcome: "rejected",
				code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
				message: "Runtime model selection is unsupported",
				retryable: false,
			});
		}
		if (before.turns.some((turn) => !terminal(turn.status)))
			return this.resolve(file, command, { outcome: "busy" });
		if (
			before.turns.some(
				(turn) =>
					turn.executionId === command.executionId ||
					turn.turnId === command.turnId,
			)
		)
			conflict();
		if (!("text" in command.input) || command.input.attachments.length)
			unavailable();
		// Paseo ensureQuery retirement order: detach old work, drain it, then resume the same native ID.
		await this.retire(ref);
		const directory = join(this.options.path, ref);
		if (before.started) {
			try {
				const history = await readClaudeSessionHistory(
					before.nativeId,
					join(directory, "workspace"),
					join(directory, "config"),
				);
				if (
					before.turns.some(
						(turn) =>
							terminal(turn.status) &&
							!history.users.includes(turn.userMessageId),
					)
				)
					unavailable();
			} catch {
				unavailable();
			}
		}
		for (const name of ["workspace", "config", "tmp", "memory"]) {
			const path = join(directory, name);
			await mkdir(path, { recursive: true, mode: 0o700 });
			if ((await lstat(path)).isSymbolicLink()) unavailable();
		}
		const userMessageId = randomUUID();
		await file.update((state) => {
			state.operations.push({
				key: operationKey(command),
				digest: digest(command),
			});
			state.turns.push({
				executionId: command.executionId,
				turnId: command.turnId,
				operationKey: operationKey(command),
				userMessageId,
				configVersion: this.options.configVersion,
				selection,
				status: "unknown",
				events: [],
			});
		});
		let admitted: () => void = () => {};
		const admission = new Promise<void>((resolve) => {
			admitted = resolve;
		});
		const transport = await openClaudeModelTransport({
			...option,
			effort: selection.reasoningLevel,
			receipt: async (response, endTurn = false) => {
				await file.update((state) => {
					const turn =
						state.turns.find(
							(turn) => turn.executionId === command.executionId,
						) ?? unavailable();
					turn.modelResponse = { state: response, endTurn };
				});
			},
			admit: async () => {
				if (this.closed) unavailable();
				await file.update((state) => {
					state.started = true;
				});
				await this.resolve(file, command, {
					outcome: "accepted",
					status: "running",
				});
				await this.status(file, command.executionId, "running");
				admitted();
			},
		});
		if (this.closed) {
			await transport.close();
			unavailable();
		}
		let native: ReturnType<typeof claudeQuery>;
		try {
			native = claudeQuery(
				{
					pathToClaudeCodeExecutable: this.executable,
					cwd: join(directory, "workspace"),
					env: {
						PATH: process.env.PATH,
						TMPDIR: join(directory, "tmp"),
						CLAUDE_CONFIG_DIR: join(directory, "config"),
						ANTHROPIC_BASE_URL: transport.modelAccess.endpoint,
						ANTHROPIC_AUTH_TOKEN: transport.modelAccess.credential,
						CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
					},
					settingSources: [],
					...claudeWorkspaceTools(
						join(directory, "workspace"),
						join(directory, "memory"),
					),
					strictMcpConfig: true,
					mcpServers: {},
					systemPrompt: `You are an assistant. Follow the user's request. Your workspace is ${join(directory, "workspace")}. Your private persistent memory directory is ${join(directory, "memory")}. You may read and write files only in these two directories. Read MEMORY.md there for saved user preferences when present.`,
					model: option.model,
					effort: selection.reasoningLevel as EffortLevel,
					thinking: { type: "adaptive" },
					includePartialMessages: true,
					...(before.started
						? { resume: before.nativeId }
						: { sessionId: before.nativeId }),
					extraArgs: { "disable-slash-commands": null },
				},
				{
					type: "user",
					session_id: before.nativeId,
					uuid: userMessageId,
					parent_tool_use_id: null,
					message: {
						role: "user",
						content: [{ type: "text", text: command.input.text }],
					},
				},
			);
		} catch {
			await transport.close();
			return result(command, ref, unknownResult);
		}
		const handle: Handle = {
			native,
			transport,
			pump: Promise.resolve(),
			retiring: false,
		};
		this.handles.set(ref, handle);
		handle.pump = (async () => {
			const seen = new Map<string, string>();
			const tools = new Map<string, string>();
			try {
				for await (const message of native.query) {
					if (handle.retiring || this.handles.get(ref) !== handle) break;
					if (message.session_id !== before.nativeId) unavailable();
					if (
						"user_message_uuid" in message &&
						message.user_message_uuid !== undefined &&
						message.user_message_uuid !== userMessageId
					)
						unavailable();
					if (message.uuid) {
						const fingerprint = createHash("sha256")
							.update(JSON.stringify(message))
							.digest("hex");
						const previous = seen.get(message.uuid);
						if (previous) {
							if (previous !== fingerprint) unavailable();
							continue;
						}
						seen.set(message.uuid, fingerprint);
					}
					if (message.type === "assistant" && message.error) {
						await this.status(
							file,
							command.executionId,
							transport.failure() ?? "failed",
						);
						break;
					}
					if (
						message.type === "user" &&
						message.parent_tool_use_id === null &&
						Array.isArray(message.message.content)
					) {
						for (const block of message.message.content) {
							if (block.type !== "tool_result") continue;
							const name = tools.get(block.tool_use_id);
							if (!name) unavailable();
							tools.delete(block.tool_use_id);
							await this.event(file, command.executionId, {
								type: "tool",
								payload: {
									toolCallId: createHash("sha256")
										.update(block.tool_use_id)
										.digest("hex"),
									name,
									phase: block.is_error ? "failed" : "completed",
								},
							});
						}
					}
					if (
						message.type === "stream_event" &&
						message.parent_tool_use_id === null &&
						message.event.type === "content_block_start" &&
						message.event.content_block.type === "tool_use"
					) {
						if (tools.has(message.event.content_block.id)) unavailable();
						tools.set(
							message.event.content_block.id,
							["Read", "Write", "Edit"].includes(
								message.event.content_block.name,
							)
								? message.event.content_block.name
								: "unavailable",
						);
						await this.event(file, command.executionId, {
							type: "tool",
							payload: {
								toolCallId: createHash("sha256")
									.update(message.event.content_block.id)
									.digest("hex"),
								name: ["Read", "Write", "Edit"].includes(
									message.event.content_block.name,
								)
									? message.event.content_block.name
									: "unavailable",
								phase: "started",
							},
						});
					}
					if (
						message.type === "stream_event" &&
						message.parent_tool_use_id === null &&
						message.event.type === "content_block_delta" &&
						message.event.delta.type === "text_delta" &&
						message.event.delta.text
					)
						await this.event(file, command.executionId, {
							type: "text",
							payload: { delta: message.event.delta.text },
						});
					if (message.type === "result") {
						await this.status(
							file,
							command.executionId,
							transport.failure() ??
								(message.subtype === "success" && !message.is_error
									? "completed"
									: "failed"),
						);
						break;
					}
				}
				if (
					!handle.retiring &&
					!terminal(
						file
							.read()
							.turns.find((turn) => turn.executionId === command.executionId)
							?.status ?? unavailable(),
					)
				)
					await this.status(
						file,
						command.executionId,
						transport.failure() ?? "unknown",
					);
			} catch {
				if (
					!handle.retiring &&
					!terminal(
						file
							.read()
							.turns.find((turn) => turn.executionId === command.executionId)
							?.status ?? unavailable(),
					)
				)
					await this.status(
						file,
						command.executionId,
						transport.failure() ?? "unknown",
					);
			} finally {
				await transport.close();
				await native.close();
			}
		})();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				admission,
				handle.pump,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 30_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
		const resolved = file
			.read()
			.operations.find((entry) => entry.key === operationKey(command))?.record;
		if (!resolved) await this.retire(ref);
		return resolved ?? result(command, ref, unknownResult);
	}
	private async event(
		file: DurableJsonFile<Session>,
		executionId: string,
		value: Pick<RuntimeEventV1, "type" | "payload">,
	) {
		await file.update((state) => {
			const turn = state.turns.find((turn) => turn.executionId === executionId);
			if (!turn || terminal(turn.status)) return;
			state.sequence++;
			turn.events.push(
				RuntimeEventV1Schema.parse({
					schemaVersion: 1,
					executionId,
					adapterEventKey: randomUUID(),
					cursor: `claude-${state.sequence}`,
					occurredAt: new Date().toISOString(),
					...value,
				}),
			);
		});
		for (const wake of this.waiters.get(file.read().binding.ref) ?? []) wake();
	}
	private async status(
		file: DurableJsonFile<Session>,
		executionId: string,
		status: RuntimeStatusV1,
	) {
		await file.update((state) => {
			const turn = state.turns.find((turn) => turn.executionId === executionId);
			if (!turn || terminal(turn.status)) return;
			state.sequence++;
			turn.events.push(
				RuntimeEventV1Schema.parse({
					schemaVersion: 1,
					executionId,
					adapterEventKey: randomUUID(),
					cursor: `claude-${state.sequence}`,
					occurredAt: new Date().toISOString(),
					...(terminal(status)
						? { type: "completed", payload: { status } }
						: { type: "status", payload: { status } }),
				}),
			);
			turn.status = status;
		});
		for (const wake of this.waiters.get(file.read().binding.ref) ?? []) wake();
	}
	private async retire(ref: string) {
		const handle = this.handles.get(ref);
		if (!handle) return;
		handle.retiring = true;
		await handle.transport.close();
		await handle.native.close();
		await handle.pump;
		if (this.handles.get(ref) === handle) this.handles.delete(ref);
	}
	close() {
		this.closing ??= (async () => {
			this.closed = true;
			await Promise.all(
				[...this.handles.keys()].map((ref) => this.retire(ref)),
			);
			await Promise.allSettled([...this.pending]);
			await Promise.all(
				[...this.handles.keys()].map((ref) => this.retire(ref)),
			);
			for (const values of this.waiters.values())
				for (const wake of values) wake();
		})();
		return this.closing;
	}

	async lookupOperation(
		command: RuntimeDriverCommand,
	): Promise<RuntimeDriverLookup> {
		const binding = await this.binding(command, false);
		if (!binding) return { state: "missing" };
		const previous = (await this.file(binding))
			.read()
			.operations.find((entry) => entry.key === operationKey(command));
		if (!previous) return { state: "missing" };
		if (previous.digest !== digest(command)) conflict();
		if (
			!previous.record &&
			(command.kind === "stop" || command.kind === "generation-cancel")
		)
			return { state: "found", record: await this.execute(command) };
		return previous.record
			? { state: "found", record: previous.record }
			: { state: "unknown" };
	}
	async getStatus(ref: string, executionId: string): Promise<RuntimeStatusV1> {
		const turn = (await this.forReference(ref))
			.read()
			.turns.find((turn) => turn.executionId === executionId);
		if (!turn) unavailable();
		if (
			!terminal(turn.status) &&
			turn.configVersion !== this.options.configVersion
		)
			unavailable();
		return turn.status;
	}
	async getCapabilities() {
		return {
			modelSelection: true,
			attachments: false,
			resultFiles: false,
			connection: false,
			supplementaryInstruction: false,
		};
	}
	async replayEvents(ref: string, executionId: string, afterCursor?: string) {
		const turn = (await this.forReference(ref))
			.read()
			.turns.find((turn) => turn.executionId === executionId);
		if (!turn) unavailable();
		const index =
			afterCursor === undefined
				? -1
				: turn.events.findIndex((event) => event.cursor === afterCursor);
		if (afterCursor !== undefined && index === -1)
			throw new RuntimeHostError(
				"RUNTIME_REPLAY_CURSOR_INVALID",
				"Runtime replay cursor is unknown",
				400,
			);
		return turn.events.slice(index + 1);
	}
	async subscribeEvents(
		ref: string,
		executionId: string,
		afterCursor?: string,
		signal?: AbortSignal,
	): Promise<AsyncIterable<RuntimeEventV1>> {
		await this.replayEvents(ref, executionId, afterCursor);
		const self = this;
		return (async function* () {
			let cursor = afterCursor;
			while (!self.closed && !signal?.aborted) {
				let wake: () => void = () => {};
				const changed = new Promise<void>((resolve) => {
					wake = resolve;
				});
				const waiters = self.waiters.get(ref) ?? new Set<() => void>();
				self.waiters.set(ref, waiters);
				waiters.add(wake);
				signal?.addEventListener("abort", wake, { once: true });
				try {
					const events = await self.replayEvents(ref, executionId, cursor);
					for (const event of events) {
						cursor = event.cursor;
						yield event;
					}
					if (terminal(await self.getStatus(ref, executionId))) return;
					if (!events.length) await changed;
				} finally {
					waiters.delete(wake);
					signal?.removeEventListener("abort", wake);
				}
			}
		})();
	}
}
