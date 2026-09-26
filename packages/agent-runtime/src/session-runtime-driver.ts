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
	type RuntimeOperationFactV2,
	type RuntimeSelectionV1,
	RuntimeSelectionV1Schema,
	type RuntimeStatusV1,
	RuntimeStatusV1Schema,
} from "@agent-infra/contracts/runtime";
import type {
	RuntimeDriver,
	RuntimeDriverCommand,
	RuntimeDriverLookup,
	RuntimeDriverOperationRecord,
	RuntimeExternalActionAuthorization,
} from "./driver.js";
import {
	driverRequestDigest as digest,
	driverOperationKey as operationKey,
	driverOperationResult as result,
} from "./driver-operation.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";

export interface SessionRuntimeModelOption {
	readonly modelOptionId: string;
	readonly nativeModelId: string;
	/** The effective provider model identifier, when the native adapter prefixes it. */
	readonly modelFactId?: string;
	readonly reasoningLevels: readonly string[];
}
export interface SessionRuntimeDriverOptions {
	readonly path: string;
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly modelOptions: readonly SessionRuntimeModelOption[];
	readonly cursorPrefix: string;
	readonly openSession: (
		options: NativeSessionOptions,
	) => Promise<NativeSession>;
	readonly retireSession: (directory: string) => Promise<void>;
	readonly completionStatus: (reason: string) => RuntimeStatusV1;
	readonly modelLifecycleAtTransport?: boolean;
	readonly authorizeExternalAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<void>;
}
export interface NativeSessionOptions {
	directory: string;
	cwd: string;
	nativeId?: string;
	history?: { checkpoint: string; complete: boolean };
	selection: RuntimeSelectionV1;
	admit: () => Promise<void>;
	modelRequestIntent?: (request?: "messages" | "count_tokens") => Promise<void>;
	modelRequestStarted?: () => Promise<void>;
	modelUsage?: (
		usage: Extract<RuntimeOperationFactV2, { kind: "model" }>["usage"],
	) => Promise<void>;
	modelRequestFinished?: (
		state: "completed" | "failed" | "unknown",
		usage?: Extract<RuntimeOperationFactV2, { kind: "model" }>["usage"],
	) => Promise<void>;
	/** Persist a tool intent before the native adapter is allowed to execute it. */
	toolRequestStarted?: (tool: {
		readonly toolCallId: string;
		readonly name: string;
		/** False means the native permission boundary rejected the request. */
		readonly permitted?: boolean;
		readonly executionBoundary?: true;
	}) => Promise<void>;
	update: (event?: RuntimeEventInput) => Promise<void>;
}
export interface NativeSession {
	nativeId: string;
	select(model: string, effort: string): Promise<void>;
	prompt(text: string): Promise<{ stopReason: string; checkpoint?: string }>;
	reusable?(): boolean;
	startTurn?(options: NativeSessionOptions): void;
	checkpoint?(): Promise<string>;
	recover?(
		checkpoint: string,
	): Promise<
		{ stopReason: string; text: string; checkpoint?: string } | undefined
	>;
	cancel(): Promise<void>;
	close(): Promise<void>;
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
interface Index {
	schemaVersion: 1;
	sessions: Binding[];
	barriers?: (Operation & { ref: string })[];
}
interface Turn {
	executionId: string;
	turnId: string;
	operationKey: string;
	configVersion: string;
	selection: RuntimeSelectionV1;
	status: RuntimeStatusV1;
	nativeStopReason?: string;
	nativeCheckpoint?: string;
	nativeTerminalCheckpoint?: string;
	/** Confirmed native receipt retained until every admitted count is confirmed. */
	nativeResult?: {
		status: RuntimeStatusV1;
		stopReason: string;
		checkpoint?: string;
	};
	events: RuntimeEvent[];
	toolOperations?: Record<
		string,
		{ operationRef: string; attemptRef: string; startedAt?: string }
	>;
}
interface Session {
	schemaVersion: 1;
	binding: Binding;
	nativeId?: string;
	cancelled: boolean;
	sequence: number;
	operations: Operation[];
	turns: Turn[];
}
interface Handle {
	native: NativeSession;
	selection: RuntimeSelectionV1;
	pump: Promise<void>;
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
	operationRef?: string,
): RuntimeOperationFactV2 | undefined {
	for (let index = turn.events.length - 1; index >= 0; index--) {
		const event = turn.events[index];
		if (
			event?.type === "operation" &&
			event.payload.kind === kind &&
			(!operationRef || event.payload.operationRef === operationRef)
		)
			return event.payload;
	}
}

// The first model intent belongs to generation; auxiliary requests own separate operations.
function generationFact(turn: Turn) {
	const first = turn.events.find(
		(event) => event.type === "operation" && event.payload.kind === "model",
	);
	return first?.type === "operation"
		? latestFact(turn, "model", first.payload.operationRef)
		: undefined;
}

function auxiliaryRequestState(turn: Turn) {
	const generationRef = generationFact(turn)?.operationRef;
	const seen = new Set<string>();
	let pending = false;
	let unconfirmed = false;
	for (let index = turn.events.length - 1; index >= 0; index--) {
		const event = turn.events[index];
		if (
			event?.type !== "operation" ||
			event.payload.kind !== "model" ||
			event.payload.operationRef === generationRef
		)
			continue;
		const key = `${event.payload.operationRef}:${event.payload.attemptRef}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (["intent", "started"].includes(event.payload.phase)) pending = true;
		else if (event.payload.phase === "unknown") unconfirmed = true;
	}
	return pending ? "pending" : unconfirmed ? "unconfirmed" : "settled";
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

export class SessionRuntimeDriver implements RuntimeDriver {
	private readonly files = new Map<string, Promise<DurableJsonFile<Session>>>();
	private readonly locks = new Map<string, Promise<unknown>>();
	private readonly toolLocks = new Map<string, Promise<unknown>>();
	private readonly handles = new Map<string, Handle>();
	private readonly waiters = new Map<string, Set<() => void>>();
	private closed = false;
	private readonly pending = new Set<Promise<RuntimeDriverOperationRecord>>();
	private closing?: Promise<void>;
	private constructor(
		private readonly options: SessionRuntimeDriverOptions,
		private readonly index: DurableJsonFile<Index>,
	) {}
	static async open(options: SessionRuntimeDriverOptions) {
		if (
			!isAbsolute(options.path) ||
			options.path === "/" ||
			!options.configVersion ||
			!options.modelOptions.length ||
			new Set(options.modelOptions.map((o) => o.modelOptionId)).size !==
				options.modelOptions.length ||
			!options.modelOptions.some(
				(o) =>
					o.modelOptionId === options.defaultModelOptionId &&
					o.reasoningLevels.includes(options.defaultReasoningLevel),
			)
		)
			throw new Error("RUNTIME_CONFIGURATION_INVALID");
		await mkdir(options.path, { recursive: true, mode: 0o700 });
		const path = await realpath(options.path);
		const existing = await readdir(path);
		if (existing.length && !existing.includes("index.json")) unavailable();
		if (
			existing.includes("index.json") &&
			!(await lstat(join(path, "index.json"))).isFile()
		)
			unavailable();
		const index = await DurableJsonFile.open<Index>(join(path, "index.json"), {
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
		const barriers = state.barriers ?? [];
		if (!Array.isArray(barriers)) unavailable();
		const keys = new Set<string>();
		for (const barrier of barriers) {
			const binding = state.sessions.find((entry) => entry.ref === barrier.ref);
			const unique = JSON.stringify([barrier.ref, barrier.key]);
			if (
				!binding ||
				keys.has(unique) ||
				!/^[a-f0-9]{64}$/.test(barrier.digest)
			)
				unavailable();
			keys.add(unique);
			const key: unknown = JSON.parse(barrier.key);
			if (
				!Array.isArray(key) ||
				key.length !== 2 ||
				key[0] !== "generation-cancel" ||
				typeof key[1] !== "string" ||
				!key[1]
			)
				unavailable();
			if (barrier.record) {
				const record = RuntimeDriverOperationRecordV1Schema.parse(
					barrier.record,
				);
				if (
					record.agentId !== binding.agentId ||
					record.conversationId !== binding.conversationId ||
					record.sessionGeneration !== binding.sessionGeneration ||
					record.nativeSessionRef !== binding.ref ||
					record.kind !== "generation-cancel" ||
					record.operationId !== key[1] ||
					record.result.outcome !== "accepted" ||
					record.result.status !== "cancelled"
				)
					unavailable();
			}
		}
		return new SessionRuntimeDriver(
			{ ...options, path, modelOptions: structuredClone(options.modelOptions) },
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
					(state.nativeId !== undefined &&
						(typeof state.nativeId !== "string" || !state.nativeId)) ||
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
				const eventKeys = new Set<string>();
				let sequence = 0;
				let legacySequence = 0;
				for (const turn of state.turns) {
					if (
						!turn.executionId ||
						!turn.turnId ||
						!turn.configVersion ||
						!Array.isArray(turn.events) ||
						!RuntimeStatusV1Schema.safeParse(turn.status).success ||
						!RuntimeSelectionV1Schema.safeParse(turn.selection).success ||
						executions.has(turn.executionId) ||
						turns.has(turn.turnId) ||
						!operationKeys.has(turn.operationKey) ||
						JSON.parse(turn.operationKey)[0] !== "submit-turn"
					)
						unavailable();
					executions.add(turn.executionId);
					turns.add(turn.turnId);
					if (
						turn.nativeResult !== undefined &&
						(!turn.nativeResult ||
							Array.isArray(turn.nativeResult) ||
							!terminal(turn.nativeResult.status) ||
							typeof turn.nativeResult.stopReason !== "string" ||
							!turn.nativeResult.stopReason ||
							this.options.completionStatus(turn.nativeResult.stopReason) !==
								turn.nativeResult.status ||
							(turn.nativeResult.checkpoint !== undefined &&
								(typeof turn.nativeResult.checkpoint !== "string" ||
									!turn.nativeResult.checkpoint)) ||
							(turn.nativeCheckpoint && !turn.nativeResult.checkpoint))
					)
						unavailable();
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
								? !event.cursor.startsWith(
										`${this.options.cursorPrefix}-operation-`,
									)
								: event.cursor !==
									`${this.options.cursorPrefix}-${legacySequence}`) ||
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
					if (
						completed &&
						turn.nativeCheckpoint &&
						!turn.nativeTerminalCheckpoint
					)
						unavailable();
					if (
						completed &&
						this.options.completionStatus(turn.nativeStopReason ?? "") !==
							turn.status
					)
						unavailable();
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
				for (const turn of file.read().turns)
					if (turn.status === "unknown")
						await this.recoverUnknownOperationFacts(file, turn.executionId);
				const recoveredTurns = file.read().turns;
				const active = recoveredTurns.find((turn) => !terminal(turn.status));
				const latest = active ?? recoveredTurns.at(-1);
				if (
					latest &&
					!(
						active?.nativeResult && auxiliaryRequestState(active) !== "settled"
					) &&
					(active || latest.nativeTerminalCheckpoint) &&
					!this.cancelled(binding.ref)
				) {
					if (!state.nativeId) unavailable();
					const workspace = join(directory, "workspace");
					if ((await realpath(workspace)) !== workspace) unavailable();
					await this.options.retireSession(directory);
					const selection = this.options.modelOptions.some(
						(option) =>
							option.modelOptionId === latest.selection.modelOptionId &&
							option.reasoningLevels.includes(latest.selection.reasoningLevel),
					)
						? latest.selection
						: {
								schemaVersion: 1 as const,
								modelOptionId: this.options.defaultModelOptionId,
								reasoningLevel: this.options.defaultReasoningLevel,
							};
					const restored = await this.options.openSession({
						directory,
						cwd: workspace,
						nativeId: state.nativeId,
						history: latest.nativeCheckpoint
							? {
									checkpoint: active
										? latest.nativeCheckpoint
										: (latest.nativeTerminalCheckpoint ?? unavailable()),
									complete: !active,
								}
							: undefined,
						selection,
						modelRequestIntent: async () => unavailable(),
						modelRequestStarted: async () => {},
						admit: async () => unavailable(),
						update: async () => {},
					});
					try {
						if (
							!active &&
							latest.nativeTerminalCheckpoint !==
								(await restored.checkpoint?.())
						)
							unavailable();
						const recovered = active?.nativeCheckpoint
							? await restored.recover?.(active.nativeCheckpoint)
							: undefined;
						if (
							active &&
							recovered &&
							terminal(this.options.completionStatus(recovered.stopReason))
						) {
							const text = active.events
								.filter((event) => event.type === "text")
								.map((event) => event.payload.delta)
								.join("");
							if (recovered.text.startsWith(text)) {
								if (recovered.text.length > text.length)
									await this.event(file, active.executionId, {
										type: "text",
										payload: { delta: recovered.text.slice(text.length) },
									});
								await this.status(
									file,
									active.executionId,
									this.options.completionStatus(recovered.stopReason),
									recovered.stopReason,
									recovered.checkpoint,
								);
							}
						}
					} finally {
						await restored.close();
					}
				}
				// Preserve native checkpoint backfill before reconciling a retained result.
				for (const turn of file.read().turns)
					if (turn.nativeResult)
						await this.finishNativeResult(
							file,
							turn.executionId,
							turn.nativeResult,
						);
				return file;
			})().catch(() => unavailable());
			this.files.set(binding.ref, file);
		}
		return file;
	}
	private cancelled(ref: string) {
		return (
			this.index.read().barriers?.some((barrier) => barrier.ref === ref) ??
			false
		);
	}
	private async cancelGeneration(
		binding: Binding,
		command: Extract<RuntimeDriverCommand, { kind: "generation-cancel" }>,
	) {
		const previous = await this.index.update((state) => {
			state.barriers ??= [];
			const previous = state.barriers.find(
				(entry) =>
					entry.ref === binding.ref && entry.key === operationKey(command),
			);
			if (previous) {
				if (previous.digest !== digest(command)) conflict();
				return previous.record;
			}
			state.barriers.push({
				ref: binding.ref,
				key: operationKey(command),
				digest: digest(command),
			});
			return undefined;
		});
		if (previous) return previous;
		// The barrier does not depend on recoverable Turn history. Retire every owned
		// effect source and drain in-flight events before confirming this control operation.
		await this.files.get(binding.ref)?.catch(() => {});
		await this.retire(binding.ref);
		const record = result(command, binding.ref, {
			outcome: "accepted",
			status: "cancelled",
		});
		await this.index.update((state) => {
			const barrier = state.barriers?.find(
				(entry) =>
					entry.ref === binding.ref && entry.key === operationKey(command),
			);
			if (!barrier) unavailable();
			barrier.record = record;
		});
		// This receipt confirms generation retirement, never the original native Turn's outcome.
		return record;
	}
	private async forReference(ref: string) {
		const binding = this.index
			.read()
			.sessions.find((entry) => entry.ref === ref);
		if (!binding) unavailable();
		return this.file(binding);
	}
	async validateExternalAction(action: RuntimeExternalActionAuthorization) {
		if (this.closed || action.kind !== "tool" || action.purpose) unavailable();
		const file = await this.forReference(action.nativeSessionRef);
		const state = await file.readCommitted();
		const turn = state.turns.find(
			(entry) => entry.executionId === action.executionId,
		);
		const record = state.operations.find(
			(entry) => entry.key === turn?.operationKey,
		)?.record;
		const fact = turn?.events
			.filter(
				(event) =>
					event.type === "operation" &&
					event.payload.kind === "tool" &&
					event.payload.operationRef === action.operationRef &&
					event.payload.attemptRef === action.attemptRef,
			)
			.at(-1);
		if (
			this.closed ||
			state.cancelled ||
			turn?.status !== "running" ||
			!record ||
			record.operationId !== action.runtimeOperationId ||
			fact?.type !== "operation" ||
			fact.payload.phase !== "intent"
		)
			unavailable();
	}
	private exclusive<T>(ref: string, action: () => Promise<T>): Promise<T> {
		const task = (this.locks.get(ref) ?? Promise.resolve())
			.catch(() => {})
			.then(action);
		this.locks.set(ref, task);
		return task;
	}
	private toolExclusive<T>(ref: string, action: () => Promise<T>): Promise<T> {
		const task = (this.toolLocks.get(ref) ?? Promise.resolve())
			.catch(() => {})
			.then(action);
		this.toolLocks.set(ref, task);
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
			if (command.kind === "generation-cancel")
				return this.cancelGeneration(binding, command);
			const file = await this.file(binding);
			const previous = file
				.read()
				.operations.find((entry) => entry.key === operationKey(command));
			if (previous) {
				if (previous.digest !== digest(command)) conflict();
				const recovered = await this.recoverReceipt(file, command, previous);
				if (recovered) return recovered;
				if (
					previous.record &&
					(previous.record.result.outcome !== "unknown" ||
						command.kind !== "stop")
				)
					return previous.record;
				if (command.kind !== "stop")
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
			});
			if (!terminal(turn.status)) {
				const handle = this.handles.get(binding.ref);
				if (handle) {
					await handle.native.cancel().catch(() => {});
					await Promise.race([
						handle.pump,
						new Promise<void>((resolve) => {
							const timer = setTimeout(resolve, 2000);
							timer.unref();
						}),
					]);
				}
			}
			if (
				command.kind === "stop" &&
				!terminal(
					file
						.read()
						.turns.find((entry) => entry.executionId === turn.executionId)
						?.status ?? unavailable(),
				)
			)
				return this.resolve(file, command, unknownResult);

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
		if (before.cancelled || this.cancelled(ref)) unavailable();
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
		const inputText = command.input.text;
		const previousHandle = this.handles.get(ref);
		const reuse =
			previousHandle?.native.startTurn &&
			previousHandle.native.reusable?.() &&
			JSON.stringify(previousHandle.selection) === JSON.stringify(selection)
				? previousHandle
				: undefined;
		if (!reuse) await this.retire(ref);
		const directory = join(this.options.path, ref);
		const workspace = join(directory, "workspace");
		await mkdir(workspace, { recursive: true, mode: 0o700 });
		if ((await realpath(workspace)) !== workspace) unavailable();
		let admitted: () => void = () => {};
		const admission = new Promise<void>((resolve) => {
			admitted = resolve;
		});
		let dispatched = false;
		let modelUsage: Extract<RuntimeOperationFactV2, { kind: "model" }>["usage"];
		let currentModelOperationRef: string | undefined;
		let native: NativeSession;
		try {
			const sessionOptions: NativeSessionOptions = {
				directory,
				selection,
				admit: async () => {
					if (!dispatched || this.closed)
						throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
					await this.resolve(file, command, {
						outcome: "accepted",
						status: "running",
					});
					await this.status(
						file,
						command.executionId,
						"running",
						undefined,
						undefined,
						false,
					);
					admitted();
				},
				modelRequestIntent: async (request) => {
					currentModelOperationRef = await this.modelRequestIntent(
						file,
						command.executionId,
						request,
					);
				},
				modelRequestStarted: () =>
					this.modelRequestStarted(
						file,
						command.executionId,
						currentModelOperationRef,
					),
				modelRequestFinished: (state, usage) =>
					this.modelPhase(
						file,
						command.executionId,
						state,
						undefined,
						usage,
						currentModelOperationRef,
					),
				modelUsage: async (usage) => {
					modelUsage = usage;
				},
				toolRequestStarted: (tool) =>
					this.toolRequestStarted(file, command.executionId, tool),
				cwd: workspace,
				nativeId: before.nativeId,
				history: before.turns.at(-1)?.nativeTerminalCheckpoint
					? {
							checkpoint:
								before.turns.at(-1)?.nativeTerminalCheckpoint ?? unavailable(),
							complete: true,
						}
					: undefined,
				update: async (event) => {
					if (!dispatched) return;
					await this.resolve(file, command, {
						outcome: "accepted",
						status: "running",
					});
					if (
						file
							.read()
							.turns.find((turn) => turn.executionId === command.executionId)
							?.status !== "running"
					)
						await this.status(
							file,
							command.executionId,
							"running",
							undefined,
							undefined,
							false,
						);
					if (event) await this.event(file, command.executionId, event);
					admitted();
				},
			};
			if (reuse) {
				native = reuse.native;
				native.startTurn?.(sessionOptions);
			} else native = await this.options.openSession(sessionOptions);
		} catch {
			unavailable();
		}
		try {
			await file.update((state) => {
				state.nativeId = native.nativeId;
			});
		} catch {
			await native.close();
			this.handles.delete(ref);
			unavailable();
		}
		try {
			await native.select(option.nativeModelId, selection.reasoningLevel);
		} catch {
			await native.close();
			this.handles.delete(ref);
			return this.resolve(file, command, {
				outcome: "rejected",
				code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
				message: "Runtime model selection is unsupported",
				retryable: false,
			});
		}
		if (this.closed) {
			await native.close();
			unavailable();
		}
		try {
			const nativeCheckpoint = await native.checkpoint?.();
			await file.update((state) => {
				state.operations.push({
					key: operationKey(command),
					digest: digest(command),
				});
				state.turns.push({
					executionId: command.executionId,
					turnId: command.turnId,
					operationKey: operationKey(command),
					configVersion: this.options.configVersion,
					...(nativeCheckpoint ? { nativeCheckpoint } : {}),
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
					modelId: metadataId(
						option.modelFactId ?? option.nativeModelId,
						"model",
					),
					reasoningLevel: metadataId(selection.reasoningLevel, "reasoning"),
				},
			});
		} catch {
			await native.close();
			this.handles.delete(ref);
			unavailable();
		}
		dispatched = true;
		const handle: Handle = { native, selection, pump: Promise.resolve() };
		this.handles.set(ref, handle);
		handle.pump = (async () => {
			try {
				const response = await native.prompt(inputText);
				await this.resolve(file, command, {
					outcome: "accepted",
					status: "running",
				});
				await this.finishNativeResult(
					file,
					command.executionId,
					{
						status: this.options.completionStatus(response.stopReason),
						stopReason: response.stopReason,
						...(response.checkpoint ? { checkpoint: response.checkpoint } : {}),
					},
					modelUsage,
				);
				admitted();
			} catch {
				await this.status(file, command.executionId, "unknown");
			}
		})();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				admission,
				handle.pump,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 30000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
		return (
			file
				.read()
				.operations.find((entry) => entry.key === operationKey(command))
				?.record ?? result(command, ref, unknownResult)
		);
	}
	private async appendOperationFact(
		file: DurableJsonFile<Session>,
		executionId: string,
		fact: RuntimeOperationFactV2,
		requireAdmission = false,
	) {
		await file.update((state) => {
			const turn = state.turns.find(
				(entry) => entry.executionId === executionId,
			);
			// Model admission and its durable intent share this update lock.
			if (
				requireAdmission &&
				(!turn ||
					terminal(turn.status) ||
					turn.nativeResult ||
					state.turns.at(-1) !== turn)
			)
				unavailable();
			if (!turn || terminal(turn.status)) return;
			const previous = latestFact(turn, fact.kind, fact.operationRef);
			if (
				previous &&
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
					cursor: `${this.options.cursorPrefix}-operation-${adapterEventKey}`,
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
		operationRef?: string,
	) {
		const turn = file
			.read()
			.turns.find((entry) => entry.executionId === executionId);
		const previous =
			turn &&
			(operationRef
				? latestFact(turn, "model", operationRef)
				: generationFact(turn));
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
	private async recoverUnknownOperationFacts(
		file: DurableJsonFile<Session>,
		executionId: string,
	) {
		const turn = file
			.read()
			.turns.find((entry) => entry.executionId === executionId);
		if (!turn) return;
		const pending: RuntimeOperationFactV2[] = [];
		const seen = new Set<string>();
		for (let index = turn.events.length - 1; index >= 0; index--) {
			const event = turn.events[index];
			if (event?.type !== "operation") continue;
			const key = `${event.payload.operationRef}:${event.payload.attemptRef}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (["intent", "started"].includes(event.payload.phase))
				pending.push(event.payload);
		}
		for (const fact of pending) {
			await this.appendOperationFact(file, executionId, {
				...fact,
				phase: "unknown",
				failureCode: "recovery_unconfirmed",
			});
		}
	}
	private async modelRequestIntent(
		file: DurableJsonFile<Session>,
		executionId: string,
		request?: "messages" | "count_tokens",
	) {
		const turn = file
			.read()
			.turns.find((entry) => entry.executionId === executionId);
		const previous = turn && generationFact(turn);
		if (previous?.kind !== "model") unavailable();
		if (request === "count_tokens") {
			const operationRef = randomUUID();
			await this.appendOperationFact(
				file,
				executionId,
				{
					kind: "model",
					operationRef,
					attemptRef: randomUUID(),
					phase: "intent",
					model: previous.model,
				},
				true,
			);
			return operationRef;
		}
		if (previous.phase === "intent") {
			await this.appendOperationFact(file, executionId, previous, true);
			return previous.operationRef;
		}
		if (previous.phase === "completed") {
			const {
				phase: _phase,
				startedAt: _startedAt,
				finishedAt: _finishedAt,
				durationMs: _durationMs,
				failureCode: _failureCode,
				usage: _usage,
				...base
			} = previous;
			await this.appendOperationFact(
				file,
				executionId,
				{
					...base,
					attemptRef: randomUUID(),
					phase: "intent",
				},
				true,
			);
			return previous.operationRef;
		}
		unavailable();
	}
	private async modelRequestStarted(
		file: DurableJsonFile<Session>,
		executionId: string,
		operationRef?: string,
	) {
		const turn = file
			.read()
			.turns.find((entry) => entry.executionId === executionId);
		if (
			turn &&
			(operationRef
				? latestFact(turn, "model", operationRef)
				: generationFact(turn)
			)?.phase === "intent"
		)
			await this.modelPhase(
				file,
				executionId,
				"started",
				undefined,
				undefined,
				operationRef,
			);
		else unavailable();
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
			const legacyCursor = nextLegacyCursor(
				state.turns,
				this.options.cursorPrefix,
			);
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
	private async toolRequestStarted(
		file: DurableJsonFile<Session>,
		executionId: string,
		value: {
			readonly toolCallId: string;
			readonly name: string;
			readonly permitted?: boolean;
			readonly executionBoundary?: true;
		},
	) {
		const ref = file.read().binding.ref;
		const created = await this.toolExclusive(ref, async () => {
			const turn = file
				.read()
				.turns.find((entry) => entry.executionId === executionId);
			if (!turn || terminal(turn.status)) unavailable();
			const identity = turn.toolOperations?.[value.toolCallId];
			// A repeated execute may already have caused effects even if its native
			// terminal was lost. It must never receive a second business permit.
			if (value.executionBoundary && identity) unavailable();
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
			if (previous && ["intent", "started"].includes(previous.phase)) {
				if (value.permitted === false)
					await this.toolPhase(file, executionId, {
						toolCallId: value.toolCallId,
						name: value.name,
						phase: "failed",
						failureCode: "authorization_denied",
					});
				return;
			}
			const model = generationFact(turn);
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
			if (value.permitted === false)
				await this.toolPhase(file, executionId, {
					toolCallId: value.toolCallId,
					name: value.name,
					phase: "failed",
					failureCode: "authorization_denied",
				});
			return created;
		});
		if (value.executionBoundary) {
			if (!created || !this.options.authorizeExternalAction) unavailable();
			const state = file.read();
			const turn = state.turns.find(
				(entry) => entry.executionId === executionId,
			);
			const record = state.operations.find(
				(entry) => entry.key === turn?.operationKey,
			)?.record;
			if (!record) unavailable();
			const action = {
				nativeSessionRef: ref,
				executionId,
				runtimeOperationId: record.operationId,
				operationRef: created.operationRef,
				attemptRef: created.attemptRef,
				kind: "tool" as const,
			};
			// Host authorization may read the same durable file. Never hold its
			// mutation/tool queue while waiting for the current business authority.
			await this.validateExternalAction(action);
			// The Host rechecks current authority after its Driver inspection. No
			// queued durable read may separate that final gate from this permit.
			await this.options.authorizeExternalAction(action);
		}
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
			if (!previous) return;
			if (previous.phase !== "intent") return;
			const startedAt = new Date().toISOString();
			await this.appendOperationFact(file, executionId, {
				...previous,
				phase: "started",
				startedAt,
			});
			return;
		}
		if (!previous) return;
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
	private async finishNativeResult(
		file: DurableJsonFile<Session>,
		executionId: string,
		receipt: NonNullable<Turn["nativeResult"]>,
		usage?: Extract<RuntimeOperationFactV2, { kind: "model" }>["usage"],
	) {
		if (!terminal(receipt.status))
			return this.status(file, executionId, receipt.status);
		await file.update((state) => {
			const turn = state.turns.find(
				(entry) => entry.executionId === executionId,
			);
			if (!turn || terminal(turn.status)) return;
			if (
				!receipt.stopReason ||
				this.options.completionStatus(receipt.stopReason) !== receipt.status ||
				(turn.nativeCheckpoint && !receipt.checkpoint) ||
				(turn.nativeResult &&
					JSON.stringify(turn.nativeResult) !== JSON.stringify(receipt))
			)
				unavailable();
			turn.nativeResult = receipt;
		});
		const ref = file.read().binding.ref;
		for (;;) {
			let wake = () => {};
			const changed = new Promise<void>((resolve) => {
				wake = resolve;
			});
			const waiters = this.waiters.get(ref) ?? new Set<() => void>();
			this.waiters.set(ref, waiters);
			waiters.add(wake);
			try {
				const turn = (await file.readCommitted()).turns.find(
					(entry) => entry.executionId === executionId,
				);
				if (!turn || terminal(turn.status)) return;
				const counts = auxiliaryRequestState(turn);
				if (counts === "pending") {
					await changed;
					continue;
				}
				if (counts === "unconfirmed") {
					if (turn.status !== "unknown")
						await this.status(file, executionId, "unknown");
					return;
				}
				return this.status(
					file,
					executionId,
					receipt.status,
					receipt.stopReason,
					receipt.checkpoint,
					true,
					usage,
				);
			} finally {
				waiters.delete(wake);
			}
		}
	}
	private async status(
		file: DurableJsonFile<Session>,
		executionId: string,
		status: RuntimeStatusV1,
		nativeStopReason?: string,
		nativeTerminalCheckpoint?: string,
		markModel = true,
		usage?: Extract<RuntimeOperationFactV2, { kind: "model" }>["usage"],
	) {
		if (markModel && status === "running")
			await this.modelPhase(file, executionId, "started");
		else if (status === "completed")
			await this.modelPhase(
				file,
				executionId,
				this.options.modelLifecycleAtTransport ? "unknown" : "completed",
				this.options.modelLifecycleAtTransport
					? "recovery_unconfirmed"
					: undefined,
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
			// Completion cannot make an admitted count receipt unwritable.
			if (
				terminal(status) &&
				(auxiliaryRequestState(turn) === "pending" ||
					(turn.nativeResult && auxiliaryRequestState(turn) !== "settled"))
			)
				unavailable();
			if (terminal(status)) {
				if (
					!nativeStopReason ||
					this.options.completionStatus(nativeStopReason) !== status
				)
					unavailable();
				turn.nativeStopReason = nativeStopReason;
				if (turn.nativeCheckpoint && !nativeTerminalCheckpoint) unavailable();
				if (nativeTerminalCheckpoint)
					turn.nativeTerminalCheckpoint = nativeTerminalCheckpoint;
			}
			if (status === "failed") {
				state.sequence++;
				const legacyCursor = nextLegacyCursor(
					state.turns,
					this.options.cursorPrefix,
				);
				turn.events.push(
					RuntimeEventV1Schema.parse({
						schemaVersion: 1,
						executionId,
						adapterEventKey: randomUUID(),
						cursor: legacyCursor,
						occurredAt: new Date().toISOString(),
						type: "error",
						payload: {
							code: "RUNTIME_EXECUTION_FAILED",
							message: "Runtime execution failed",
							retryable: false,
						},
					}),
				);
			}

			state.sequence++;
			const legacyCursor = nextLegacyCursor(
				state.turns,
				this.options.cursorPrefix,
			);
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
		if (!handle) {
			await this.options.retireSession(join(this.options.path, ref));
			return;
		}
		await handle.native.close();
		await handle.pump;
		this.handles.delete(ref);
	}
	close() {
		this.closed = true;
		this.closing ??= (async () => {
			for (const waiters of this.waiters.values())
				for (const wake of waiters) wake();
			await Promise.allSettled([...this.pending]);
			await Promise.all(
				[...this.handles.keys()].map((ref) => this.retire(ref)),
			);
		})();
		return this.closing;
	}

	private async recoverReceipt(
		file: DurableJsonFile<Session>,
		command: RuntimeDriverCommand,
		previous: Operation,
	) {
		if (
			command.kind !== "submit-turn" ||
			(previous.record && previous.record.result.outcome !== "unknown")
		)
			return;
		const turn = file
			.read()
			.turns.find(
				(turn) =>
					turn.operationKey === previous.key &&
					turn.executionId === command.executionId &&
					turn.turnId === command.turnId,
			);
		// Reconstruct only the receipt for the digest-matching original command from a
		// confirmed native terminal. Never infer acceptance from an ACK or an idle process.
		if (turn && terminal(turn.status))
			return this.resolve(file, command, {
				outcome: "accepted",
				status: "running",
			});
	}
	async lookupOperation(
		command: RuntimeDriverCommand,
	): Promise<RuntimeDriverLookup> {
		const binding = await this.binding(command, false);
		if (!binding) return { state: "missing" };
		if (command.kind === "generation-cancel") {
			const barrier = this.index
				.read()
				.barriers?.find(
					(entry) =>
						entry.ref === binding.ref && entry.key === operationKey(command),
				);
			if (!barrier) return { state: "missing" };
			if (barrier.digest !== digest(command)) conflict();
			return {
				state: "found",
				record: barrier.record ?? (await this.execute(command)),
			};
		}
		const file = await this.file(binding);
		const previous = file
			.read()
			.operations.find((entry) => entry.key === operationKey(command));
		if (!previous) return { state: "missing" };
		if (previous.digest !== digest(command)) conflict();
		const recovered = await this.recoverReceipt(file, command, previous);
		if (recovered) return { state: "found", record: recovered };
		if (
			command.kind === "stop" &&
			previous.record?.result.outcome === "unknown"
		) {
			const turn = file
				.read()
				.turns.find(
					(turn) =>
						turn.executionId === command.executionId &&
						turn.turnId === command.turnId,
				);
			if (turn && terminal(turn.status))
				return {
					state: "found",
					record: await this.resolve(file, command, {
						outcome: "accepted",
						status: turn.status,
					}),
				};
		}
		if (!previous.record && command.kind === "stop")
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
