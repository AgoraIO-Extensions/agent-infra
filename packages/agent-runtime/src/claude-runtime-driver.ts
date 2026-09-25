import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	RuntimeDriverCommandV1Schema,
	RuntimeDriverOperationRecordV1Schema,
	RuntimeDriverSubmitTurnCommandV2Schema,
	RuntimeDriverSubmitTurnOperationRecordV2Schema,
	type RuntimeEvent,
	RuntimeEventSchema,
	type RuntimeEventV1,
	RuntimeEventV1Schema,
	RuntimeEventV2Schema,
	RuntimeModelConfigurationV3Schema,
	type RuntimeOperationFactV2,
	type RuntimeSelectionV1,
	RuntimeSelectionV1Schema,
	type RuntimeStatusV1,
	RuntimeStatusV1Schema,
} from "@agent-infra/contracts/runtime";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { verifyClaudeInstallation } from "./claude-installation.js";
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
import {
	driverRequestDigest as digest,
	driverOperationKey as operationKey,
	driverOperationResult as result,
} from "./driver-operation.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";

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
	events: RuntimeEvent[];
	toolOperations?: Record<
		string,
		{ operationRef: string; attemptRef: string; startedAt?: string }
	>;
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
	transport: Awaited<ReturnType<typeof openRuntimeMessagesTransport>>;
	pump: Promise<void>;
	retiring: boolean;
}
type Submit = Extract<RuntimeDriverCommand, { kind: "submit-turn" }>;
type RuntimeEventInput = {
	[K in RuntimeEventV1["type"]]: Pick<
		Extract<RuntimeEventV1, { type: K }>,
		"type" | "payload"
	>;
}[RuntimeEventV1["type"]];
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
const unknownResult = {
	outcome: "unknown",
	code: "RUNTIME_ACCEPTANCE_UNKNOWN",
	message: "Runtime command acceptance could not be confirmed",
} as const;

const metadataId = (value: string, prefix: string) => {
	if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return value;
	return `${prefix}:${createHash("sha256").update(value).digest("hex")}`;
};

function latestFact(
	turn: Turn,
	kind: RuntimeOperationFactV2["kind"],
): RuntimeOperationFactV2 | undefined {
	for (let index = turn.events.length - 1; index >= 0; index--) {
		const event = turn.events[index];
		if (event?.type === "operation" && event.payload.kind === kind)
			return event.payload;
	}
}

const nextLegacyCursor = (turns: Turn[], prefix: string) =>
	`${prefix}-${
		turns.reduce(
			(count, turn) =>
				count +
				turn.events.filter((event) => event.type !== "operation").length,
			0,
		) + 1
	}`;

function readUsage(value: unknown) {
	if (typeof value !== "object" || value === null) return undefined;
	const root = value as Record<string, unknown>;
	const message =
		typeof root.message === "object" && root.message !== null
			? (root.message as Record<string, unknown>)
			: undefined;
	const event =
		typeof root.event === "object" && root.event !== null
			? (root.event as Record<string, unknown>)
			: undefined;
	const usage =
		(root.usage as Record<string, unknown> | undefined) ??
		(message?.usage as Record<string, unknown> | undefined) ??
		(event?.usage as Record<string, unknown> | undefined);
	if (!usage) return undefined;
	const input = usage.input_tokens;
	const output = usage.output_tokens;
	const cached = usage.cache_read_input_tokens;
	return {
		...(typeof input === "number" && Number.isSafeInteger(input) && input >= 0
			? { inputTokens: input }
			: {}),
		...(typeof output === "number" &&
		Number.isSafeInteger(output) &&
		output >= 0
			? { outputTokens: output }
			: {}),
		...(typeof cached === "number" &&
		Number.isSafeInteger(cached) &&
		cached >= 0
			? { cachedInputTokens: cached }
			: {}),
	};
}

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
				let legacySequence = 0;
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
					if (
						turn.toolOperations !== undefined &&
						(typeof turn.toolOperations !== "object" ||
							turn.toolOperations === null ||
							Array.isArray(turn.toolOperations) ||
							Object.entries(turn.toolOperations).some(
								([toolCallId, operation]) =>
									!toolCallId ||
									typeof operation !== "object" ||
									operation === null ||
									Array.isArray(operation) ||
									typeof operation.operationRef !== "string" ||
									!operation.operationRef ||
									typeof operation.attemptRef !== "string" ||
									!operation.attemptRef ||
									(operation.startedAt !== undefined &&
										typeof operation.startedAt !== "string"),
							))
					)
						unavailable();
					let completed = false;
					const cursorKeys = new Set<string>();
					for (const event of turn.events) {
						sequence++;
						if (event.type !== "operation") legacySequence++;
						if (
							completed ||
							!RuntimeEventSchema.safeParse(event).success ||
							event.executionId !== turn.executionId ||
							(event.type === "operation"
								? !event.cursor.startsWith("claude-operation-")
								: event.cursor !== `claude-${legacySequence}`) ||
							eventKeys.has(event.adapterEventKey) ||
							cursorKeys.has(event.cursor)
						)
							unavailable();
						eventKeys.add(event.adapterEventKey);
						cursorKeys.add(event.cursor);
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
					if (turn.status === "unknown")
						await this.recoverUnknownToolFacts(file, turn.executionId);
					const fact = latestFact(turn, "model");
					if (
						turn.status === "unknown" &&
						fact &&
						(fact.phase === "intent" || fact.phase === "started")
					)
						await this.modelPhase(
							file,
							turn.executionId,
							"unknown",
							"recovery_unconfirmed",
						);
				}
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
					const recovered: RuntimeEventInput[] = [];
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
				toolOperations: {},
			});
		});
		await this.appendOperationFact(file, command.executionId, {
			kind: "model",
			operationRef: randomUUID(),
			attemptRef: randomUUID(),
			phase: "intent",
			model: {
				configVersion: metadataId(this.options.configVersion, "config"),
				modelOptionId: metadataId(selection.modelOptionId, "model-option"),
				modelId: metadataId(option.model, "model"),
				reasoningLevel: metadataId(selection.reasoningLevel, "reasoning"),
			},
		});
		let admitted: () => void = () => {};
		const admission = new Promise<void>((resolve) => {
			admitted = resolve;
		});
		const transport = await openRuntimeMessagesTransport({
			...option,
			effort: selection.reasoningLevel,
			started: () => this.modelRequestStarted(file, command.executionId),
			receipt: async (response, endTurn, usage) => {
				if (response === "completed")
					await this.modelPhase(
						file,
						command.executionId,
						"completed",
						undefined,
						usage,
					);
				else if (response === "failed" || response === "unknown")
					await this.modelPhase(file, command.executionId, response);
				await file.update((state) => {
					const turn =
						state.turns.find(
							(turn) => turn.executionId === command.executionId,
						) ?? unavailable();
					turn.modelResponse = { state: response, endTurn: endTurn ?? false };
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
				await this.status(
					file,
					command.executionId,
					"running",
					undefined,
					false,
				);
				admitted();
			},
		});
		if (this.closed) {
			await transport.close();
			unavailable();
		}
		let native: ReturnType<typeof claudeQuery>;
		try {
			const observeToolRequest = async (
				name: string,
				toolUseID: string,
				permitted: boolean,
			) => {
				const toolCallId = createHash("sha256").update(toolUseID).digest("hex");
				await this.toolRequestStarted(file, command.executionId, {
					toolCallId,
					name,
				});
				if (!permitted)
					await this.toolPhase(file, command.executionId, {
						toolCallId,
						name,
						phase: "failed",
						failureCode: "authorization_denied",
					});
			};
			const workspaceTools = claudeWorkspaceTools(
				join(directory, "workspace"),
				join(directory, "memory"),
				async ({ name, toolUseID, permitted }) =>
					observeToolRequest(name, toolUseID, permitted),
				async ({ name, toolUseID }) => {
					const toolCallId = createHash("sha256")
						.update(toolUseID)
						.digest("hex");
					await this.toolPhase(file, command.executionId, {
						toolCallId,
						name,
						phase: "started",
					});
				},
			);
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
					...workspaceTools,
					canUseTool: async (name, input, toolOptions) => {
						const permission = (await workspaceTools.canUseTool?.(
							name,
							input,
							toolOptions,
						)) ?? {
							behavior: "deny" as const,
							message: "Tool access is unavailable",
						};
						await observeToolRequest(
							name,
							toolOptions.toolUseID,
							permission.behavior === "allow",
						);
						return permission;
					},
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
			let modelUsage: Extract<
				RuntimeOperationFactV2,
				{ kind: "model" }
			>["usage"];
			try {
				for await (const message of native.query) {
					if (handle.retiring || this.handles.get(ref) !== handle) break;
					if (message.session_id !== before.nativeId) unavailable();
					const observedUsage = readUsage(message);
					if (observedUsage && Object.keys(observedUsage).length)
						modelUsage = { ...modelUsage, ...observedUsage };
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
					}
					if (
						message.type === "tool_progress" &&
						message.parent_tool_use_id === null
					) {
						const name = tools.get(message.tool_use_id);
						if (!name) unavailable();
						await this.event(file, command.executionId, {
							type: "tool",
							payload: {
								toolCallId: createHash("sha256")
									.update(message.tool_use_id)
									.digest("hex"),
								name,
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
							modelUsage,
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
				await native.close().catch(() => {});
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
	private async appendOperationFact(
		file: DurableJsonFile<Session>,
		executionId: string,
		fact: RuntimeOperationFactV2,
	) {
		await file.update((state) => {
			const turn = state.turns.find(
				(entry) => entry.executionId === executionId,
			);
			if (!turn || terminal(turn.status)) return;
			const previous = latestFact(turn, fact.kind);
			if (
				previous &&
				previous.operationRef === fact.operationRef &&
				previous.attemptRef === fact.attemptRef &&
				previous.phase === fact.phase
			)
				return;
			state.sequence++;
			const adapterEventKey = randomUUID();
			turn.events.push(
				RuntimeEventV2Schema.parse({
					schemaVersion: 2,
					executionId,
					adapterEventKey,
					cursor: `claude-operation-${adapterEventKey}`,
					occurredAt: new Date().toISOString(),
					type: "operation",
					payload: fact,
				}),
			);
		});
		for (const wake of this.waiters.get(file.read().binding.ref) ?? []) wake();
	}
	private async modelPhase(
		file: DurableJsonFile<Session>,
		executionId: string,
		phase: "started" | "completed" | "failed" | "unknown",
		failureCode?: RuntimeOperationFactV2["failureCode"],
		usage?: Extract<RuntimeOperationFactV2, { kind: "model" }>["usage"],
	) {
		const turn = file
			.read()
			.turns.find((entry) => entry.executionId === executionId);
		const candidate = turn && latestFact(turn, "model");
		const previous = candidate?.kind === "model" ? candidate : undefined;
		if (
			!previous ||
			previous.phase === phase ||
			["completed", "failed"].includes(previous.phase) ||
			(previous.phase === "unknown" && phase === "started")
		)
			return;
		const now = new Date().toISOString();
		const startedAt =
			previous.startedAt ?? (phase === "started" ? now : undefined);
		const finishedAt =
			phase === "completed" || phase === "failed" ? now : undefined;
		const durationMs =
			startedAt && finishedAt
				? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
				: undefined;
		const {
			phase: _phase,
			startedAt: _startedAt,
			finishedAt: _finishedAt,
			durationMs: _durationMs,
			failureCode: _failureCode,
			usage: _usage,
			...base
		} = previous;
		await this.appendOperationFact(file, executionId, {
			...base,
			phase,
			...(startedAt ? { startedAt } : {}),
			...(finishedAt ? { finishedAt } : {}),
			...(durationMs === undefined ? {} : { durationMs }),
			...(usage ? { usage } : {}),
			...(phase === "completed" || phase === "started"
				? {}
				: {
						failureCode:
							failureCode ??
							(phase === "unknown"
								? "recovery_unconfirmed"
								: "operation_failed"),
					}),
		});
	}
	private async recoverUnknownToolFacts(
		file: DurableJsonFile<Session>,
		executionId: string,
	) {
		const turn = file
			.read()
			.turns.find((entry) => entry.executionId === executionId);
		if (!turn) return;
		const pending: Extract<RuntimeOperationFactV2, { kind: "tool" }>[] = [];
		const seen = new Set<string>();
		for (let index = turn.events.length - 1; index >= 0; index--) {
			const event = turn.events[index];
			if (event?.type !== "operation" || event.payload.kind !== "tool")
				continue;
			const key = `${event.payload.operationRef}:${event.payload.attemptRef}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (["intent", "started"].includes(event.payload.phase))
				pending.push(event.payload);
		}
		for (const fact of pending) {
			const finishedAt = new Date().toISOString();
			const durationMs = fact.startedAt
				? Math.max(0, Date.parse(finishedAt) - Date.parse(fact.startedAt))
				: undefined;
			await this.appendOperationFact(file, executionId, {
				...fact,
				phase: "unknown",
				failureCode: "recovery_unconfirmed",
				...(fact.startedAt ? { finishedAt, durationMs } : {}),
			});
		}
	}
	private async modelRequestStarted(
		file: DurableJsonFile<Session>,
		executionId: string,
	) {
		const turn = file
			.read()
			.turns.find((entry) => entry.executionId === executionId);
		const previous = turn && latestFact(turn, "model");
		if (previous?.kind !== "model") return;
		if (previous.phase === "intent") {
			await this.modelPhase(file, executionId, "started");
			return;
		}
		if (previous.phase === "started") {
			await this.modelPhase(
				file,
				executionId,
				"unknown",
				"recovery_unconfirmed",
			);
			const latest = file
				.read()
				.turns.find((entry) => entry.executionId === executionId);
			const completed = latest && latestFact(latest, "model");
			if (completed?.kind !== "model") return;
			const {
				phase: _phase,
				startedAt: _startedAt,
				finishedAt: _finishedAt,
				durationMs: _durationMs,
				failureCode: _failureCode,
				usage: _usage,
				...base
			} = completed;
			await this.appendOperationFact(file, executionId, {
				...base,
				attemptRef: randomUUID(),
				phase: "intent",
			});
			await this.modelPhase(file, executionId, "started");
			return;
		}
		if (["completed", "failed", "unknown"].includes(previous.phase)) {
			const {
				phase: _phase,
				startedAt: _startedAt,
				finishedAt: _finishedAt,
				durationMs: _durationMs,
				failureCode: _failureCode,
				usage: _usage,
				...base
			} = previous;
			await this.appendOperationFact(file, executionId, {
				...base,
				attemptRef: randomUUID(),
				phase: "intent",
			});
			await this.modelPhase(file, executionId, "started");
		}
	}
	private async toolRequestStarted(
		file: DurableJsonFile<Session>,
		executionId: string,
		value: { readonly toolCallId: string; readonly name: string },
	) {
		const turn = file
			.read()
			.turns.find((entry) => entry.executionId === executionId);
		if (!turn || terminal(turn.status)) unavailable();
		const identity = turn.toolOperations?.[value.toolCallId];
		const previousEvent = identity
			? [...turn.events]
					.reverse()
					.find(
						(event) =>
							event.type === "operation" &&
							event.payload.kind === "tool" &&
							event.payload.operationRef === identity.operationRef &&
							event.payload.attemptRef === identity.attemptRef,
					)
			: undefined;
		const previous =
			previousEvent?.type === "operation" &&
			previousEvent.payload.kind === "tool"
				? previousEvent.payload
				: undefined;
		if (previous && ["intent", "started"].includes(previous.phase)) return;
		const model = latestFact(turn, "model");
		const created = {
			kind: "tool" as const,
			operationRef: previous?.operationRef ?? randomUUID(),
			attemptRef: randomUUID(),
			phase: "intent" as const,
			toolId: metadataId(value.name, "tool"),
			...(model ? { parentOperationRef: model.operationRef } : {}),
		};
		await file.update((state) => {
			const current = state.turns.find(
				(entry) => entry.executionId === executionId,
			);
			if (!current || terminal(current.status)) unavailable();
			current.toolOperations ??= {};
			current.toolOperations[value.toolCallId] = {
				operationRef: created.operationRef,
				attemptRef: created.attemptRef,
			};
		});
		await this.appendOperationFact(file, executionId, created);
	}
	private async toolPhase(
		file: DurableJsonFile<Session>,
		executionId: string,
		value: {
			toolCallId: string;
			name: string;
			phase: "started" | "completed" | "failed";
			failureCode?: RuntimeOperationFactV2["failureCode"];
		},
	): Promise<void> {
		const turn = file
			.read()
			.turns.find((entry) => entry.executionId === executionId);
		if (!turn || terminal(turn.status)) return;
		const identity = turn.toolOperations?.[value.toolCallId];
		const previousEvent = identity
			? [...turn.events]
					.reverse()
					.find(
						(event) =>
							event.type === "operation" &&
							event.payload.kind === "tool" &&
							event.payload.operationRef === identity.operationRef &&
							event.payload.attemptRef === identity.attemptRef,
					)
			: undefined;
		const previous =
			previousEvent?.type === "operation" &&
			previousEvent.payload.kind === "tool"
				? previousEvent.payload
				: undefined;
		if (value.phase === "started") {
			if (
				!previous ||
				["completed", "failed", "unknown"].includes(previous.phase)
			)
				return;
			if (previous.phase !== "intent") return;
			const startedAt = new Date().toISOString();
			await this.appendOperationFact(file, executionId, {
				...previous,
				phase: "started",
				startedAt,
			});
			return;
		}
		if (!previous) {
			unavailable();
		}
		if (["completed", "failed", "unknown"].includes(previous.phase)) return;
		const now = new Date().toISOString();
		await this.appendOperationFact(file, executionId, {
			...previous,
			phase: value.phase,
			finishedAt: now,
			...(previous.startedAt
				? {
						durationMs: Math.max(
							0,
							Date.parse(now) - Date.parse(previous.startedAt),
						),
					}
				: {}),
			...(value.phase === "failed"
				? { failureCode: value.failureCode ?? ("operation_failed" as const) }
				: {}),
		});
	}
	private async event(
		file: DurableJsonFile<Session>,
		executionId: string,
		value: RuntimeEventInput,
	) {
		if (value.type === "tool")
			await this.toolPhase(file, executionId, value.payload);
		await file.update((state) => {
			const turn = state.turns.find((turn) => turn.executionId === executionId);
			if (!turn || terminal(turn.status)) return;
			state.sequence++;
			const legacyCursor = nextLegacyCursor(state.turns, "claude");
			turn.events.push(
				RuntimeEventV1Schema.parse({
					schemaVersion: 1,
					executionId,
					adapterEventKey: randomUUID(),
					cursor: legacyCursor,
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
		usage?: Extract<RuntimeOperationFactV2, { kind: "model" }>["usage"],
		markModel = true,
	) {
		if (markModel && status === "running")
			await this.modelPhase(file, executionId, "started");
		else if (status === "completed")
			await this.modelPhase(
				file,
				executionId,
				"unknown",
				"recovery_unconfirmed",
				usage,
			);
		else if (status === "failed")
			await this.modelPhase(file, executionId, "failed", "operation_failed");
		else if (status === "cancelled")
			await this.modelPhase(file, executionId, "failed", "interrupted");
		else if (status === "unknown")
			await this.modelPhase(
				file,
				executionId,
				"unknown",
				"recovery_unconfirmed",
			);
		await file.update((state) => {
			const turn = state.turns.find((turn) => turn.executionId === executionId);
			if (!turn || terminal(turn.status)) return;
			state.sequence++;
			const legacyCursor = nextLegacyCursor(state.turns, "claude");
			turn.events.push(
				RuntimeEventV1Schema.parse({
					schemaVersion: 1,
					executionId,
					adapterEventKey: randomUUID(),
					cursor: legacyCursor,
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
	): Promise<AsyncIterable<RuntimeEvent>> {
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
