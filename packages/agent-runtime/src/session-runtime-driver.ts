import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
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
	type RuntimeEvent,
	RuntimeEventSchema,
	type RuntimeEventV1,
	RuntimeEventV1Schema,
	RuntimeEventV2Schema,
	RuntimeFileEventV2Schema,
	type RuntimeOperationFactV2,
	RuntimeOperationFactV2Schema,
	type RuntimeSelectionV1,
	RuntimeSelectionV1Schema,
	type RuntimeStatusV1,
	RuntimeStatusV1Schema,
} from "@agent-infra/contracts/runtime";
import type { BrowserHandoffRecordV1 } from "./browser-handoff.js";
import { createCodexBrowserToolDescriptorsV1 } from "./codex-browser-tools.js";
import type {
	RuntimeBrowserHandoffRequestV1,
	RuntimeBrowserSideEffectConfirmationRequestV1,
	RuntimeBrowserSideEffectConfirmationResultV1,
	RuntimeDriver,
	RuntimeDriverCommand,
	RuntimeDriverLookup,
	RuntimeDriverOperationRecord,
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
	RuntimeModelCredentialResolver,
	RuntimeModelDirectory,
	RuntimeNativeCommandCommandV1,
	RuntimeNativeMetadataReadContextV1,
	RuntimeNativeSkillBindingRequestV1,
	RuntimeNativeSkillCommandV1,
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
import {
	type RuntimeOriginalExecutionRef,
	runtimeAuthorizationDenied,
} from "./runtime-authorization.js";
import {
	declareRuntimeTurnNotSubmittedBeforeNativeSubmitV1,
	readRuntimeFileResultReceiptV1,
} from "./runtime-file-bridge.js";
import {
	isSandboxAttachmentNativeImageV1,
	materializeSandboxAttachmentsV1,
	sandboxAttachmentIdsV1,
	sandboxAttachmentPromptTextV1,
} from "./sandbox-attachments.js";
import {
	planSandboxResultsV1,
	publishSandboxResultsV1,
	SANDBOX_RESULT_MAX_REFERENCES_V1,
	SANDBOX_RESULT_TOOL_ID_V1,
	type SandboxResultBlockV1,
	sandboxResultAnswerText,
	settleSandboxResultsWithoutBridgeV1,
} from "./sandbox-result-references.js";
import {
	boundedRuntimeSkillRead,
	type RuntimeFilesystemSkillDirectoryV1,
	RuntimeSkillDirectoryErrorV1,
} from "./skill-hub-directory.js";
import {
	appendTurnOperationFactV1,
	isTurnResultPublicationV1,
	publishTurnOperationFactsV1,
	settleTurnResultPublicationV1,
	type TurnResultPublicationV1,
} from "./turn-result-publication.js";

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
	readonly browserCapability?:
		| BrowserCapabilityAvailableV1
		| (() => BrowserCapabilityAvailableV1 | undefined);
	readonly path: string;
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly modelOptions: readonly SessionRuntimeModelOption[];
	readonly supportsAttachments?: boolean;
	/**
	 * #3225：标准模板（Pi、OpenCode）把附件物化到 Conversation 工作区并在原生输入后追加清单；
	 * 可接受类型以 FileLimits 交集为准，图片另外作为原生 image 块（ACP 需协商
	 * `promptCapabilities.image`，未协商时只给清单）。未设置时（ACP 自定义 Agent）附件仍只按
	 * 协商的原生图片输入传递。
	 */
	readonly workspaceAttachments?: boolean;
	/** Set only when the native adapter supplies a confirmed result-file callback. */
	readonly supportsResultFiles?: boolean;
	/**
	 * #3226：标准模板（Pi、OpenCode）在 Turn 正常结束时解析最终回答中的 `sandbox:` 引用并
	 * 发布为结果文件。ACP 块映射不受此开关影响。
	 */
	readonly sandboxReferences?: boolean;
	/** Host-owned protected Connection client is available to this Driver. */
	readonly supportsConnection?: boolean;
	/**
	 * Per-peer image input negotiation for Drivers whose native protocol decides
	 * it before a Session exists (ACP): `false` rejects attachment input before
	 * any bridge read or Session side effect. Drivers without per-peer
	 * negotiation leave this unset and rely on `supportsAttachments`.
	 */
	readonly attachmentsNegotiated?: () => boolean;
	/** Deployment-owned verified Skill Hub generation; never selected by a wire command. */
	readonly skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
	/** Native prompt expansion supplied by the pinned Driver adapter (Pi only for now). */
	readonly nativeSkillPrompt?: (name: string, parameters: string) => string;
	/** Fixed provenance version for the native command directory. */
	readonly nativeCommandSourceVersion?: string;
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
	/** Driver-owned reference used by Host authorization; never the vendor nativeId. */
	readonly runtimeSessionRef: string;
	nativeId?: string;
	history?: { checkpoint: string; complete: boolean };
	selection: RuntimeSelectionV1;
	/** Request-local execution identity for Browser adapters; never persisted here. */
	readonly executionId?: string;
	/** Trusted original execution binding for protected Connection adapters. */
	readonly connectionReference?: RuntimeOriginalExecutionRef;
	/** Retires a protected external action while preserving an unknown Turn hold. */
	readonly markUnknown?: () => Promise<void>;
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
		toolCallId: string,
		toolId: string,
		phase: "started" | "completed" | "failed",
	) => Promise<void>;
	readonly skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
	/**
	 * #3226：ACP `agent_message_chunk` 中的 `image`/`resource_link` 块，在流中暂存，
	 * Turn 正常结束时与回答内引用一并处理。
	 */
	readonly resultBlock?: (block: SandboxResultBlockV1) => void;
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
	/** Execute one already bound native command through the provider protocol. */
	executeNativeCommand?(
		command: RuntimeNativeCommandCommandV1,
	): Promise<{ stopReason: string; checkpoint?: string }>;
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
	kind?: "submit-turn" | "native-command";
	executionId: string;
	turnId: string;
	operationKey: string;
	configVersion: string;
	selection: RuntimeSelectionV1;
	status: RuntimeStatusV1;
	/** Protected external action was blocked; terminal native callbacks cannot clear it. */
	unknownHold?: true;
	nativeStopReason?: string;
	nativeCheckpoint?: string;
	nativeTerminalCheckpoint?: string;
	/** V1 events plus V2 operation and result-file events retain their original versions. */
	events: RuntimeEvent[];
	/** Durable metadata-only facts emitted by shared non-Codex operation adapters. */
	operationFacts?: RuntimeOperationFactV2[];
	operationRef?: string;
	attemptRef?: string;
	/**
	 * #3226：原生 Turn 已以 completed 结束、最终回答已确认后保存的发布计划与原生终态；
	 * 计划收敛后才写终态事件，重启时沿已保存的进度继续。
	 */
	resultPublication?: TurnResultPublicationV1;
}
function uncertainOperationFacts(turn: Turn) {
	const latest = new Map<string, RuntimeOperationFactV2>();
	for (const fact of turn.operationFacts ?? []) {
		latest.set(JSON.stringify([fact.operationRef, fact.attemptRef]), fact);
	}
	return [...latest.values()].filter(
		(fact) =>
			fact.phase === "intent" ||
			fact.phase === "started" ||
			fact.phase === "unknown",
	);
}
function appendUnknownOperationFacts(
	turn: Turn,
	facts: readonly RuntimeOperationFactV2[],
	journal: { sequence: number },
	cursorPrefix: string,
) {
	if (!facts.length) return;
	const now = new Date().toISOString();
	for (const fact of facts) {
		if (fact.phase === "unknown") continue;
		appendTurnOperationFactV1(
			turn,
			RuntimeOperationFactV2Schema.parse({
				...fact,
				phase: "unknown",
				finishedAt: now,
				...(fact.startedAt
					? {
							durationMs: Math.max(
								0,
								Date.parse(now) - Date.parse(fact.startedAt),
							),
						}
					: {}),
				failureCode: "recovery_unconfirmed",
			}),
			journal,
			cursorPrefix,
		);
	}
}
function hasUnknownStatusEvent(turn: Turn) {
	const last = turn.events.at(-1);
	return last?.type === "status" && last.payload.status === "unknown";
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
function nativeSkillUnsupported(): never {
	throw new RuntimeHostError(
		"RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED",
		"Native Skill execution is unavailable for this runtime",
		409,
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
		if (this.closed || action.runtimeOperationId !== action.executionId)
			runtimeAuthorizationDenied();
		const binding = this.index
			.read()
			.sessions.find((entry) => entry.ref === action.nativeSessionRef);
		if (!binding) runtimeAuthorizationDenied();
		const file = await this.file(binding);
		const turn = file
			.read()
			.turns.find((item) => item.executionId === action.executionId);
		if (!turn || terminal(turn.status)) runtimeAuthorizationDenied();
		if (turn.unknownHold) runtimeAuthorizationDenied();
		if (
			action.kind === "model" &&
			turn.operationFacts === undefined &&
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

	createNativeSkillCommand(command: RuntimeNativeSkillCommandV1) {
		if (!command.packageDigest || !command.manifestDigest)
			nativeSkillUnsupported();
		if (!this.options.nativeSkillPrompt || !this.options.skillDirectory)
			nativeSkillUnsupported();
		const entry = this.options.skillDirectory
			.findSkills()
			.find(
				(candidate) =>
					candidate.name === command.capabilityName &&
					candidate.version === command.capabilitySourceVersion &&
					(command.packageDigest === undefined ||
						candidate.packageDigest === command.packageDigest) &&
					(command.manifestDigest === undefined ||
						candidate.manifestDigest === command.manifestDigest),
			);
		if (
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(command.capabilityName) ||
			!entry
		)
			nativeSkillUnsupported();
		const text = this.options.nativeSkillPrompt(
			command.capabilityName,
			command.parameters,
		);
		if (
			typeof text !== "string" ||
			text.length === 0 ||
			text.length > 16 * 1024 ||
			!text.isWellFormed()
		)
			nativeSkillUnsupported();
		return {
			schemaVersion: 1 as const,
			kind: "submit-turn" as const,
			operationId: command.operationId,
			agentId: command.agentId,
			conversationId: command.conversationId,
			executionId: command.executionId,
			turnId: command.turnId,
			sessionGeneration: command.sessionGeneration,
			nativeSessionRef: command.nativeSessionRef,
			input: { text, attachments: [] },
			nativeSkill: {
				capabilityId: command.capabilityId,
				directoryRevision: command.directoryRevision,
				name: command.capabilityName,
				version: command.capabilitySourceVersion,
				packageDigest: entry.packageDigest,
				manifestDigest: entry.manifestDigest,
			},
		};
	}

	resolveNativeSkillBinding(input: RuntimeNativeSkillBindingRequestV1) {
		if (!this.options.skillDirectory) nativeSkillUnsupported();
		const entry = this.options.skillDirectory
			.findSkills()
			.find(
				(candidate) =>
					candidate.name === input.capabilityName &&
					candidate.version === input.capabilitySourceVersion,
			);
		if (!entry) nativeSkillUnsupported();
		return {
			packageDigest: entry.packageDigest,
			manifestDigest: entry.manifestDigest,
		};
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
			if (!turn || terminal(turn.status) || turn.unknownHold)
				throw new RuntimeHostError(
					"RUNTIME_OPERATION_CONFLICT",
					"Runtime operation fact is no longer current",
					409,
				);
			appendTurnOperationFactV1(turn, fact, state, this.options.cursorPrefix);
		});
		for (const wake of this.waiters.get(file.read().binding.ref) ?? []) wake();
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
	private file(binding: Binding, recover = true) {
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
				let state = file.read();
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
							"native-command",
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
						(!terminal(turn.status) &&
							!turn.events.some((event) => event.type === "completed") &&
							turn !== state.turns.at(-1)) ||
						!operationKeys.has(turn.operationKey) ||
						!["submit-turn", "native-command"].includes(
							JSON.parse(turn.operationKey)[0],
						) ||
						(turn.kind !== undefined &&
							turn.kind !== JSON.parse(turn.operationKey)[0])
					)
						unavailable();
					executions.add(turn.executionId);
					turns.add(turn.turnId);
					let completed = false;
					let corrected = false;
					if (
						turn.resultPublication !== undefined &&
						(!isTurnResultPublicationV1(turn.resultPublication) ||
							turn.resultPublication.stopReason === undefined)
					)
						unavailable();
					for (const event of turn.events) {
						sequence++;
						if (
							(completed && !(event.type === "status" && !corrected)) ||
							!RuntimeEventSchema.safeParse(event).success ||
							(event.schemaVersion === 2 &&
								!RuntimeFileEventV2Schema.safeParse(event).success &&
								!RuntimeEventV2Schema.safeParse(event).success) ||
							event.executionId !== turn.executionId ||
							event.cursor !== `${this.options.cursorPrefix}-${sequence}` ||
							eventKeys.has(event.adapterEventKey)
						)
							unavailable();
						eventKeys.add(event.adapterEventKey);
						if (event.type === "completed") {
							completed = true;
							if (!turn.unknownHold && event.payload.status !== turn.status)
								unavailable();
						} else if (completed) {
							if (
								!turn.unknownHold ||
								event.type !== "status" ||
								event.payload.status !== "unknown" ||
								corrected
							)
								unavailable();
							corrected = true;
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
					if (corrected) {
						if (turn.status !== "unknown" || !turn.unknownHold) unavailable();
					} else if (terminal(turn.status) !== completed) unavailable();
					if (
						completed &&
						!corrected &&
						turn.nativeCheckpoint &&
						!turn.nativeTerminalCheckpoint
					)
						unavailable();
					if (
						completed &&
						!corrected &&
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
				await file.update((draft) => {
					const sessionCancelled = this.cancelled(binding.ref);
					for (const turn of draft.turns) {
						publishTurnOperationFactsV1(turn, draft, this.options.cursorPrefix);
						// #3226：发布中断的引用先沿已保存进度收敛（不重发），再按原规则处理 Turn。
						if (!terminal(turn.status))
							settleTurnResultPublicationV1(
								turn,
								draft,
								this.options.cursorPrefix,
							);
						const uncertainOperations = uncertainOperationFacts(turn);
						// #3226：结果发布已沿原意图收敛，unknown 的发布不阻塞已完成的原生 Turn。
						const uncertainTools = uncertainOperations.filter(
							(fact) =>
								fact.kind === "tool" &&
								fact.toolId !== SANDBOX_RESULT_TOOL_ID_V1,
						);
						const hold =
							turn.unknownHold || uncertainTools.length > 0 || sessionCancelled;
						if (turn.status === "running" && hold) {
							appendUnknownOperationFacts(
								turn,
								uncertainTools,
								draft,
								this.options.cursorPrefix,
							);
							draft.sequence++;
							turn.events.push(
								RuntimeEventV1Schema.parse({
									schemaVersion: 1,
									executionId: turn.executionId,
									adapterEventKey: randomUUID(),
									cursor: `${this.options.cursorPrefix}-${draft.sequence}`,
									occurredAt: new Date().toISOString(),
									type: "status",
									payload: { status: "unknown" },
								}),
							);
							turn.status = "unknown";
							turn.unknownHold = true;
						} else if (turn.status === "unknown" && hold) {
							appendUnknownOperationFacts(
								turn,
								uncertainTools,
								draft,
								this.options.cursorPrefix,
							);
							turn.unknownHold = true;
							if (!hasUnknownStatusEvent(turn)) {
								draft.sequence++;
								turn.events.push(
									RuntimeEventV1Schema.parse({
										schemaVersion: 1,
										executionId: turn.executionId,
										adapterEventKey: randomUUID(),
										cursor: `${this.options.cursorPrefix}-${draft.sequence}`,
										occurredAt: new Date().toISOString(),
										type: "status",
										payload: { status: "unknown" },
									}),
								);
							}
						} else if (
							turn.status === "unknown" &&
							!hasUnknownStatusEvent(turn)
						) {
							draft.sequence++;
							turn.events.push(
								RuntimeEventV1Schema.parse({
									schemaVersion: 1,
									executionId: turn.executionId,
									adapterEventKey: randomUUID(),
									cursor: `${this.options.cursorPrefix}-${draft.sequence}`,
									occurredAt: new Date().toISOString(),
									type: "status",
									payload: { status: "unknown" },
								}),
							);
						}
					}
				});
				state = file.read();
				if (!recover) return file;
				// #3226：原生 Turn 已正常结束、发布计划已收敛的 Turn，按保存的原生终态完成。
				for (const turn of state.turns) {
					const publication = turn.resultPublication;
					if (
						turn.status !== "running" ||
						turn.unknownHold ||
						!publication?.plan.settled ||
						publication.stopReason === undefined
					)
						continue;
					await this.status(
						file,
						turn.executionId,
						this.options.completionStatus(publication.stopReason),
						publication.stopReason,
						publication.checkpoint,
					);
				}
				state = file.read();
				const active = state.turns.find((turn) => !terminal(turn.status));
				if (active?.kind === "native-command") {
					// A native command has no replay-safe provider receipt. Retain the
					// durable operation as unknown after restart; never invoke it twice.
					await file.update((draft) => {
						const turn = draft.turns.find(
							(entry) => entry.executionId === active.executionId,
						);
						if (!turn) return;
						turn.unknownHold = true;
						if (!hasUnknownStatusEvent(turn)) {
							draft.sequence++;
							turn.events.push(
								RuntimeEventV1Schema.parse({
									schemaVersion: 1,
									executionId: turn.executionId,
									adapterEventKey: randomUUID(),
									cursor: `${this.options.cursorPrefix}-${draft.sequence}`,
									occurredAt: new Date().toISOString(),
									type: "status",
									payload: { status: "unknown" },
								}),
							);
						}
					});
					state = file.read();
					return file;
				}
				const latest = active ?? state.turns.at(-1);
				const recoverable = active && !active.unknownHold ? active : undefined;
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
						runtimeSessionRef: binding.ref,
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
						// Recovery inspects native history without an active Execution Key.
						resolveModelCredential: async () => unavailable(),
						...(active
							? {
									connectionReference: {
										agentId: binding.agentId,
										conversationId: binding.conversationId,
										sessionGeneration: binding.sessionGeneration,
										executionId: active.executionId,
									},
								}
							: {}),
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
						const recovered = recoverable?.nativeCheckpoint
							? await restored.recover?.(recoverable.nativeCheckpoint)
							: undefined;
						let recoveredTerminal = false;
						if (
							recoverable &&
							recovered &&
							terminal(this.options.completionStatus(recovered.stopReason))
						) {
							const text = recoverable.events
								.filter((event) => event.type === "text")
								.map((event) => event.payload.delta)
								.join("");
							if (recovered.text.startsWith(text)) {
								if (recovered.text.length > text.length)
									await this.event(file, recoverable.executionId, {
										type: "text",
										payload: { delta: recovered.text.slice(text.length) },
									});
								// #3226：重启后没有执行期文件交换上下文；回答内引用只记录为未发布。
								if (
									this.options.sandboxReferences &&
									this.options.completionStatus(recovered.stopReason) ===
										"completed"
								)
									await this.recordUnpublishedResults(
										file,
										recoverable.executionId,
										recovered.text,
										recovered.stopReason,
										recovered.checkpoint,
									);
								await this.status(
									file,
									recoverable.executionId,
									this.options.completionStatus(recovered.stopReason),
									recovered.stopReason,
									recovered.checkpoint,
								);
								recoveredTerminal = true;
							}
						}
						if (recoverable && !recoveredTerminal) {
							await file.update((draft) => {
								const turn = draft.turns.find(
									(entry) => entry.executionId === recoverable.executionId,
								);
								if (turn)
									appendUnknownOperationFacts(
										turn,
										uncertainOperationFacts(turn),
										draft,
										this.options.cursorPrefix,
									);
							});
							await this.status(file, recoverable.executionId, "unknown");
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
	/**
	 * A failed DurableJsonFile commit poisons that in-memory instance. Reopen the
	 * committed bytes so an unknown hold can be retried after a transient fsync or
	 * rename failure. The caller keeps the native action blocked while this runs.
	 */
	private reopenDurableFile(binding: Binding) {
		this.files.delete(binding.ref);
		return this.file(binding, false);
	}
	private async persistUnknownAfterFailure(
		binding: Binding,
		executionId: string,
		firstError: unknown,
	) {
		let lastError = firstError;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const reopened = await this.reopenDurableFile(binding);
				await this.status(
					reopened,
					executionId,
					"unknown",
					undefined,
					undefined,
					true,
				);
				return reopened;
			} catch (error) {
				lastError = error;
			}
		}
		throw new AggregateError(
			[firstError, lastError],
			"Unable to persist protected runtime unknown hold",
		);
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
			if (command.kind === "native-command")
				return this.executeNativeCommand(file, command);
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
		let record!: RuntimeDriverOperationRecord;
		await file.update((state) => {
			const current = state.turns.find(
				(turn) => turn.executionId === command.executionId,
			);
			record = result(
				command,
				state.binding.ref,
				current?.unknownHold ? unknownResult : value,
			);
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
	 * #3225：标准模板把附件物化到本 Conversation 工作区并追加清单；原生图片类型另外作为
	 * image 块。Session 未协商图片输入时，打开后只保留文本块。
	 */
	private async materializeWorkspaceAttachmentInput(
		workspace: string,
		text: string,
		attachments: readonly string[],
		fileBridge?: import("./runtime-file-bridge.js").RuntimeFileBridgePortV1,
	): Promise<readonly NativePromptContentV1[]> {
		if (!fileBridge) unavailable();
		const fileIds = sandboxAttachmentIdsV1(attachments, unavailable);
		await mkdir(workspace, { recursive: true, mode: 0o700 });
		if ((await realpath(workspace)) !== workspace) unavailable();
		const placed = await materializeSandboxAttachmentsV1({
			root: this.options.path,
			workspace,
			fileIds,
			read: (fileId) => fileBridge.readInput(fileId),
			invalid: unavailable,
			imageBytes: true,
		});
		return [
			{ type: "text", text: sandboxAttachmentPromptTextV1(text, placed) },
			...placed.flatMap((attachment) =>
				attachment.imageBytes && isSandboxAttachmentNativeImageV1(attachment)
					? [
							{
								type: "image" as const,
								data: Buffer.from(attachment.imageBytes).toString("base64"),
								mimeType: attachment.mediaType,
							},
						]
					: [],
			),
		];
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
		initialFile: DurableJsonFile<Session>,
		command: Submit,
		fileBridge?: import("./runtime-file-bridge.js").RuntimeFileBridgePortV1,
		browser?: import("./driver.js").RuntimeBrowserExecutionContextV1,
	) {
		let file = initialFile;
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
		const workspaceAttachments = this.options.workspaceAttachments === true;
		// #3225：标准模板接受只含附件的消息；ACP 自定义 Agent 仍需正文。
		if (!("text" in command.input) && !workspaceAttachments) unavailable();
		const text = "text" in command.input ? command.input.text : "";
		const hasAttachments = command.input.attachments.length > 0;
		if (!text && !hasAttachments) unavailable();
		// Attachment input needs both a wired bridge and a Driver that consumes
		// it; neither decision may wait for a Session or a bridge read.
		if (hasAttachments && (!this.options.supportsAttachments || !fileBridge))
			unavailable();
		// A Driver whose native protocol negotiates image input per peer settles
		// that before a Session exists, so unsupported input is rejected before
		// the bridge is read and before any native Session side effect. Workspace
		// attachments do not depend on image input: without it only the manifest
		// reaches the native Turn.
		if (
			hasAttachments &&
			!workspaceAttachments &&
			this.options.attachmentsNegotiated?.() === false
		)
			unavailable();
		let input: NativePromptV1 = text;
		// Attachment bytes were read under the File Grant of this request; they must
		// not cross into a native Turn once that authority has lapsed.
		const revalidateInput = () => {
			if (hasAttachments) fileBridge?.revalidate();
		};
		const directory = join(this.options.path, ref);
		const workspace = join(directory, "workspace");
		if (hasAttachments) {
			input = await (workspaceAttachments
				? this.materializeWorkspaceAttachmentInput(
						workspace,
						text,
						command.input.attachments,
						fileBridge,
					)
				: this.materializeAttachmentInput(
						text,
						command.input.attachments,
						fileBridge,
					)
			).catch((error: unknown) =>
				// #3314/#3373：附件在打开原生 Session 与本操作的持久记录之前物化。平台的明确拒绝
				// 由 Host 持久化为 rejected；其他读取或物化失败声明本次 Turn 未提交。
				declareRuntimeTurnNotSubmittedBeforeNativeSubmitV1(
					error,
					"file_input_unavailable",
					command,
				),
			);
			try {
				revalidateInput();
			} catch (error) {
				declareRuntimeTurnNotSubmittedBeforeNativeSubmitV1(
					error,
					"session_preparation_failed",
					command,
				);
			}
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
		await mkdir(workspace, { recursive: true, mode: 0o700 });
		if ((await realpath(workspace)) !== workspace) unavailable();
		// #3226：ACP 回答中的 image/resource_link 块只在内存中暂存，Turn 正常结束时一并处理。
		// 单帧受 ACP 流的 1 MiB 上限约束；超过发布上限的块只需要计入超出部分。
		const resultBlocks: SandboxResultBlockV1[] = [];
		const resultBlock = (block: SandboxResultBlockV1) => {
			if (resultBlocks.length <= SANDBOX_RESULT_MAX_REFERENCES_V1 * 3)
				resultBlocks.push(block);
		};
		let admitted: () => void = () => {};
		const operationRef = randomUUID();
		const attemptRef = randomUUID();
		const resolveModelCredential = this.options.authorizeModelAction
			? async () => {
					const turn = file
						.read()
						.turns.find((turn) => turn.executionId === command.executionId);
					if (
						this.closed ||
						!turn ||
						turn.status !== "running" ||
						turn.unknownHold
					)
						runtimeAuthorizationDenied();
					const latest = new Map<string, RuntimeOperationFactV2>();
					for (const fact of turn.operationFacts ?? []) {
						if (fact.kind === "model")
							latest.set(`${fact.operationRef}:${fact.attemptRef}`, fact);
					}
					const active = [...latest.values()].filter(
						(fact) => fact.phase === "intent" || fact.phase === "started",
					);
					const fact = active[0];
					if (active.length !== 1 || !fact) runtimeAuthorizationDenied();
					const authorized = await this.options.authorizeModelAction?.({
						kind: "model",
						nativeSessionRef: ref,
						executionId: command.executionId,
						runtimeOperationId: command.executionId,
						operationRef: fact.operationRef,
						attemptRef: fact.attemptRef,
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
		let unknownHold = false;
		let unknownMarking = false;
		const toolFacts = new Map<
			string,
			{ operationRef: string; attemptRef: string; startedAt: number }
		>();
		const recordToolOperation = async (
			toolCallId: string,
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
				toolFacts.set(toolCallId, {
					operationRef,
					attemptRef,
					startedAt,
				});
				return;
			}
			const fact = toolFacts.get(toolCallId);
			if (!fact) return;
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
			toolFacts.delete(toolCallId);
		};
		let native: NativeSession;
		try {
			const sessionOptions: NativeSessionOptions = {
				directory,
				runtimeSessionRef: ref,
				executionId: command.executionId,
				connectionReference: {
					agentId: command.agentId,
					conversationId: command.conversationId,
					sessionGeneration: command.sessionGeneration,
					executionId: command.executionId,
				},
				selection,
				admit: async () => {
					if (!dispatched || this.closed || unknownHold || unknownMarking)
						throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
					await this.resolve(file, command, {
						outcome: "accepted",
						status: "running",
					});
					await this.status(file, command.executionId, "running");
					admitted();
				},
				markUnknown: async () => {
					unknownMarking = true;
					unknownHold = true;
					if (dispatched && !this.closed) {
						try {
							await this.status(
								file,
								command.executionId,
								"unknown",
								undefined,
								undefined,
								true,
							);
						} catch (error) {
							// DurableJsonFile deliberately poisons a failed instance. Reopen
							// the committed bytes and retry so a transient persistence fault
							// cannot leave a cancelled protected Turn durably running.
							file = await this.persistUnknownAfterFailure(
								before.binding,
								command.executionId,
								error,
							);
						}
					}
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
				resultBlock,
				history: before.turns.at(-1)?.nativeTerminalCheckpoint
					? {
							checkpoint:
								before.turns.at(-1)?.nativeTerminalCheckpoint ?? unavailable(),
							complete: true,
						}
					: undefined,
				update: async (event) => {
					if (!dispatched || unknownHold || unknownMarking) return;
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
		} catch {
			unavailable();
		}
		// The opened Session has the last word on negotiated image input: a Session
		// that refuses image content must never reach the native Turn. Workspace
		// attachments stay in the workspace and the manifest; only the native image
		// blocks are dropped.
		if (hasAttachments && native.supportsImagePrompt === false) {
			if (workspaceAttachments && typeof input !== "string")
				input = input.filter((block) => block.type === "text");
			else {
				if (!reuse) await native.close().catch(() => {});
				unavailable();
			}
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
		let revalidationFailure: { readonly error: unknown } | undefined;
		try {
			const nativeCheckpoint = await native.checkpoint?.();
			// Native initialization is asynchronous; the File Grant must still hold
			// immediately before validated bytes cross into the native Turn.
			try {
				revalidateInput();
			} catch (error) {
				revalidationFailure = { error };
				throw error;
			}
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
			// #3373：Grant 复核失败时本操作尚未写入，原生 Session 也没有收到 prompt。
			if (revalidationFailure)
				declareRuntimeTurnNotSubmittedBeforeNativeSubmitV1(
					revalidationFailure.error,
					"session_preparation_failed",
					command,
				);
			unavailable();
		}
		const handle: Handle = { native, selection, pump: Promise.resolve() };
		this.handles.set(ref, handle);
		let preDispatchFailure = false;
		let preDispatchDiscarded: { readonly error: unknown } | undefined;
		handle.pump = (async () => {
			if (hasAttachments) {
				try {
					// Materialized bytes must never reach the native session under
					// authority that lapsed during Session setup or model selection.
					revalidateInput();
				} catch (error) {
					// Nothing reached the native Session, so the admitted Turn is
					// rolled back rather than retained as an unknown Turn that may or
					// may not have been accepted.
					preDispatchFailure = true;
					await this.discardTurn(file, command);
					preDispatchDiscarded = { error };
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
				if (!unknownHold && !unknownMarking) {
					await this.resolve(file, command, {
						outcome: "accepted",
						status: "running",
					});
					const status = this.options.completionStatus(response.stopReason);
					// #3226：原生 Turn 以 completed 结束、最终回答已确认后，写终态前发布引用。
					if (status === "completed")
						await this.publishTurnResults(
							file,
							command,
							fileBridge,
							workspace,
							resultBlocks,
							response,
						);
					if (!unknownHold && !unknownMarking)
						await this.status(
							file,
							command.executionId,
							status,
							response.stopReason,
							response.checkpoint,
						);
					admitted();
				}
			} catch {
				if (!unknownHold && !unknownMarking)
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
		// #3373：只有本操作的 Turn 与记录已经回滚，才能声明本次 Turn 未提交。
		if (preDispatchDiscarded)
			declareRuntimeTurnNotSubmittedBeforeNativeSubmitV1(
				preDispatchDiscarded.error,
				"session_preparation_failed",
				command,
			);
		if (preDispatchFailure) unavailable();
		if (unknownHold) return result(command, ref, unknownResult);
		return (
			file
				.read()
				.operations.find((entry) => entry.key === operationKey(command))
				?.record ?? result(command, ref, unknownResult)
		);
	}

	private async executeNativeCommand(
		file: DurableJsonFile<Session>,
		command: RuntimeNativeCommandCommandV1,
	) {
		const before = file.read();
		const ref = before.binding.ref;
		if (before.cancelled) unavailable();
		if (command.nativeSessionRef !== ref) nativeSkillUnsupported();
		const handle = this.handles.get(ref);
		if (!handle?.native.executeNativeCommand) nativeSkillUnsupported();
		const selection = handle.selection;
		let busy = false;
		await file.update((state) => {
			if (state.cancelled) unavailable();
			if (state.turns.some((turn) => !terminal(turn.status))) {
				busy = true;
				return;
			}
			if (
				state.turns.some(
					(turn) =>
						turn.executionId === command.executionId ||
						turn.turnId === command.turnId,
				)
			)
				conflict();
			state.operations.push({
				key: operationKey(command),
				digest: digest(command),
			});
			state.turns.push({
				kind: "native-command",
				executionId: command.executionId,
				turnId: command.turnId,
				operationKey: operationKey(command),
				configVersion: this.options.configVersion,
				selection,
				status: "unknown",
				events: [],
			});
		});
		if (busy) return this.resolve(file, command, { outcome: "busy" });
		const discardReservation = () =>
			file.update((state) => {
				state.operations = state.operations.filter(
					(entry) => entry.key !== operationKey(command),
				);
				state.turns = state.turns.filter(
					(turn) => turn.executionId !== command.executionId,
				);
			});
		try {
			await this.assertNativeCommandBinding(handle, command);
		} catch (error) {
			await discardReservation();
			throw error;
		}
		try {
			const response = await handle.native.executeNativeCommand(command);
			if (
				!response ||
				typeof response.stopReason !== "string" ||
				(response.checkpoint !== undefined &&
					typeof response.checkpoint !== "string")
			)
				throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
			const status = this.options.completionStatus(response.stopReason);
			if (status === "unknown") throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
			await this.status(
				file,
				command.executionId,
				status,
				response.stopReason,
				response.checkpoint,
			);
			return this.resolve(file, command, {
				outcome: "accepted",
				status,
			});
		} catch {
			await this.status(file, command.executionId, "unknown").catch(() => {});
			return this.resolve(file, command, unknownResult);
		}
	}
	/** #3226：没有文件交换上下文时，把回答内引用记录为未发布的失败事实。 */
	private async recordUnpublishedResults(
		file: DurableJsonFile<Session>,
		executionId: string,
		text: string,
		stopReason: string,
		checkpoint: string | undefined,
	) {
		const { plan } = planSandboxResultsV1({ text });
		if (!plan) return;
		const settled = settleSandboxResultsWithoutBridgeV1(plan, () => undefined);
		await file.update((state) => {
			const draft = state.turns.find(
				(entry) => entry.executionId === executionId,
			);
			if (!draft || terminal(draft.status) || draft.resultPublication) return;
			for (const fact of settled.facts)
				appendTurnOperationFactV1(
					draft,
					fact,
					state,
					this.options.cursorPrefix,
				);
			draft.resultPublication = {
				plan: settled.plan,
				stopReason,
				...(checkpoint ? { checkpoint } : {}),
			};
		});
	}
	/**
	 * #3226：解析最终回答（标准模板）与暂存的 ACP 块，持久保存发布计划后逐个发布。
	 * 计划与每一步进度都在 Turn 写终态之前进入同一持久状态。
	 */
	private async publishTurnResults(
		file: DurableJsonFile<Session>,
		command: Submit,
		fileBridge:
			| import("./runtime-file-bridge.js").RuntimeFileBridgePortV1
			| undefined,
		workspace: string,
		blocks: readonly SandboxResultBlockV1[],
		response: { readonly stopReason: string; readonly checkpoint?: string },
	) {
		const current = () =>
			file
				.read()
				.turns.find((turn) => turn.executionId === command.executionId);
		const turn = current();
		if (!turn || turn.status !== "running" || turn.unknownHold) return;
		const { plan, images } = planSandboxResultsV1({
			...(this.options.sandboxReferences
				? { text: sandboxResultAnswerText(turn.events) }
				: {}),
			blocks,
			workspaceRoot: workspace,
		});
		if (!plan) return;
		await file.update((state) => {
			const draft = state.turns.find(
				(entry) => entry.executionId === command.executionId,
			);
			if (
				!draft ||
				draft.status !== "running" ||
				draft.unknownHold ||
				draft.resultPublication
			)
				unavailable();
			draft.resultPublication = {
				plan,
				stopReason: response.stopReason,
				...(response.checkpoint ? { checkpoint: response.checkpoint } : {}),
			};
		});
		await publishSandboxResultsV1({
			bridge: fileBridge,
			workspaceRoot: workspace,
			images,
			ledger: {
				read: () => current()?.resultPublication?.plan,
				commit: async ({ plan: next, facts, receipt }) => {
					if (receipt) await this.recordResultFile(command, receipt);
					await file.update((state) => {
						const draft = state.turns.find(
							(entry) => entry.executionId === command.executionId,
						);
						if (
							!draft?.resultPublication ||
							terminal(draft.status) ||
							draft.unknownHold
						)
							conflict();
						for (const fact of facts)
							appendTurnOperationFactV1(
								draft,
								fact,
								state,
								this.options.cursorPrefix,
							);
						draft.resultPublication.plan = next;
					});
					for (const wake of this.waiters.get(file.read().binding.ref) ?? [])
						wake();
				},
			},
		});
	}
	private async event(
		file: DurableJsonFile<Session>,
		executionId: string,
		value: Pick<RuntimeEventV1, "type" | "payload">,
	) {
		await file.update((state) => {
			const turn = state.turns.find((turn) => turn.executionId === executionId);
			if (!turn || terminal(turn.status) || turn.unknownHold) return;
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
		unknownHold = false,
	) {
		await file.update((state) => {
			const turn = state.turns.find((turn) => turn.executionId === executionId);
			if (!turn) return;
			if (turn.status === status && status === "unknown") {
				if (unknownHold) turn.unknownHold = true;
				return;
			}
			if (unknownHold && terminal(turn.status)) {
				const completed = turn.events.at(-1);
				if (completed?.type !== "completed") unavailable();
				state.sequence++;
				turn.events.push(
					RuntimeEventV1Schema.parse({
						schemaVersion: 1,
						executionId,
						adapterEventKey: randomUUID(),
						cursor: `${this.options.cursorPrefix}-${state.sequence}`,
						occurredAt: new Date().toISOString(),
						type: "status",
						payload: { status: "unknown" },
					}),
				);
				turn.status = "unknown";
				turn.unknownHold = true;
				delete turn.nativeStopReason;
				delete turn.nativeTerminalCheckpoint;
				return;
			}
			if (terminal(turn.status)) return;
			if (turn.unknownHold && status === "unknown") return;
			if (turn.unknownHold && status !== "unknown") return;
			if (unknownHold) turn.unknownHold = true;
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
			const handle = this.handles.get(read.nativeSessionRef);
			const directory =
				handle?.native.executeNativeCommand === undefined
					? { commands: [] }
					: await this.discoverNativeCommands(nativeRead);
			const commands =
				directory && typeof directory === "object" && !Array.isArray(directory)
					? {
							...(directory as Record<string, unknown>),
							commands: Array.isArray(
								(directory as Record<string, unknown>).commands,
							)
								? (
										(directory as Record<string, unknown>)
											.commands as readonly Record<string, unknown>[]
									).filter((command) => command.source !== "skill")
								: [],
						}
					: directory;
			return projectNativeMetadataCommandsV1({
				nativeSessionRef: read.nativeSessionRef,
				configVersion: this.options.configVersion,
				source: {
					name: this.options.cursorPrefix,
					version: this.options.nativeCommandSourceVersion ?? "1",
				},
				directory: commands,
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

	createNativeCommandCommand(command: RuntimeNativeCommandCommandV1) {
		const sourceVersion = this.options.nativeCommandSourceVersion ?? "1";
		if (
			command.capabilitySourceVersion !== sourceVersion ||
			!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(command.capabilityName) ||
			command.parameters.length > 16 * 1024 ||
			createHash("sha256").update(command.parameters).digest("hex") !==
				command.parametersDigest
		)
			nativeSkillUnsupported();
		return command;
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

	private async assertNativeCommandBinding(
		handle: Handle,
		command: RuntimeNativeCommandCommandV1,
	) {
		if (!handle.native.discoverCommands || !handle.native.executeNativeCommand)
			nativeSkillUnsupported();
		const signal = AbortSignal.timeout(30_000);
		const directory = await handle.native.discoverCommands({
			signal,
			expiresAt: Date.now() + 30_000,
			allowedRoots: [
				join(this.options.path, command.nativeSessionRef, "workspace"),
			],
		});
		const projection = projectNativeMetadataCommandsV1({
			nativeSessionRef: command.nativeSessionRef,
			configVersion: this.options.configVersion,
			source: {
				name: this.options.cursorPrefix,
				version: this.options.nativeCommandSourceVersion ?? "1",
			},
			directory:
				directory && typeof directory === "object" && !Array.isArray(directory)
					? {
							...(directory as Record<string, unknown>),
							commands: Array.isArray(
								(directory as Record<string, unknown>).commands,
							)
								? (
										(directory as Record<string, unknown>)
											.commands as readonly Record<string, unknown>[]
									).filter((entry) => entry.source !== "skill")
								: [],
						}
					: directory,
		});
		if (projection.selector !== "commands") nativeSkillUnsupported();
		const entry = projection.capabilities.find(
			(capability) =>
				capability.kind === "command" &&
				capability.id === command.capabilityId &&
				capability.name === command.capabilityName &&
				capability.source.version === command.capabilitySourceVersion,
		);
		if (!entry || projection.revision !== command.directoryRevision)
			nativeSkillUnsupported();
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
		const { binding, projection, workspaceReference } =
			readRuntimeFileResultReceiptV1(result);
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
			const base = {
				executionId: command.executionId,
				adapterEventKey: randomUUID(),
				cursor: `${this.options.cursorPrefix}-${state.sequence}`,
				occurredAt: new Date().toISOString(),
				type: "file" as const,
			};
			const payload = {
				fileId: parsed.fileId,
				name: parsed.descriptor.name,
				mimeType: parsed.descriptor.mediaType,
				sizeBytes: parsed.descriptor.sizeBytes,
			};
			// #3226：带工作区引用（可为 null）的结果按 V2 记录，平台持久化前与文件记录核对。
			turn.events.push(
				workspaceReference === undefined
					? RuntimeEventV1Schema.parse({ ...base, schemaVersion: 1, payload })
					: RuntimeFileEventV2Schema.parse({
							...base,
							schemaVersion: 2,
							payload: { ...payload, workspaceReference },
						}),
			);
		});
		for (const wake of this.waiters.get(bindingRecord.ref) ?? []) wake();
	}
	async getCapabilities() {
		const browserCapability =
			typeof this.options.browserCapability === "function"
				? this.options.browserCapability()
				: this.options.browserCapability;
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
			connection: this.options.supportsConnection === true,
			supplementaryInstruction: false,
			...(skills && skills.length > 0 ? { skills } : {}),
			...(browserCapability
				? {
						browser: {
							capabilityVersion: browserCapability.capabilityVersion,
							operations: browserCapability.operations,
							provenance: browserCapability.provenance,
							conformance: browserCapability.conformance,
						},
					}
				: {}),
		};
		const parsed = RuntimeCapabilitiesV1Schema.safeParse(capabilities);
		if (!parsed.success) throw new RuntimeSkillDirectoryErrorV1();
		return parsed.data;
	}
	async probeReadiness(signal: AbortSignal) {
		signal.throwIfAborted();
		return this.getCapabilities();
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

	/** Execute Browser handoff through the existing request-local controller. */
	async executeBrowserHandoff(
		nativeSessionRef: string,
		executionId: string,
		request: RuntimeBrowserHandoffRequestV1,
		context: import("./driver.js").RuntimeDriverExecutionContextV1,
	): Promise<BrowserHandoffRecordV1 | undefined> {
		const browser = context.browser;
		const handoff = browser?.handoff?.controller;
		if (!browser || !handoff) unavailable();
		const binding = this.index
			.read()
			.sessions.find((entry) => entry.ref === nativeSessionRef);
		if (!binding) unavailable();
		const file = await this.file(binding);
		const state = file.read();
		const turn = state.turns.find((entry) => entry.executionId === executionId);
		const requiresActiveExecution =
			request.kind !== "revoke" && request.kind !== "browser-crashed";
		if (
			!turn ||
			state.cancelled ||
			binding.agentId !== browser.binding.agentId ||
			binding.conversationId !== browser.binding.conversationId ||
			binding.sessionGeneration !== browser.binding.sessionGeneration ||
			(requiresActiveExecution && turn.status !== "running")
		)
			unavailable();
		const runtime = request.runtime;
		if (
			runtime.agentId !== browser.binding.agentId ||
			runtime.conversationId !== browser.binding.conversationId ||
			runtime.executionId !== executionId ||
			runtime.sessionGeneration !== browser.binding.sessionGeneration ||
			runtime.resourceFence !== browser.binding.resourceFence ||
			runtime.capabilityVersion !== browser.capabilityVersion
		)
			unavailable();
		switch (request.kind) {
			case "request":
				return handoff.request(request.reason, request.runtime);
			case "take-over":
				return handoff.takeOver({
					handoffId: request.handoffId,
					operatorId: request.operatorId,
					subjectId: request.subjectId,
					runtime: request.runtime,
				});
			case "return-to-agent":
				return handoff.returnToAgent({
					handoffId: request.handoffId,
					operatorId: request.operatorId,
					runtime: request.runtime,
				});
			case "revoke":
				handoff.assertBinding(request.runtime);
				return handoff.revoke(request.reason);
			case "browser-crashed":
				handoff.assertBinding(request.runtime);
				return handoff.markBrowserCrashed();
		}
	}

	/** Execute Browser side-effect confirmation through the existing controller. */
	async executeBrowserSideEffect(
		nativeSessionRef: string,
		executionId: string,
		request: RuntimeBrowserSideEffectConfirmationRequestV1,
		context: import("./driver.js").RuntimeDriverExecutionContextV1,
		signal: AbortSignal = new AbortController().signal,
	): Promise<RuntimeBrowserSideEffectConfirmationResultV1> {
		const browser = context.browser;
		if (!browser || typeof browser.executeSideEffect !== "function")
			unavailable();
		const binding = this.index
			.read()
			.sessions.find((entry) => entry.ref === nativeSessionRef);
		if (!binding) unavailable();
		const file = await this.file(binding);
		const state = file.read();
		const turn = state.turns.find((entry) => entry.executionId === executionId);
		if (
			!turn ||
			state.cancelled ||
			binding.agentId !== browser.binding.agentId ||
			binding.conversationId !== browser.binding.conversationId ||
			binding.sessionGeneration !== browser.binding.sessionGeneration ||
			(request.command !== "reject" && turn.status !== "running")
		)
			unavailable();
		if (
			request.binding.agentId !== browser.binding.agentId ||
			request.binding.conversationId !== browser.binding.conversationId ||
			request.binding.executionId !== executionId ||
			request.binding.capabilityVersion !== browser.capabilityVersion ||
			request.binding.sessionGeneration !== browser.binding.sessionGeneration ||
			request.binding.resourceFence !== browser.binding.resourceFence ||
			request.binding.workloadRevision !== browser.binding.workloadRevision ||
			request.binding.imageDigest !== browser.binding.imageDigest
		)
			unavailable();
		browser.handoff?.controller.assertAgentAccess();
		return browser.executeSideEffect(request, signal);
	}

	/** Return bounded Browser descriptors from the deployment-owned projection. */
	getBrowserToolDescriptors() {
		const browserCapability =
			typeof this.options.browserCapability === "function"
				? this.options.browserCapability()
				: this.options.browserCapability;
		return createCodexBrowserToolDescriptorsV1(browserCapability);
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
