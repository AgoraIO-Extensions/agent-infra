import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { FileProjectionV1Schema } from "@agent-infra/contracts/files";
import {
	type BrowserCapabilityAvailableV1,
	type NativeMetadataProjectionV1,
	type NativeMetadataSelectorV1,
	RuntimeCapabilitiesV1Schema,
	RuntimeDriverCommandV1Schema,
	RuntimeDriverOperationRecordV1Schema,
	RuntimeDriverSubmitTurnCommandV2Schema,
	RuntimeDriverSubmitTurnOperationRecordV2Schema,
	type RuntimeEventV1,
	RuntimeEventV1Schema,
	type RuntimeOperationFactV2,
	RuntimeOperationFactV2Schema,
	type RuntimeSelectionV1,
	RuntimeSelectionV1Schema,
	type RuntimeStatusV1,
	RuntimeStatusV1Schema,
} from "@agent-infra/contracts/runtime";
import { createCodexBrowserToolDescriptorsV1 } from "./codex-browser-tools.js";
import type {
	RuntimeDriver,
	RuntimeDriverCommand,
	RuntimeDriverLookup,
	RuntimeDriverOperationRecord,
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
	RuntimeModelCredentialResolver,
	RuntimeModelDirectory,
	RuntimeNativeMetadataReadContextV1,
	RuntimeOperationFactInputV1,
} from "./driver.js";
import {
	driverRequestDigest as digest,
	driverOperationKey as operationKey,
	driverOperationResult as result,
} from "./driver-operation.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";
import {
	projectNativeMetadataCommandsV1,
	projectNativeMetadataSkillsV1,
} from "./native-metadata-projection.js";
import { runtimeAuthorizationDenied } from "./runtime-authorization.js";
import { readRuntimeFileResultReceiptV1 } from "./runtime-file-bridge.js";
import {
	boundedRuntimeSkillRead,
	type RuntimeFilesystemSkillDirectoryV1,
	RuntimeSkillDirectoryErrorV1,
} from "./skill-hub-directory.js";

/**
 * Structured native prompt content. Drivers that keep a string-only native
 * protocol receive the plain text form; image-capable drivers receive the
 * validated blocks instead of provider-specific text encodings.
 */
export type NativePromptContentV1 = Readonly<
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
>;
export type NativePromptV1 = string | readonly NativePromptContentV1[];

/** Image media types a Session native prompt can render as image content. */
const nativePromptImageMediaTypes = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);
const nativePromptMaximumImageBytes = 50 * 1024 * 1024;

/**
 * Releases one attachment transfer that was rejected or interrupted. A body
 * that never reached the native Turn must not stay live upstream.
 */
async function cancelNativePromptReader(
	reader: ReadableStreamDefaultReader<Uint8Array>,
) {
	try {
		await reader.cancel();
	} catch {
		// An already closed or upstream-owned body needs no further release.
	} finally {
		reader.releaseLock();
	}
}

export interface SessionRuntimeModelOption {
	readonly modelOptionId: string;
	readonly nativeModelId: string;
	readonly reasoningLevels: readonly string[];
}
export interface SessionRuntimeDriverOptions {
	/** Deployment-owned verified Browser projection; never selected by a wire command. */
	readonly browserCapability?: BrowserCapabilityAvailableV1;
	readonly path: string;
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly modelOptions: readonly SessionRuntimeModelOption[];
	readonly supportsAttachments?: boolean;
	/** Set only when the native adapter supplies a confirmed result-file callback. */
	readonly supportsResultFiles?: boolean;
	/**
	 * Per-peer image input negotiation for Drivers whose native protocol decides
	 * it before a Session exists (ACP): `false` rejects attachment input before
	 * any bridge read or Session side effect. Drivers without per-peer
	 * negotiation leave this unset and rely on `supportsAttachments`.
	 */
	readonly attachmentsNegotiated?: () => boolean;
	/** Deployment-owned verified Skill Hub generation; never selected by a wire command. */
	readonly skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
	readonly cursorPrefix: string;
	readonly openSession: (
		options: NativeSessionOptions,
	) => Promise<NativeSession>;
	readonly retireSession: (directory: string) => Promise<void>;
	readonly completionStatus: (reason: string) => RuntimeStatusV1;
	readonly authorizeModelAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
}
export interface NativeSessionOptions {
	directory: string;
	cwd: string;
	nativeId?: string;
	history?: { checkpoint: string; complete: boolean };
	selection: RuntimeSelectionV1;
	/** Request-local execution identity for Browser adapters; never persisted here. */
	readonly executionId?: string;
	admit: () => Promise<void>;
	resolveModelCredential?: RuntimeModelCredentialResolver;
	/** Request-local Browser context; never persisted or selected by native input. */
	readonly browser?: import("./driver.js").RuntimeBrowserExecutionContextV1;
	/** Request-local producer seam for adapter-owned model/tool operation facts. */
	readonly recordOperationFact?: (
		fact: RuntimeOperationFactV2,
	) => Promise<void>;
	readonly modelFact?: () =>
		| Extract<RuntimeOperationFactV2, { kind: "model" }>["model"]
		| undefined;
	readonly recordToolOperation?: (
		toolId: string,
		phase: "started" | "completed" | "failed",
	) => Promise<void>;
	readonly skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
	readonly resultFile?: (input: {
		readonly path: string;
		readonly content: string;
	}) => Promise<void>;
	update: (event?: Pick<RuntimeEventV1, "type" | "payload">) => Promise<void>;
}
export interface NativeSession {
	nativeId: string;
	/**
	 * Negotiated image input support for this Session. `false` means the native
	 * Session explicitly refused structured image content, for example an ACP
	 * peer that did not negotiate `promptCapabilities.image`; absent leaves the
	 * decision to the Driver's `supportsAttachments` declaration.
	 */
	supportsImagePrompt?: boolean;
	select(model: string, effort: string): Promise<void>;
	prompt(
		prompt: NativePromptV1,
	): Promise<{ stopReason: string; checkpoint?: string }>;
	reusable?(): boolean;
	startTurn?(options: NativeSessionOptions): void;
	/** Whether this native Session can be reused for the next request-local context. */
	reuseFor?(next: Pick<NativeSessionOptions, "browser">): boolean;
	checkpoint?(): Promise<string>;
	recover?(
		checkpoint: string,
	): Promise<
		{ stopReason: string; text: string; checkpoint?: string } | undefined
	>;
	cancel(): Promise<void>;
	close(): Promise<void>;
	/** Native IDs are mapped to public option IDs by SessionRuntimeDriver. */
	modelSelection?(): {
		models: readonly string[];
		currentModel: string | null;
		reasoningLevels: readonly string[];
		currentReasoning: string | null;
	};
	discoverCommands?(input: {
		readonly signal: AbortSignal;
		readonly expiresAt: number;
		readonly allowedRoots: readonly string[];
	}): Promise<unknown>;
}

export type SessionNativeCommandReadContext = Readonly<{
	nativeSessionRef: string;
	signal: AbortSignal;
	expiresAt: number;
	assertCurrent(): void;
	revalidate(): Promise<void>;
}>;

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
	events: RuntimeEventV1[];
	/** Durable metadata-only facts emitted by shared non-Codex operation adapters. */
	operationFacts?: RuntimeOperationFactV2[];
	operationRef?: string;
	attemptRef?: string;
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
function nativeMetadataUnsupported(): never {
	throw new RuntimeHostError(
		"RUNTIME_NATIVE_METADATA_UNSUPPORTED",
		"Native metadata selector is unavailable for this runtime",
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

export class SessionRuntimeDriver implements RuntimeDriver {
	private readonly files = new Map<string, Promise<DurableJsonFile<Session>>>();
	private readonly locks = new Map<string, Promise<unknown>>();
	private readonly handles = new Map<string, Handle>();
	private readonly waiters = new Map<string, Set<() => void>>();
	private closed = false;
	private readonly pending = new Set<Promise<RuntimeDriverOperationRecord>>();
	private closing?: Promise<void>;
	private constructor(
		private readonly options: SessionRuntimeDriverOptions,
		private readonly index: DurableJsonFile<Index>,
	) {}
	async validateExternalAction(
		action: import("./driver.js").RuntimeExternalActionAuthorization,
	) {
		if (action.runtimeOperationId !== action.executionId)
			runtimeAuthorizationDenied();
		let binding: Binding | undefined;
		let file: DurableJsonFile<Session> | undefined;
		for (const entry of this.index.read().sessions) {
			const candidate = await this.file(entry);
			if (candidate.read().nativeId === action.nativeSessionRef) {
				binding = entry;
				file = candidate;
				break;
			}
		}
		if (!binding || !file) runtimeAuthorizationDenied();
		const turn = file
			.read()
			.turns.find((item) => item.executionId === action.executionId);
		if (!turn) runtimeAuthorizationDenied();
		if (
			action.kind === "model" &&
			(turn.operationRef !== action.operationRef ||
				turn.attemptRef !== action.attemptRef)
		)
			runtimeAuthorizationDenied();
		if (turn.operationFacts !== undefined) {
			const fact = turn.operationFacts
				.filter(
					(value) =>
						value.operationRef === action.operationRef &&
						value.attemptRef === action.attemptRef &&
						value.kind === action.kind,
				)
				.at(-1);
			if (!fact || (fact.phase !== "intent" && fact.phase !== "started"))
				runtimeAuthorizationDenied();
		} else if (action.kind === "tool") {
			runtimeAuthorizationDenied();
		}
	}

	/** Append one durable operation fact and acknowledge its journal commit. */
	async recordOperationFact(input: RuntimeOperationFactInputV1): Promise<void> {
		if (this.closed) unavailable();
		const binding = this.index
			.read()
			.sessions.find((entry) => entry.ref === input.nativeSessionRef);
		if (!binding) unavailable();
		const file = await this.file(binding);
		await this.exclusive(binding.ref, () =>
			this.recordFact(file, input.executionId, input.fact),
		);
	}

	private async recordFact(
		file: DurableJsonFile<Session>,
		executionId: string,
		input: RuntimeOperationFactV2,
	): Promise<void> {
		const fact = RuntimeOperationFactV2Schema.parse(input);
		await file.update((state) => {
			const turn = state.turns.find(
				(entry) => entry.executionId === executionId,
			);
			if (!turn || terminal(turn.status))
				throw new RuntimeHostError(
					"RUNTIME_OPERATION_CONFLICT",
					"Runtime operation fact is no longer current",
					409,
				);
			turn.operationFacts ??= [];
			const previous = turn.operationFacts
				.filter(
					(entry) =>
						entry.operationRef === fact.operationRef &&
						entry.attemptRef === fact.attemptRef,
				)
				.at(-1);
			const duplicate =
				previous &&
				previous.kind === fact.kind &&
				JSON.stringify(previous) === JSON.stringify(fact);
			if (duplicate) return;
			if (turn.operationFacts.length >= 256)
				throw new RuntimeHostError(
					"RUNTIME_OPERATION_CONFLICT",
					"Runtime operation fact journal is full",
					409,
				);
			if (!previous) {
				if (fact.phase !== "intent")
					throw new RuntimeHostError(
						"RUNTIME_OPERATION_CONFLICT",
						"Runtime operation must start with intent",
						409,
					);
			} else if (
				previous.kind !== fact.kind ||
				(previous.phase !== "intent" && previous.phase !== "started") ||
				fact.phase === "intent"
			)
				throw new RuntimeHostError(
					"RUNTIME_OPERATION_CONFLICT",
					"Runtime operation fact transition is invalid",
					409,
				);
			turn.operationFacts.push(fact);
		});
	}
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
					let completed = false;
					for (const event of turn.events) {
						sequence++;
						if (
							completed ||
							!RuntimeEventV1Schema.safeParse(event).success ||
							event.executionId !== turn.executionId ||
							event.cursor !== `${this.options.cursorPrefix}-${sequence}` ||
							eventKeys.has(event.adapterEventKey)
						)
							unavailable();
						eventKeys.add(event.adapterEventKey);
						if (event.type === "completed") {
							completed = true;
							if (event.payload.status !== turn.status) unavailable();
						}
					}
					const operationFacts = turn.operationFacts ?? [];
					if (!Array.isArray(operationFacts)) unavailable();
					const factKeys = new Set<string>();
					const latestFacts = new Map<string, RuntimeOperationFactV2>();
					for (const rawFact of operationFacts) {
						const fact = RuntimeOperationFactV2Schema.parse(rawFact);
						const key = JSON.stringify([fact.operationRef, fact.attemptRef]);
						if (factKeys.has(key)) {
							const previous = latestFacts.get(key);
							if (
								!previous ||
								(previous.phase !== "intent" && previous.phase !== "started") ||
								(fact.phase === "intent" && previous.phase !== "intent")
							)
								unavailable();
						} else if (fact.phase !== "intent") unavailable();
						factKeys.add(key);
						latestFacts.set(key, fact);
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
				const active = state.turns.find((turn) => !terminal(turn.status));
				const latest = active ?? state.turns.at(-1);
				if (
					latest &&
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
						admit: async () => unavailable(),
						skillDirectory: this.options.skillDirectory,
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
	private exclusive<T>(ref: string, action: () => Promise<T>): Promise<T> {
		const task = (this.locks.get(ref) ?? Promise.resolve())
			.catch(() => {})
			.then(action);
		this.locks.set(ref, task);
		return task;
	}
	execute(
		value: RuntimeDriverCommand,
		context?: import("./driver.js").RuntimeDriverExecutionContextV1,
	): Promise<RuntimeDriverOperationRecord> {
		if (this.closed)
			return Promise.reject(
				new RuntimeHostError(
					"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
					"Runtime session could not be recovered",
					503,
				),
			);
		const operation = this.executeCommand(value, context);
		this.pending.add(operation);
		void operation.then(
			() => this.pending.delete(operation),
			() => this.pending.delete(operation),
		);
		return operation;
	}
	private async executeCommand(
		value: RuntimeDriverCommand,
		context?: import("./driver.js").RuntimeDriverExecutionContextV1,
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
			if (command.kind === "submit-turn")
				return this.submit(
					file,
					command,
					context?.fileBridge,
					context?.browser,
				);
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
	/**
	 * Read request-scoped bridge attachments into native prompt content. Callers
	 * confirm native image support first, so unsupported input never reaches the
	 * bridge and never consumes file authority.
	 */
	private async materializeAttachmentInput(
		text: string,
		attachments: readonly string[],
		fileBridge?: import("./runtime-file-bridge.js").RuntimeFileBridgePortV1,
	): Promise<readonly NativePromptContentV1[]> {
		if (!fileBridge) unavailable();
		const content: NativePromptContentV1[] = [{ type: "text", text }];
		for (const fileId of attachments) {
			const file = await fileBridge.readInput(fileId);
			if (
				file.fileId !== fileId ||
				!nativePromptImageMediaTypes.has(file.descriptor.mediaType) ||
				file.descriptor.sizeBytes > nativePromptMaximumImageBytes
			) {
				await cancelNativePromptReader(file.body.getReader());
				unavailable();
			}
			const reader = file.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					if (!(next.value instanceof Uint8Array)) unavailable();
					size += next.value.byteLength;
					if (size > nativePromptMaximumImageBytes) unavailable();
					chunks.push(next.value);
				}
			} finally {
				await cancelNativePromptReader(reader);
			}
			const bytes = Buffer.concat(chunks);
			if (
				size !== file.descriptor.sizeBytes ||
				createHash("sha256").update(bytes).digest("hex") !==
					file.descriptor.sha256
			)
				unavailable();
			content.push({
				type: "image",
				data: bytes.toString("base64"),
				mimeType: file.descriptor.mediaType,
			});
		}
		return content;
	}
	/**
	 * Roll back the durable Turn admitted for an attachment request whose File
	 * Grant lapsed before the native boundary. Nothing was dispatched, so the
	 * request must not stay recorded as an unknown Turn that may have run.
	 */
	private async discardTurn(file: DurableJsonFile<Session>, command: Submit) {
		await file.update((state) => {
			state.turns = state.turns.filter(
				(turn) => turn.executionId !== command.executionId,
			);
			state.operations = state.operations.filter(
				(entry) => entry.key !== operationKey(command),
			);
		});
	}
	private async submit(
		file: DurableJsonFile<Session>,
		command: Submit,
		fileBridge?: import("./runtime-file-bridge.js").RuntimeFileBridgePortV1,
		browser?: import("./driver.js").RuntimeBrowserExecutionContextV1,
	) {
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
		if (!("text" in command.input)) unavailable();
		const hasAttachments = command.input.attachments.length > 0;
		// Attachment input needs both a wired bridge and a Driver that consumes
		// it; neither decision may wait for a Session or a bridge read.
		if (hasAttachments && (!this.options.supportsAttachments || !fileBridge))
			unavailable();
		// A Driver whose native protocol negotiates image input per peer settles
		// that before a Session exists, so unsupported input is rejected before
		// the bridge is read and before any native Session side effect.
		if (hasAttachments && this.options.attachmentsNegotiated?.() === false)
			unavailable();
		let input: NativePromptV1 = command.input.text;
		// Attachment bytes were read under the File Grant of this request; they must
		// not cross into a native Turn once that authority has lapsed.
		const revalidateInput = () => {
			if (hasAttachments) fileBridge?.revalidate();
		};
		if (hasAttachments) {
			input = await this.materializeAttachmentInput(
				command.input.text,
				command.input.attachments,
				fileBridge,
			);
			revalidateInput();
		}
		const previousHandle = this.handles.get(ref);
		const reuse =
			previousHandle?.native.startTurn &&
			previousHandle.native.reusable?.() &&
			(previousHandle.native.reuseFor?.({ browser }) ?? true) &&
			JSON.stringify(previousHandle.selection) === JSON.stringify(selection)
				? previousHandle
				: undefined;
		if (!reuse) await this.retire(ref);
		const directory = join(this.options.path, ref);
		const workspace = join(directory, "workspace");
		await mkdir(workspace, { recursive: true, mode: 0o700 });
		if ((await realpath(workspace)) !== workspace) unavailable();
		let resultFileWritten = false;
		let resultFileInFlight = false;
		const resultFile = fileBridge
			? async (input: { path: string; content: string }) => {
					if (resultFileWritten || !isAbsolute(input.path)) return;
					const root = await realpath(workspace).catch(() => undefined);
					if (!root) return;
					const candidate = isAbsolute(input.path)
						? resolve(input.path)
						: resolve(root, input.path);
					const within = relative(root, candidate);
					if (!within || within.startsWith("..") || isAbsolute(within)) return;
					const bytes = Buffer.from(input.content, "utf8");
					if (bytes.byteLength > 10 * 1024 * 1024) return;
					const bindingRecord = await this.binding(command, false).catch(
						() => undefined,
					);
					if (!bindingRecord) return;
					const state = await this.file(bindingRecord)
						.then((current) => current.read())
						.catch(() => undefined);
					const turn = state?.turns.find(
						(candidate) => candidate.executionId === command.executionId,
					);
					if (!turn || terminal(turn.status)) return;
					if (resultFileInFlight) return;
					resultFileInFlight = true;
					try {
						const receipt = await fileBridge.writeResult(
							{
								name: basename(within),
								mediaType: "text/plain",
								sizeBytes: bytes.byteLength,
								sha256: createHash("sha256").update(bytes).digest("hex"),
							},
							new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(bytes);
									controller.close();
								},
							}),
						);
						await this.recordResultFile(command, receipt);
						resultFileWritten = true;
					} finally {
						resultFileInFlight = false;
					}
				}
			: undefined;
		let admitted: () => void = () => {};
		const operationRef = randomUUID();
		const attemptRef = randomUUID();
		let activeNativeSessionRef = before.nativeId ?? "";
		const resolveModelCredential = this.options.authorizeModelAction
			? async () => {
					const authorized = await this.options.authorizeModelAction?.({
						kind: "model",
						nativeSessionRef: activeNativeSessionRef,
						executionId: command.executionId,
						runtimeOperationId: command.executionId,
						operationRef,
						attemptRef,
					});
					if (!authorized?.relayKey)
						throw new Error("RUNTIME_AUTHORIZATION_DENIED");
					return authorized.relayKey;
				}
			: undefined;
		const admission = new Promise<void>((resolve) => {
			admitted = resolve;
		});
		let dispatched = false;
		const toolFacts = new Map<
			string,
			{ operationRef: string; attemptRef: string; startedAt: number }
		>();
		const recordToolOperation = async (
			toolId: string,
			phase: "started" | "completed" | "failed",
		) => {
			if (phase === "started") {
				const operationRef = randomUUID();
				const attemptRef = randomUUID();
				const startedAt = Date.now();
				await this.recordFact(file, command.executionId, {
					kind: "tool",
					operationRef,
					attemptRef,
					phase: "intent",
					toolId,
				});
				await this.recordFact(file, command.executionId, {
					kind: "tool",
					operationRef,
					attemptRef,
					phase: "started",
					startedAt: new Date(startedAt).toISOString(),
					toolId,
				});
				toolFacts.set(`${toolId}:${toolFacts.size}`, {
					operationRef,
					attemptRef,
					startedAt,
				});
				return;
			}
			const latest = [...toolFacts.entries()].at(-1);
			if (!latest) return;
			const [, fact] = latest;
			await this.recordFact(file, command.executionId, {
				kind: "tool",
				operationRef: fact.operationRef,
				attemptRef: fact.attemptRef,
				phase,
				finishedAt: new Date().toISOString(),
				durationMs: Math.max(0, Date.now() - fact.startedAt),
				...(phase === "failed"
					? { failureCode: "operation_failed" as const }
					: {}),
				toolId,
			});
			toolFacts.delete(latest[0]);
		};
		let native: NativeSession;
		try {
			const sessionOptions: NativeSessionOptions = {
				directory,
				executionId: command.executionId,
				selection,
				admit: async () => {
					if (!dispatched || this.closed)
						throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
					await this.resolve(file, command, {
						outcome: "accepted",
						status: "running",
					});
					await this.status(file, command.executionId, "running");
					admitted();
				},
				...(resolveModelCredential ? { resolveModelCredential } : {}),
				...(browser ? { browser } : {}),
				recordOperationFact: (fact) =>
					this.recordFact(file, command.executionId, fact),
				recordToolOperation,
				modelFact: () => ({
					configVersion: this.options.configVersion,
					modelOptionId: selection.modelOptionId,
					modelId: option.nativeModelId.replace(/[^A-Za-z0-9._:-]/g, "_"),
					reasoningLevel: selection.reasoningLevel,
				}),
				cwd: workspace,
				nativeId: before.nativeId,
				skillDirectory: this.options.skillDirectory,
				...(resultFile ? { resultFile } : {}),
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
						await this.status(file, command.executionId, "running");
					if (event) await this.event(file, command.executionId, event);
					admitted();
				},
			};
			if (reuse) {
				native = reuse.native;
				native.startTurn?.(sessionOptions);
			} else native = await this.options.openSession(sessionOptions);
			activeNativeSessionRef = native.nativeId;
		} catch {
			unavailable();
		}
		// The opened Session has the last word on negotiated image input: a Session
		// that refuses image content must never reach the native Turn.
		if (hasAttachments && native.supportsImagePrompt === false) {
			if (!reuse) await native.close().catch(() => {});
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
			// Native initialization is asynchronous; the File Grant must still hold
			// immediately before validated bytes cross into the native Turn.
			revalidateInput();
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
					operationFacts: [],
					operationRef,
					attemptRef,
				});
			});
		} catch {
			await native.close();
			this.handles.delete(ref);
			unavailable();
		}
		const handle: Handle = { native, selection, pump: Promise.resolve() };
		this.handles.set(ref, handle);
		let preDispatchFailure = false;
		handle.pump = (async () => {
			if (hasAttachments) {
				try {
					// Materialized bytes must never reach the native session under
					// authority that lapsed during Session setup or model selection.
					revalidateInput();
				} catch {
					// Nothing reached the native Session, so the admitted Turn is
					// rolled back rather than retained as an unknown Turn that may or
					// may not have been accepted.
					preDispatchFailure = true;
					await this.discardTurn(file, command);
					if (!reuse) {
						await native.close().catch(() => {});
						this.handles.delete(ref);
					}
					return;
				}
			}
			try {
				// Only a Turn that passed the native boundary counts as dispatched.
				dispatched = true;
				const response = await native.prompt(input);
				await this.resolve(file, command, {
					outcome: "accepted",
					status: "running",
				});
				await this.status(
					file,
					command.executionId,
					this.options.completionStatus(response.stopReason),
					response.stopReason,
					response.checkpoint,
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
		if (preDispatchFailure) unavailable();
		return (
			file
				.read()
				.operations.find((entry) => entry.key === operationKey(command))
				?.record ?? result(command, ref, unknownResult)
		);
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
					cursor: `${this.options.cursorPrefix}-${state.sequence}`,
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
		nativeStopReason?: string,
		nativeTerminalCheckpoint?: string,
	) {
		await file.update((state) => {
			const turn = state.turns.find((turn) => turn.executionId === executionId);
			if (!turn || terminal(turn.status)) return;
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
				turn.events.push(
					RuntimeEventV1Schema.parse({
						schemaVersion: 1,
						executionId,
						adapterEventKey: randomUUID(),
						cursor: `${this.options.cursorPrefix}-${state.sequence}`,
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
			turn.events.push(
				RuntimeEventV1Schema.parse({
					schemaVersion: 1,
					executionId,
					adapterEventKey: randomUUID(),
					cursor: `${this.options.cursorPrefix}-${state.sequence}`,
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

	/** Read bounded non-Codex metadata without opening a native Turn. */
	async readNativeMetadataV1(
		selector: NativeMetadataSelectorV1,
		read: RuntimeNativeMetadataReadContextV1,
	): Promise<NativeMetadataProjectionV1> {
		read.assertCurrent();
		const nativeRead: SessionNativeCommandReadContext = {
			nativeSessionRef: read.nativeSessionRef,
			signal: read.signal,
			expiresAt: read.expiresAt,
			assertCurrent: () => {
				read.assertCurrent();
			},
			revalidate: async () => {
				await read.revalidate();
			},
		};
		if (selector === "commands") {
			const directory = await this.discoverNativeCommands(nativeRead);
			return projectNativeMetadataCommandsV1({
				nativeSessionRef: read.nativeSessionRef,
				configVersion: this.options.configVersion,
				source: { name: this.options.cursorPrefix, version: "1" },
				directory,
				assertCurrent: () => read.assertCurrent(),
			});
		}
		if (selector === "skills") {
			const directory = await this.discoverNativeSkills(nativeRead);
			return projectNativeMetadataSkillsV1({
				nativeSessionRef: read.nativeSessionRef,
				configVersion: this.options.configVersion,
				sourceName: "agent-infra-skill-hub",
				directory,
				assertCurrent: () => read.assertCurrent(),
			});
		}
		nativeMetadataUnsupported();
	}

	async discoverNativeCommands(read: SessionNativeCommandReadContext) {
		const handle = this.handles.get(read.nativeSessionRef);
		if (!handle || handle.native.discoverCommands === undefined) unavailable();
		const assertCurrent = () => {
			if (
				read.signal.aborted ||
				read.expiresAt <= Date.now() ||
				this.closed ||
				this.handles.get(read.nativeSessionRef) !== handle
			)
				unavailable();
			read.assertCurrent();
		};
		assertCurrent();
		try {
			await read.revalidate();
		} catch {
			unavailable();
		}
		assertCurrent();
		const result = await handle.native.discoverCommands({
			signal: read.signal,
			expiresAt: read.expiresAt,
			allowedRoots: [
				join(this.options.path, read.nativeSessionRef, "workspace"),
			],
		});
		try {
			await read.revalidate();
		} catch {
			unavailable();
		}
		assertCurrent();
		return result;
	}
	/** Return the deployment-owned Hub projection without consulting native state. */
	async discoverNativeSkills(read: SessionNativeCommandReadContext) {
		const handle = this.handles.get(read.nativeSessionRef);
		const directory = this.options.skillDirectory;
		if (!handle || !directory) throw new RuntimeSkillDirectoryErrorV1();
		const generationId = directory.generationId;
		const projectionSnapshot = JSON.stringify(directory.findSkills());
		const assertCurrent = () => {
			if (
				read.signal.aborted ||
				read.expiresAt <= Date.now() ||
				this.closed ||
				this.handles.get(read.nativeSessionRef) !== handle
			)
				throw new RuntimeSkillDirectoryErrorV1();
			if (
				directory.generationId !== generationId ||
				JSON.stringify(directory.findSkills()) !== projectionSnapshot
			)
				throw new RuntimeSkillDirectoryErrorV1();
			read.assertCurrent();
		};
		const revalidate = async () => {
			assertCurrent();
			try {
				await boundedRuntimeSkillRead({
					pending: read.revalidate(),
					signal: read.signal,
					expiresAt: read.expiresAt,
				});
			} catch {
				throw new RuntimeSkillDirectoryErrorV1();
			}
			assertCurrent();
		};
		await revalidate();
		const entries = directory.findSkills().map((entry) => ({ ...entry }));
		await revalidate();
		return { generationId, entries };
	}

	/** Read one deployment-owned Hub resource without creating a native Turn. */
	async readNativeSkill(
		read: SessionNativeCommandReadContext,
		name: string,
		relativePath: string,
	): Promise<Uint8Array> {
		const handle = this.handles.get(read.nativeSessionRef);
		const directory = this.options.skillDirectory;
		if (!handle || !directory) throw new RuntimeSkillDirectoryErrorV1();
		const generationId = directory.generationId;
		const projectionSnapshot = JSON.stringify(directory.findSkills());
		const assertCurrent = () => {
			if (
				read.signal.aborted ||
				read.expiresAt <= Date.now() ||
				this.closed ||
				this.handles.get(read.nativeSessionRef) !== handle
			)
				throw new RuntimeSkillDirectoryErrorV1();
			if (
				directory.generationId !== generationId ||
				JSON.stringify(directory.findSkills()) !== projectionSnapshot
			)
				throw new RuntimeSkillDirectoryErrorV1();
			read.assertCurrent();
		};
		assertCurrent();
		try {
			await boundedRuntimeSkillRead({
				pending: read.revalidate(),
				signal: read.signal,
				expiresAt: read.expiresAt,
			});
		} catch {
			throw new RuntimeSkillDirectoryErrorV1();
		}
		assertCurrent();
		const bytes = await boundedRuntimeSkillRead({
			pending: directory.readSkill(name, relativePath),
			signal: read.signal,
			expiresAt: read.expiresAt,
		});
		assertCurrent();
		try {
			await read.revalidate();
		} catch {
			throw new RuntimeSkillDirectoryErrorV1();
		}
		assertCurrent();
		return bytes.slice();
	}
	async recordResultFile(
		command: RuntimeDriverCommand,
		result: import("./runtime-file-bridge.js").RuntimeFileResultReceiptV1,
	) {
		const { binding, projection } = readRuntimeFileResultReceiptV1(result);
		if (
			binding.agentId !== command.agentId ||
			binding.conversationId !== command.conversationId ||
			binding.executionId !== command.executionId ||
			binding.sessionGeneration !== command.sessionGeneration
		)
			runtimeAuthorizationDenied();
		const parsed = FileProjectionV1Schema.parse(projection);
		if (parsed.kind !== "result" || parsed.status !== "available")
			runtimeAuthorizationDenied();
		const bindingRecord = await this.binding(command, false);
		if (!bindingRecord) unavailable();
		const file = await this.file(bindingRecord);
		await file.update((state) => {
			const turn = state.turns.find(
				(candidate) => candidate.executionId === command.executionId,
			);
			if (!turn || terminal(turn.status)) runtimeAuthorizationDenied();
			if (
				turn.events.some(
					(event) =>
						event.type === "file" && event.payload.fileId === parsed.fileId,
				)
			)
				return;
			state.sequence++;
			turn.events.push(
				RuntimeEventV1Schema.parse({
					schemaVersion: 1,
					executionId: command.executionId,
					adapterEventKey: randomUUID(),
					cursor: `${this.options.cursorPrefix}-${state.sequence}`,
					occurredAt: new Date().toISOString(),
					type: "file",
					payload: {
						fileId: parsed.fileId,
						name: parsed.descriptor.name,
						mimeType: parsed.descriptor.mediaType,
						sizeBytes: parsed.descriptor.sizeBytes,
					},
				}),
			);
		});
		for (const wake of this.waiters.get(bindingRecord.ref) ?? []) wake();
	}
	async getCapabilities() {
		const skills = this.options.skillDirectory?.findSkills().map((skill) => ({
			schemaVersion: 1 as const,
			name: skill.name,
			version: skill.version,
			manifestSha256: skill.manifestDigest,
			packageDigest: skill.packageDigest,
			readOnly: true as const,
		}));
		if (
			skills &&
			new Set(skills.map((skill) => skill.name)).size !== skills.length
		)
			throw new RuntimeSkillDirectoryErrorV1();
		const capabilities = {
			modelSelection: true,
			attachments: this.options.supportsAttachments === true,
			resultFiles: this.options.supportsResultFiles === true,
			connection: false,
			supplementaryInstruction: false,
			...(skills && skills.length > 0 ? { skills } : {}),
		};
		const parsed = RuntimeCapabilitiesV1Schema.safeParse(capabilities);
		if (!parsed.success) throw new RuntimeSkillDirectoryErrorV1();
		return parsed.data;
	}
	async getModelDirectory(ref: string): Promise<RuntimeModelDirectory> {
		const handle = this.handles.get(ref);
		if (!handle?.native.modelSelection) unavailable();
		const selection = handle.native.modelSelection();
		const availableModels = new Set(selection.models);
		const availableReasoningLevels = new Set(selection.reasoningLevels);
		const options = this.options.modelOptions.flatMap((option) => {
			if (!availableModels.has(option.nativeModelId)) return [];
			const reasoningLevels = option.reasoningLevels.filter((level) =>
				availableReasoningLevels.has(level),
			);
			if (reasoningLevels.length === 0) return [];
			return [
				{
					modelOptionId: option.modelOptionId,
					modelId: option.nativeModelId,
					displayName: option.nativeModelId,
					reasoningLevels,
				},
			];
		});
		const currentModel = selection.currentModel;
		const currentReasoning = selection.currentReasoning;
		const currentOption = options.find(
			(option) => option.modelId === currentModel,
		);
		if (
			!currentOption ||
			!currentReasoning ||
			!currentOption.reasoningLevels.includes(currentReasoning)
		)
			unavailable();
		return {
			options,
			current: {
				modelOptionId: currentOption.modelOptionId,
				reasoningLevel: currentReasoning,
			},
		};
	}

	/** Return bounded Browser descriptors from the deployment-owned projection. */
	getBrowserToolDescriptors() {
		return createCodexBrowserToolDescriptorsV1(this.options.browserCapability);
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
