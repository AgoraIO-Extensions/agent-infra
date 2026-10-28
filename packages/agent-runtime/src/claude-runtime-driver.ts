import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { FileProjectionV1Schema } from "@agent-infra/contracts/files";
import {
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
	RuntimeFileEventV2Schema,
	RuntimeModelConfigurationV3Schema,
	type RuntimeOperationFactV2,
	RuntimeOperationFactV2Schema,
	type RuntimeSelectionV1,
	RuntimeSelectionV1Schema,
	type RuntimeStatusV1,
	RuntimeStatusV1Schema,
} from "@agent-infra/contracts/runtime";
import type {
	Options as ClaudeQueryOptions,
	EffortLevel,
} from "@anthropic-ai/claude-agent-sdk";
import type { BrowserHandoffRecordV1 } from "./browser-handoff.js";
import { createClaudeBrowserMcpServer } from "./claude-browser-mcp.js";
import {
	CLAUDE_NATIVE_PROVENANCE,
	verifyClaudeInstallation,
} from "./claude-installation.js";
import { claudeQuery } from "./claude-query.js";
import { readClaudeSessionHistory } from "./claude-session-history.js";
import {
	claudeShellAvailable,
	claudeShellEnvironment,
} from "./claude-shell.js";
import { createClaudeStandardMcpServer } from "./claude-standard-mcp.js";
import {
	type ClaudeToolOperationCallbacks,
	claudeWorkspaceToolNames,
	claudeWorkspaceTools,
} from "./claude-workspace.js";
import {
	validateModelAccess,
	validateModelEndpoint,
} from "./codex-app-server-bridge.js";
import {
	type CodexBrowserToolDescriptorV1,
	createCodexBrowserToolDescriptorsV1,
} from "./codex-browser-tools.js";
import type {
	RuntimeBrowserHandoffRequestV1,
	RuntimeBrowserSideEffectConfirmationRequestV1,
	RuntimeBrowserSideEffectConfirmationResultV1,
	RuntimeDriver,
	RuntimeDriverCommand,
	RuntimeDriverExecutionContextV1,
	RuntimeDriverLookup,
	RuntimeDriverOperationRecord,
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
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
	openRuntimeMessagesTransport,
	type RuntimeMessagesTransportDiagnostic,
} from "./messages-model-transport.js";
import {
	projectNativeMetadataCommandsV1,
	projectNativeMetadataSkillsV1,
} from "./native-metadata-projection.js";
import { runtimeAuthorizationDenied } from "./runtime-authorization.js";
import {
	declareRuntimeTurnNotSubmittedBeforeNativeSubmitV1,
	type RuntimeFileBridgePortV1,
	readRuntimeFileResultReceiptV1,
} from "./runtime-file-bridge.js";
import {
	isSandboxAttachmentNativeImageV1,
	materializeSandboxAttachmentsV1,
	sandboxAttachmentIdsV1,
	sandboxAttachmentPromptTextV1,
} from "./sandbox-attachments.js";
import { SANDBOX_FILE_INSTRUCTIONS_V1 } from "./sandbox-file-instructions.js";
import {
	planSandboxResultsV1,
	publishSandboxResultsV1,
	sandboxResultAnswerText,
} from "./sandbox-result-references.js";
import {
	boundedRuntimeSkillRead,
	type RuntimeFilesystemSkillDirectoryV1,
	RuntimeSkillDirectoryErrorV1,
} from "./skill-hub-directory.js";
import {
	StandardMcpClient,
	type StandardMcpClientOptions,
	type StandardMcpOperation,
} from "./standard-mcp-client.js";
import {
	appendTurnOperationFactV1,
	isTurnResultPublicationV1,
	settleTurnResultPublicationV1,
	type TurnResultPublicationV1,
} from "./turn-result-publication.js";

export interface ClaudeRuntimeModelOption {
	readonly modelOptionId: string;
	readonly model: string;
	readonly reasoningLevels: readonly string[];
	readonly endpoint: string;
	readonly credential?: string;
	readonly authentication: "api-key" | "bearer";
}
export interface ClaudeRuntimeDriverOptions {
	/** Deployment-owned verified Browser projection; never selected by a wire command. */
	readonly browserCapability?:
		| import("@agent-infra/contracts/runtime").BrowserCapabilityAvailableV1
		| (() =>
				| import("@agent-infra/contracts/runtime").BrowserCapabilityAvailableV1
				| undefined);
	readonly path: string;
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly modelOptions: readonly ClaudeRuntimeModelOption[];
	readonly skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
	/** Deployment-owned protected standard MCP consumer input. */
	readonly standardConnectionClient?: StandardMcpClientOptions;
	readonly authorizeModelAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
}

/** Keep every Claude Query independent from user, project and local settings. */
export function claudeNativeQuerySettings(): Pick<
	ClaudeQueryOptions,
	"settingSources"
> {
	return { settingSources: [] };
}

/**
 * Keep Claude's native Skill entry point closed unless Host supplied the
 * verified, filesystem-backed Applied directory. Metadata-only directories are
 * still useful for discovery/read APIs, but they must not become a native path.
 * Claude's built-in session commands remain available without an Applied root.
 */
export function claudeNativeSkillLaunchOptions(
	skillDirectory?: RuntimeFilesystemSkillDirectoryV1,
): Pick<ClaudeQueryOptions, "additionalDirectories" | "skills" | "extraArgs"> {
	const nativeRoot = skillDirectory?.nativeRoot;
	if (
		typeof nativeRoot !== "string" ||
		nativeRoot.length === 0 ||
		!isAbsolute(nativeRoot) ||
		nativeRoot !== resolve(nativeRoot) ||
		typeof skillDirectory?.nativeSkillPaths !== "function"
	)
		return {};

	// The filesystem-backed directory verifies the immutable Applied files,
	// read-only mode and manifest digests here. A stale or revoked mount throws;
	// the caller's existing native-session failure path then remains fail-closed.
	let skillNames: string[] = [];
	try {
		const rootRealPath = realpathSync(nativeRoot);
		const contained = (path: string) => {
			const within = relative(rootRealPath, path);
			return within !== "" && !within.startsWith("..") && !isAbsolute(within);
		};
		const verifiedFileRealPath = (path: string) => {
			const info = lstatSync(path);
			if (!info.isFile() || info.isSymbolicLink())
				throw new RuntimeSkillDirectoryErrorV1();
			const realPath = realpathSync(path);
			if (!contained(realPath)) throw new RuntimeSkillDirectoryErrorV1();
			return realPath;
		};
		const skills = skillDirectory.findSkills();
		skillNames = skills.map((entry) => entry.name);
		const expectedSkillPaths = skills.map((entry) => {
			if (
				typeof entry.targetPath !== "string" ||
				!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(entry.name) ||
				!/^\.agents\/skills\/[a-z0-9][a-z0-9._-]{0,62}$/.test(
					entry.targetPath,
				) ||
				entry.targetPath !== `.agents/skills/${entry.name}` ||
				isAbsolute(entry.targetPath) ||
				entry.targetPath.includes("\\") ||
				entry.targetPath.split("/").some((part) => part === "..")
			)
				throw new RuntimeSkillDirectoryErrorV1();
			const path = resolve(rootRealPath, entry.targetPath, "SKILL.md");
			if (!contained(path)) throw new RuntimeSkillDirectoryErrorV1();
			return verifiedFileRealPath(path);
		});
		let nativeSkillPaths: readonly string[];
		try {
			nativeSkillPaths = skillDirectory.nativeSkillPaths();
		} catch {
			throw new RuntimeSkillDirectoryErrorV1();
		}
		const verifiedSkillPaths = nativeSkillPaths.map((path) => {
			if (
				typeof path !== "string" ||
				!isAbsolute(path) ||
				path.includes("\\") ||
				path.includes("\0") ||
				path.split("/").some((part) => part === "..")
			)
				throw new RuntimeSkillDirectoryErrorV1();
			const resolvedPath = resolve(path);
			return verifiedFileRealPath(resolvedPath);
		});
		const expectedSet = new Set(expectedSkillPaths);
		const verifiedSet = new Set(verifiedSkillPaths);
		const skillNameSet = new Set(skillNames);
		if (
			expectedSet.size !== skills.length ||
			nativeSkillPaths.length !== skills.length ||
			verifiedSet.size !== nativeSkillPaths.length ||
			verifiedSet.size !== expectedSet.size ||
			[...expectedSet].some((path) => !verifiedSet.has(path)) ||
			skillNameSet.size !== skills.length
		)
			throw new RuntimeSkillDirectoryErrorV1();
	} catch (error) {
		if (error instanceof RuntimeSkillDirectoryErrorV1) throw error;
		throw new RuntimeSkillDirectoryErrorV1();
	}
	return {
		additionalDirectories: [nativeRoot],
		skills: skillNames,
	};
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

function validMessagesTransportDiagnostic(
	diagnostic: RuntimeMessagesTransportDiagnostic,
) {
	return (
		[
			"request",
			"admission",
			"credential",
			"upstream_http",
			"upstream_content_type",
			"stream_validation",
			"transport",
			"abort",
		].includes(diagnostic.stage) &&
		typeof diagnostic.sent === "boolean" &&
		Number.isSafeInteger(diagnostic.durationMs) &&
		diagnostic.durationMs >= 0 &&
		(diagnostic.statusCode === undefined ||
			(Number.isInteger(diagnostic.statusCode) &&
				diagnostic.statusCode >= 100 &&
				diagnostic.statusCode <= 599))
	);
}

interface Turn {
	kind?: "submit-turn" | "native-command";
	executionId: string;
	turnId: string;
	operationKey: string;
	userMessageId: string;
	configVersion: string;
	selection: RuntimeSelectionV1;
	modelResponse?: {
		state: "sent" | "completed" | "failed" | "unknown";
		endTurn: boolean;
		diagnostic?: RuntimeMessagesTransportDiagnostic;
	};
	status: RuntimeStatusV1;
	/** An uncertain Connection operation permanently occupies this Turn after restart. */
	unknownHold?: true;
	/** V1 events plus #3226 V2 result-file events; each keeps its original version. */
	events: RuntimeEvent[];
	/** Durable metadata-only facts emitted at the Claude model/tool boundary. */
	operationFacts?: RuntimeOperationFactV2[];
	/**
	 * #3226：SDK `result` 成功、最终回答已确认后保存的发布计划；计划收敛后才写终态，
	 * 重启时沿已保存的进度继续。
	 */
	resultPublication?: TurnResultPublicationV1;
	operationRef?: string;
	attemptRef?: string;
	connectionOperations?: ConnectionOperation[];
}
interface ConnectionOperation {
	readonly callId: string;
	readonly alias: string;
	readonly name: string;
	readonly phase: "prepared" | "started" | "completed" | "failed" | "unknown";
	readonly rpcRequestId: string | number;
	readonly requestDigest: string;
	readonly consumerId: string;
	readonly instanceRef: string;
	readonly credentialRevision: string;
}
export function normalizeClaudeUncertainConnectionOperations(turn: {
	connectionOperations?: ConnectionOperation[];
	unknownHold?: true;
}) {
	const operations = turn.connectionOperations ?? [];
	const uncertain = operations.some((operation) =>
		["prepared", "started", "unknown"].includes(operation.phase),
	);
	if (uncertain) turn.unknownHold = true;
	if (
		operations.some((operation) =>
			["prepared", "started"].includes(operation.phase),
		)
	)
		turn.connectionOperations = operations.map((operation) =>
			["prepared", "started"].includes(operation.phase)
				? { ...operation, phase: "unknown" as const }
				: operation,
		);
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
	standardMcp?: StandardMcpClient;
	abortController: AbortController;
	pump: Promise<void>;
	retiring: boolean;
}
type Submit = Extract<RuntimeDriverCommand, { kind: "submit-turn" }>;
type NativeCommand = Extract<RuntimeDriverCommand, { kind: "native-command" }>;
const terminal = (status: RuntimeStatusV1) =>
	["completed", "cancelled", "failed"].includes(status);
const hasUnknownStatusEvent = (turn: Turn) => {
	const event = turn.events.at(-1);
	return event?.type === "status" && event.payload.status === "unknown";
};
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

const maxNativeCommands = 150;
const maxNativeCommandText = 4096;
const maxNativeCommandArgumentHint = 512;
const maxNativeCommandAliases = 32;

// Claude exposes commands and Skills through one flat supportedCommands() list.
// Keep the fixed Paseo session-control set as commands and treat all other
// entries as Skills. Skill Hub remains the only source of applied Skills.
const CLAUDE_NATIVE_COMMAND_NAMES = new Set([
	"clear",
	"compact",
	"context",
	"debug",
	"extra-usage",
	"heapdump",
	"init",
	"loop",
	"schedule",
	"usage",
]);

export type ClaudeNativeCommandReadContext = Readonly<{
	nativeSessionRef: string;
	signal: AbortSignal;
	expiresAt: number;
	assertCurrent(): void;
	revalidate(): Promise<void>;
}>;

export type ClaudeNativeCommandV1 = Readonly<{
	name: string;
	description: string;
	argumentHint: string;
	aliases: readonly string[];
}>;

function nativeCommandsInvalid(): never {
	throw new RuntimeHostError(
		"RUNTIME_NATIVE_COMMANDS_INVALID",
		"Claude native command metadata is unavailable",
		503,
	);
}

function boundedNativeCommandText(
	value: unknown,
	maximum: number,
	allowEmpty = false,
): string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		value.length > maximum
	)
		nativeCommandsInvalid();
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) nativeCommandsInvalid();
	}
	return value;
}

export function parseClaudeNativeCommands(
	value: readonly unknown[],
): readonly ClaudeNativeCommandV1[] {
	if (!Array.isArray(value) || value.length > maxNativeCommands)
		nativeCommandsInvalid();
	const names = new Set<string>();
	const commands = value.map((command) => {
		if (
			typeof command !== "object" ||
			command === null ||
			!Object.hasOwn(command, "name") ||
			!Object.hasOwn(command, "description") ||
			!Object.hasOwn(command, "argumentHint") ||
			(Object.hasOwn(command, "aliases") &&
				command.aliases !== undefined &&
				!Array.isArray(command.aliases))
		)
			nativeCommandsInvalid();
		const record = command as Record<string, unknown>;
		if (
			Object.keys(record).some(
				(key) =>
					!["name", "description", "argumentHint", "aliases"].includes(key),
			)
		)
			nativeCommandsInvalid();
		const name = boundedNativeCommandText(record.name, maxNativeCommandText);
		if (names.has(name)) nativeCommandsInvalid();
		names.add(name);
		const aliases = ((record.aliases ?? []) as unknown[]).map((alias) =>
			boundedNativeCommandText(alias, maxNativeCommandText),
		);
		if (
			aliases.length > maxNativeCommandAliases ||
			new Set(aliases).size !== aliases.length ||
			aliases.some((alias) => names.has(alias))
		)
			nativeCommandsInvalid();
		for (const alias of aliases) names.add(alias);
		return Object.freeze({
			name,
			description: boundedNativeCommandText(
				record.description,
				maxNativeCommandText,
			),
			argumentHint: boundedNativeCommandText(
				record.argumentHint,
				maxNativeCommandArgumentHint,
				true,
			),
			aliases: Object.freeze(aliases),
		});
	});
	return Object.freeze(commands);
}

function projectClaudeNativeCommands(input: {
	readonly nativeSessionRef: string;
	readonly configVersion: string;
	readonly commands: readonly ClaudeNativeCommandV1[];
	readonly skillNames?: ReadonlySet<string>;
}) {
	return projectNativeMetadataCommandsV1({
		nativeSessionRef: input.nativeSessionRef,
		configVersion: input.configVersion,
		source: {
			name: "Claude",
			version: CLAUDE_NATIVE_PROVENANCE.nativeVersion,
		},
		directory: {
			commands: input.commands
				.filter(
					(command) =>
						CLAUDE_NATIVE_COMMAND_NAMES.has(command.name) &&
						!input.skillNames?.has(command.name),
				)
				.map((command) => ({ ...command, source: "claude" })),
		},
	});
}

function selectClaudeNativeCommandRecords(
	value: readonly unknown[],
	skillNames?: ReadonlySet<string>,
) {
	if (!Array.isArray(value)) return value;
	return value.filter((entry) => {
		if (typeof entry !== "object" || entry === null) return false;
		const name = (entry as Record<string, unknown>).name;
		return (
			typeof name === "string" &&
			CLAUDE_NATIVE_COMMAND_NAMES.has(name) &&
			!skillNames?.has(name)
		);
	});
}

function verifiedClaudeNativeSkillNames(
	skillDirectory?: RuntimeFilesystemSkillDirectoryV1,
) {
	const launchOptions = claudeNativeSkillLaunchOptions(skillDirectory);
	return launchOptions.skills === undefined
		? undefined
		: new Set(launchOptions.skills);
}

async function boundedNativeCommandRead<T>(
	pending: Promise<T>,
	read: Pick<ClaudeNativeCommandReadContext, "signal" | "expiresAt">,
): Promise<T> {
	if (read.signal.aborted || read.expiresAt <= Date.now())
		runtimeAuthorizationDenied();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<T>((resolve, reject) => {
			const finish = (work: () => void) => {
				if (timer !== undefined) clearTimeout(timer);
				if (onAbort) read.signal.removeEventListener("abort", onAbort);
				work();
			};
			onAbort = () => {
				try {
					runtimeAuthorizationDenied();
				} catch (error) {
					finish(() => reject(error));
				}
			};
			timer = setTimeout(
				() => {
					try {
						runtimeAuthorizationDenied();
					} catch (error) {
						finish(() => reject(error));
					}
				},
				Math.max(0, read.expiresAt - Date.now()),
			);
			read.signal.addEventListener("abort", onAbort, { once: true });
			void pending.then(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			);
		});
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort) read.signal.removeEventListener("abort", onAbort);
	}
}

async function revalidateClaudeSkillRead(
	read: ClaudeNativeCommandReadContext,
	assertCurrent: () => void,
) {
	assertCurrent();
	try {
		await boundedNativeCommandRead(read.revalidate(), read);
	} catch {
		throw new RuntimeSkillDirectoryErrorV1();
	}
	assertCurrent();
}

export class ClaudeRuntimeDriver implements RuntimeDriver {
	private readonly files = new Map<string, Promise<DurableJsonFile<Session>>>();
	private readonly locks = new Map<string, Promise<unknown>>();
	private readonly handles = new Map<string, Handle>();
	private readonly waiters = new Map<string, Set<() => void>>();
	private closed = false;
	private readonly pending = new Set<Promise<unknown>>();
	private readonly readinessAbort = new AbortController();
	private closing?: Promise<void>;
	async validateExternalAction(
		action: import("./driver.js").RuntimeExternalActionAuthorization,
	) {
		if (
			action.kind !== "model" ||
			action.runtimeOperationId !== action.executionId
		)
			runtimeAuthorizationDenied();
		let binding: Binding | undefined;
		let file: DurableJsonFile<Session> | undefined;
		for (const entry of this.index.read().sessions) {
			const candidate = await this.file(entry);
			if (entry.ref === action.nativeSessionRef) {
				binding = entry;
				file = candidate;
				break;
			}
		}
		if (!binding || !file) runtimeAuthorizationDenied();
		const turn = file
			.read()
			.turns.find((item) => item.executionId === action.executionId);
		const fact = turn?.operationFacts
			?.filter(
				(entry) =>
					entry.kind === "model" &&
					entry.operationRef === action.operationRef &&
					entry.attemptRef === action.attemptRef,
			)
			.at(-1);
		const selectedModel =
			turn &&
			this.options.modelOptions.find(
				(option) => option.modelOptionId === turn.selection.modelOptionId,
			);
		if (
			!turn ||
			!fact ||
			fact.kind !== "model" ||
			!["intent", "started"].includes(fact.phase) ||
			fact.model.configVersion !== turn.configVersion ||
			fact.model.modelOptionId !== turn.selection.modelOptionId ||
			fact.model.modelId !== selectedModel?.model ||
			(action.operationRef === turn.operationRef
				? action.attemptRef !== turn.attemptRef
				: fact.parentOperationRef !== turn.operationRef)
		)
			runtimeAuthorizationDenied();
	}

	createNativeSkillCommand(command: RuntimeNativeSkillCommandV1) {
		if (!command.packageDigest || !command.manifestDigest)
			nativeSkillUnsupported();
		const launchOptions = claudeNativeSkillLaunchOptions(
			this.options.skillDirectory,
		);
		const directory = this.options.skillDirectory;
		if (
			!directory ||
			!launchOptions.additionalDirectories ||
			!launchOptions.skills
		)
			throw new RuntimeSkillDirectoryErrorV1();
		const entry = directory
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
		if (!entry || !launchOptions.skills.includes(entry.name))
			throw new RuntimeSkillDirectoryErrorV1();
		if (
			typeof command.parameters !== "string" ||
			!command.parameters.isWellFormed() ||
			command.parameters.length > 16 * 1024
		)
			nativeSkillUnsupported();
		const text = `/${entry.name}${
			command.parameters.length > 0 ? ` ${command.parameters}` : ""
		}`;
		if (text.length > 16 * 1024 || !text.isWellFormed())
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
		const directory = this.options.skillDirectory;
		if (!directory) throw new RuntimeSkillDirectoryErrorV1();
		const entry = directory
			.findSkills()
			.find(
				(candidate) =>
					candidate.name === input.capabilityName &&
					candidate.version === input.capabilitySourceVersion,
			);
		if (!entry) throw new RuntimeSkillDirectoryErrorV1();
		return {
			packageDigest: entry.packageDigest,
			manifestDigest: entry.manifestDigest,
		};
	}

	createNativeCommandCommand(command: RuntimeNativeCommandCommandV1) {
		if (
			command.capabilitySourceVersion !==
				CLAUDE_NATIVE_PROVENANCE.nativeVersion ||
			!CLAUDE_NATIVE_COMMAND_NAMES.has(command.capabilityName) ||
			!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(command.capabilityName) ||
			!command.parameters.isWellFormed() ||
			command.parameters.length > 16 * 1024 ||
			createHash("sha256").update(command.parameters).digest("hex") !==
				command.parametersDigest
		)
			nativeSkillUnsupported();
		if (
			verifiedClaudeNativeSkillNames(this.options.skillDirectory)?.has(
				command.capabilityName,
			)
		)
			nativeSkillUnsupported();
		return command;
	}

	/** Append one acknowledged Claude model/tool operation fact. */
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
		localTool = false,
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
			appendTurnOperationFactV1(turn, fact, localTool);
		});
	}
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
			if (option.credential === undefined) {
				// V4 projections intentionally omit provider credentials. They are
				// delivered by Host for this Execution immediately before the upstream
				// request; accepting a keyless option without that seam would leave the
				// transport unable to authenticate and would invite a static fallback.
				if (!options.authorizeModelAction)
					throw new Error("RUNTIME_CONFIGURATION_INVALID");
				validateModelEndpoint(option.endpoint);
			} else {
				validateModelAccess({
					endpoint: option.endpoint,
					credential: option.credential,
				});
			}
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
				const users = new Set<string>();
				const eventKeys = new Set<string>();
				const eventCursors = new Set<number>();
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
						!["submit-turn", "native-command"].includes(
							JSON.parse(turn.operationKey)[0],
						) ||
						(turn.kind !== undefined &&
							turn.kind !== JSON.parse(turn.operationKey)[0])
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
								turn.modelResponse.state !== "completed") ||
							(turn.modelResponse.diagnostic !== undefined &&
								!validMessagesTransportDiagnostic(
									turn.modelResponse.diagnostic,
								)))
					)
						unavailable();
					if (
						turn.operationFacts !== undefined &&
						(!Array.isArray(turn.operationFacts) ||
							turn.operationFacts.length > 256 ||
							turn.operationFacts.some(
								(fact) => !RuntimeOperationFactV2Schema.safeParse(fact).success,
							))
					)
						unavailable();
					if (
						turn.connectionOperations !== undefined &&
						(!Array.isArray(turn.connectionOperations) ||
							turn.connectionOperations.length > 32)
					)
						unavailable();
					const connectionCallIds = new Set<string>();
					for (const operation of turn.connectionOperations ?? []) {
						if (
							!uuid.test(operation.callId) ||
							connectionCallIds.has(operation.callId) ||
							!/^mcp_[A-Za-z0-9._:-]{1,127}$/.test(operation.alias) ||
							!operation.name ||
							operation.name.length > 128 ||
							![
								"prepared",
								"started",
								"completed",
								"failed",
								"unknown",
							].includes(operation.phase) ||
							(typeof operation.rpcRequestId !== "string" &&
								typeof operation.rpcRequestId !== "number") ||
							(typeof operation.rpcRequestId === "string" &&
								(!operation.rpcRequestId ||
									operation.rpcRequestId.length > 128)) ||
							(typeof operation.rpcRequestId === "number" &&
								!Number.isSafeInteger(operation.rpcRequestId)) ||
							!/^[a-f0-9]{64}$/.test(operation.requestDigest) ||
							!/^\w[\w.:-]{0,127}$/.test(operation.consumerId) ||
							!/^\w[\w.:-]{0,127}$/.test(operation.instanceRef) ||
							!/^\w[\w.:-]{0,127}$/.test(operation.credentialRevision)
						)
							unavailable();
						connectionCallIds.add(operation.callId);
					}
					executions.add(turn.executionId);
					turns.add(turn.turnId);
					users.add(turn.userMessageId);
					if (
						turn.resultPublication !== undefined &&
						!isTurnResultPublicationV1(turn.resultPublication)
					)
						unavailable();
					let completed = false;
					let corrected = false;
					let previousCursor = 0;
					for (const event of turn.events) {
						const cursor = /^claude-(\d+)$/.exec(event.cursor);
						const cursorNumber = cursor ? Number(cursor[1]) : 0;
						if (
							(completed && !(event.type === "status" && !corrected)) ||
							!RuntimeEventSchema.safeParse(event).success ||
							(event.schemaVersion === 2 &&
								!RuntimeFileEventV2Schema.safeParse(event).success) ||
							event.executionId !== turn.executionId ||
							!Number.isSafeInteger(cursorNumber) ||
							cursorNumber < 1 ||
							cursorNumber <= previousCursor ||
							eventCursors.has(cursorNumber) ||
							eventKeys.has(event.adapterEventKey)
						)
							unavailable();
						previousCursor = cursorNumber;
						eventCursors.add(cursorNumber);
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
					if (corrected) {
						if (turn.status !== "unknown" || !turn.unknownHold) unavailable();
					} else if (terminal(turn.status) !== completed) unavailable();
				}
				if (
					eventCursors.size !== state.sequence ||
					[...Array(state.sequence)].some(
						(_, index) => !eventCursors.has(index + 1),
					) ||
					state.turns.filter((turn) => !terminal(turn.status)).length > 1
				)
					unavailable();
				await file.update((state) => {
					for (const turn of state.turns) {
						normalizeClaudeUncertainConnectionOperations(turn);
						// #3226：SDK result 已确认、发布中断的 Turn 沿已保存的进度收敛（不重发），
						// 收敛后按原生 completed 写终态；其余未终结 Turn 仍按原规则处理。
						if (!terminal(turn.status) && turn.resultPublication) {
							settleTurnResultPublicationV1(turn);
							if (turn.status === "running" && !turn.unknownHold) {
								state.sequence++;
								turn.events.push(
									RuntimeEventV1Schema.parse({
										schemaVersion: 1,
										executionId: turn.executionId,
										adapterEventKey: randomUUID(),
										cursor: `claude-${state.sequence}`,
										occurredAt: new Date().toISOString(),
										type: "completed",
										payload: { status: "completed" },
									}),
								);
								turn.status = "completed";
							}
						}
						if (turn.kind === "native-command" && !terminal(turn.status)) {
							turn.unknownHold = true;
							if (!hasUnknownStatusEvent(turn)) {
								state.sequence++;
								turn.events.push(
									RuntimeEventV1Schema.parse({
										schemaVersion: 1,
										executionId: turn.executionId,
										adapterEventKey: randomUUID(),
										cursor: `claude-${state.sequence}`,
										occurredAt: new Date().toISOString(),
										type: "status",
										payload: { status: "unknown" },
									}),
								);
							}
						}
						if (turn.status === "running") turn.status = "unknown";
						if (turn.unknownHold && terminal(turn.status)) {
							const completed = turn.events.at(-1);
							if (completed?.type !== "completed") unavailable();
							state.sequence++;
							turn.events.push(
								RuntimeEventV1Schema.parse({
									schemaVersion: 1,
									executionId: turn.executionId,
									adapterEventKey: randomUUID(),
									cursor: `claude-${state.sequence}`,
									occurredAt: new Date().toISOString(),
									type: "status",
									payload: { status: "unknown" },
								}),
							);
							turn.status = "unknown";
							if (turn.modelResponse)
								turn.modelResponse = { state: "unknown", endTurn: false };
						}
					}
					if (state.turns.filter((turn) => !terminal(turn.status)).length > 1)
						unavailable();
				});
				for (const turn of file.read().turns) {
					if (
						!terminal(turn.status) &&
						!turn.unknownHold &&
						turn.configVersion === this.options.configVersion &&
						turn.modelResponse?.state === "failed"
					) {
						await this.status(file, turn.executionId, "failed");
						continue;
					}
					if (
						terminal(turn.status) ||
						turn.unknownHold ||
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
					const protectedCallIds = new Set(
						(turn.connectionOperations ?? []).map(
							(operation) => operation.callId,
						),
					);
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
							event.payload.name?.startsWith("mcp_")
						)
							continue;
						else if (
							event.type === "tool" &&
							typeof event.payload.id === "string"
						) {
							if (event.payload.phase === "started")
								tools.set(
									event.payload.id,
									claudeWorkspaceToolNames.includes(event.payload.name ?? "") ||
										(event.payload.name?.startsWith("mcp_") ?? false)
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
						(event) =>
							event.type === "text" ||
							(event.type === "tool" &&
								!protectedCallIds.has(event.payload.toolCallId)),
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
	execute(
		value: RuntimeDriverCommand,
		context?: RuntimeDriverExecutionContextV1,
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
		context?: RuntimeDriverExecutionContextV1,
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
			if (command.kind === "submit-turn")
				return this.submit(
					file,
					command,
					context?.fileBridge,
					context?.browser,
				);
			if (command.kind === "native-command") return this.submit(file, command);
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
	private async submit(
		file: DurableJsonFile<Session>,
		command: Submit | NativeCommand,
		fileBridge?: RuntimeFileBridgePortV1,
		browser?: RuntimeDriverExecutionContextV1["browser"],
	) {
		const before = file.read();
		const ref = before.binding.ref;
		if (
			browser &&
			(browser.binding.agentId !== command.agentId ||
				browser.binding.conversationId !== command.conversationId ||
				browser.binding.sessionGeneration !== command.sessionGeneration)
		)
			unavailable();
		if (before.cancelled) unavailable();
		const selection =
			command.kind === "submit-turn" && command.schemaVersion === 2
				? command.selection
				: command.kind === "native-command"
					? (before.turns.at(-1)?.selection ?? {
							schemaVersion: 1 as const,
							modelOptionId: this.options.defaultModelOptionId,
							reasoningLevel: this.options.defaultReasoningLevel,
						})
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
			if (command.kind === "native-command" || command.schemaVersion === 1)
				unavailable();
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
		const nativeCommandInput =
			command.kind === "native-command"
				? `/${command.capabilityName}${
						command.parameters.length > 0 ? ` ${command.parameters}` : ""
					}`
				: undefined;
		const attachmentIds =
			command.kind === "submit-turn"
				? sandboxAttachmentIdsV1(command.input.attachments, unavailable)
				: [];
		const userText =
			nativeCommandInput ??
			(command.kind === "submit-turn" && "text" in command.input
				? command.input.text
				: "");
		// #3225：只含附件的消息没有正文，原生输入只有附件清单与原生图片。
		if (!userText && attachmentIds.length === 0) unavailable();
		type ClaudeContent = Exclude<
			NonNullable<Parameters<typeof claudeQuery>[1]>["message"]["content"],
			string
		>;
		const content: ClaudeContent = [];
		const directory = join(this.options.path, ref);
		const workspace = join(directory, "workspace");
		if (attachmentIds.length > 0) {
			if (!fileBridge) unavailable();
			const bridge = fileBridge;
			// #3225：附件物化到本 Conversation 工作区的平台目录；图片另外作为 SDK image 块。
			await mkdir(workspace, { recursive: true, mode: 0o700 });
			if ((await lstat(workspace)).isSymbolicLink()) unavailable();
			const attachments = await materializeSandboxAttachmentsV1({
				root: this.options.path,
				workspace,
				fileIds: attachmentIds,
				read: (fileId) => bridge.readInput(fileId),
				invalid: unavailable,
				imageBytes: true,
			}).catch((error: unknown) =>
				// #3314/#3373：附件在 retire 与本操作的持久记录之前物化。平台的明确拒绝由 Host
				// 持久化为 rejected；其他读取或物化失败声明本次 Turn 未提交。
				declareRuntimeTurnNotSubmittedBeforeNativeSubmitV1(
					error,
					"file_input_unavailable",
					command,
				),
			);
			content.push({
				type: "text",
				text: sandboxAttachmentPromptTextV1(userText, attachments),
			});
			for (const attachment of attachments) {
				if (
					!attachment.imageBytes ||
					!isSandboxAttachmentNativeImageV1(attachment)
				)
					continue;
				content.push({
					type: "image",
					source: {
						type: "base64",
						media_type: attachment.mediaType,
						data: Buffer.from(attachment.imageBytes).toString("base64"),
					},
				} as ClaudeContent[number]);
			}
		} else content.push({ type: "text", text: userText });
		// A File Grant that lapsed while the attachments were acquired must not
		// survive into retirement or the native request.
		try {
			fileBridge?.revalidate();
		} catch (error) {
			declareRuntimeTurnNotSubmittedBeforeNativeSubmitV1(
				error,
				"session_preparation_failed",
				command,
			);
		}
		// Paseo ensureQuery retirement order: detach old work, drain it, then resume the same native ID.
		await this.retire(ref);
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
		for (const name of ["workspace", "config", "tmp", "memory", "home"]) {
			const path = join(directory, name);
			await mkdir(path, { recursive: true, mode: 0o700 });
			if ((await lstat(path)).isSymbolicLink()) unavailable();
		}
		const userMessageId = randomUUID();
		const operationRef = randomUUID();
		const attemptRef = randomUUID();
		await file.update((state) => {
			state.operations.push({
				key: operationKey(command),
				digest: digest(command),
			});
			state.turns.push({
				...(command.kind === "native-command"
					? { kind: "native-command" as const }
					: {}),
				executionId: command.executionId,
				turnId: command.turnId,
				operationKey: operationKey(command),
				userMessageId,
				configVersion: this.options.configVersion,
				selection,
				status: "unknown",
				events: [],
				operationRef,
				attemptRef,
			});
		});
		const modelFact = {
			kind: "model" as const,
			operationRef,
			attemptRef,
			model: {
				configVersion: this.options.configVersion,
				modelOptionId: selection.modelOptionId,
				modelId: option.model,
				reasoningLevel: selection.reasoningLevel,
			},
		};
		await this.recordFact(file, command.executionId, {
			...modelFact,
			phase: "intent",
		});
		const networkPermits = new Map<
			string,
			{ name: "WebFetch" | "WebSearch"; used: boolean }
		>();
		let modelRequests = 0;
		let primaryIssued = false;
		let admitted: () => void = () => {};
		const admission = new Promise<void>((resolve) => {
			admitted = resolve;
		});
		const admit = async () => {
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
		};
		const transport = await openRuntimeMessagesTransport({
			...option,
			effort: selection.reasoningLevel,
			openRequest: async (purpose) => {
				if (this.closed || modelRequests >= 64) unavailable();
				if (purpose === "web-fetch" || purpose === "web-search") {
					const name = purpose === "web-fetch" ? "WebFetch" : "WebSearch";
					const permit = [...networkPermits.values()].find(
						(entry) => entry.name === name && !entry.used,
					);
					if (!permit) throw new Error("RUNTIME_AUTHORIZATION_DENIED");
					permit.used = true;
				}
				modelRequests++;
				const first = purpose === "main" && !primaryIssued;
				if (first) primaryIssued = true;
				const requestFact = first
					? modelFact
					: {
							...modelFact,
							operationRef: randomUUID(),
							attemptRef: randomUUID(),
							parentOperationRef: operationRef,
							model: {
								...modelFact.model,
								...(purpose === "main" ? {} : { reasoningLevel: undefined }),
							},
						};
				if (!first)
					await this.recordFact(file, command.executionId, {
						...requestFact,
						phase: "intent",
					});
				let phase: "intent" | "started" | "completed" | "failed" | "unknown" =
					"intent";
				let startedAt: number | undefined;
				let revalidate: (() => void) | undefined;
				return {
					revalidate: () => {
						if (
							this.closed ||
							file
								.read()
								.turns.find((turn) => turn.executionId === command.executionId)
								?.status !== "running"
						)
							throw new Error("RUNTIME_AUTHORIZATION_DENIED");
						revalidate?.();
					},
					resolveCredential: async () => {
						if (
							this.closed ||
							file
								.read()
								.turns.find((turn) => turn.executionId === command.executionId)
								?.status !== "running"
						)
							throw new Error("RUNTIME_AUTHORIZATION_DENIED");
						if (!this.options.authorizeModelAction)
							return option.credential ?? "";
						const authorization = await this.options.authorizeModelAction({
							kind: "model",
							nativeSessionRef: ref,
							executionId: command.executionId,
							runtimeOperationId: command.executionId,
							operationRef: requestFact.operationRef,
							attemptRef: requestFact.attemptRef,
						});
						if (!authorization?.relayKey)
							throw new Error("RUNTIME_AUTHORIZATION_DENIED");
						revalidate = authorization.revalidate;
						return authorization.relayKey;
					},
					receipt: async (response, endTurn, diagnostic) => {
						const now = Date.now();
						if (response === "sent" && phase === "intent") {
							await this.recordFact(file, command.executionId, {
								...requestFact,
								phase: "started",
								startedAt: new Date(now).toISOString(),
							});
							startedAt = now;
							phase = "started";
						} else if (
							(phase === "started" || phase === "intent") &&
							response !== "sent"
						) {
							await this.recordFact(file, command.executionId, {
								...requestFact,
								phase: response,
								...(startedAt === undefined
									? {}
									: {
											startedAt: new Date(startedAt).toISOString(),
											durationMs: Math.max(0, now - startedAt),
										}),
								finishedAt: new Date(now).toISOString(),
								...(diagnostic?.usage ? { usage: diagnostic.usage } : {}),
								...(response === "failed"
									? { failureCode: "operation_failed" as const }
									: response === "unknown"
										? { failureCode: "recovery_unconfirmed" as const }
										: {}),
							});
							phase = response;
						}
						if (purpose === "main")
							await file.update((state) => {
								const turn =
									state.turns.find(
										(turn) => turn.executionId === command.executionId,
									) ?? unavailable();
								turn.modelResponse = {
									state: response,
									endTurn,
									...(diagnostic ? { diagnostic } : {}),
								};
							});
					},
				};
			},
			admit,
		});
		if (this.closed) {
			await transport.close();
			unavailable();
		}
		let standardMcp: StandardMcpClient | undefined;
		let standardMcpServer:
			| ReturnType<typeof createClaudeStandardMcpServer>
			| undefined;
		const browserAbortController = new AbortController();
		const browserCapability =
			typeof this.options.browserCapability === "function"
				? this.options.browserCapability()
				: this.options.browserCapability;
		const browserMcpServer = createClaudeBrowserMcpServer({
			capability: browserCapability,
			context: browser,
			executionId: command.executionId,
			signal: browserAbortController.signal,
		});
		let handle: Handle | undefined;
		try {
			if (this.options.standardConnectionClient) {
				standardMcp = await StandardMcpClient.open(
					this.options.standardConnectionClient,
					{
						agentId: command.agentId,
						conversationId: command.conversationId,
						executionId: command.executionId,
						sessionGeneration: command.sessionGeneration,
					},
					AbortSignal.timeout(10_000),
				);
				standardMcpServer = createClaudeStandardMcpServer({
					client: standardMcp,
					operation: (alias): StandardMcpOperation => {
						const callId = randomUUID();
						const name = standardMcp?.toolName(alias) ?? alias;
						const updatePhase = async (phase: ConnectionOperation["phase"]) => {
							await this.connectionOperation(
								file,
								command.executionId,
								callId,
								(operation) => ({ ...operation, phase }),
							);
						};
						const assertCurrent = () => {
							if (this.closed || handle?.retiring) unavailable();
							const turn = file
								.read()
								.turns.find(
									(entry) => entry.executionId === command.executionId,
								);
							if (turn?.status !== "running") unavailable();
						};
						return {
							assertCurrent: async () => {
								assertCurrent();
								await standardMcp?.assertCurrent();
								return () => {
									assertCurrent();
								};
							},
							block: () => {
								if (!handle) return;
								// An uncertain Connection WRITE must retire the native Claude
								// owner immediately. Marking the handle alone lets the process
								// continue until a later turn or driver shutdown.
								handle.retiring = true;
								void this.retire(ref).catch(() => {});
							},
							prepare: async ({ rpcRequestId, requestDigest }) => {
								await this.connectionOperation(
									file,
									command.executionId,
									callId,
									(operation) => ({ ...operation, phase: "prepared" }),
									{
										callId,
										alias,
										name,
										phase: "prepared",
										rpcRequestId,
										requestDigest,
										consumerId: standardMcp?.consumerId ?? unavailable(),
										instanceRef: standardMcp?.instanceRef ?? unavailable(),
										credentialRevision:
											standardMcp?.credentialRevision ?? unavailable(),
									},
								);
							},
							started: async () => {
								await updatePhase("started");
								await this.event(file, command.executionId, {
									type: "tool",
									payload: { toolCallId: callId, name, phase: "started" },
								});
							},
							confirm: async (response) => {
								await updatePhase(response.phase);
								if (response.phase === "unknown") {
									await this.status(file, command.executionId, "unknown");
									return;
								}
								await this.event(file, command.executionId, {
									type: "tool",
									payload: {
										toolCallId: callId,
										name,
										phase: response.phase,
									},
								});
							},
						};
					},
				});
			}
		} catch {
			if (standardMcp) await standardMcp.close().catch(() => {});
			browserAbortController.abort();
			await transport.close();
			return result(command, ref, unknownResult);
		}
		// The File Grant is checked once more at the native submission boundary: a
		// grant that lapsed during retirement, transport or Connection setup must
		// not cross into the native request.
		try {
			fileBridge?.revalidate();
		} catch (error) {
			if (standardMcp) await standardMcp.close().catch(() => {});
			browserAbortController.abort();
			await transport.close();
			// #3373：首条 Query 消息尚未发出。回滚本操作的记录与 Turn（同原生命令的失败路径）
			// 后声明本次 Turn 未提交；回滚失败时保持原错误。
			let discarded = false;
			try {
				await file.update((state) => {
					state.operations = state.operations.filter(
						(entry) => entry.key !== operationKey(command),
					);
					state.turns = state.turns.filter(
						(entry) => entry.executionId !== command.executionId,
					);
				});
				discarded = true;
			} catch {
				// The lapsed authority remains the actionable error.
			}
			if (discarded)
				declareRuntimeTurnNotSubmittedBeforeNativeSubmitV1(
					error,
					"session_preparation_failed",
					command,
				);
			throw error;
		}
		const toolFacts = new Map<
			string,
			{
				readonly operationRef: string;
				readonly attemptRef: string;
				readonly toolId: string;
			}
		>();
		const toolOperations: ClaudeToolOperationCallbacks = {
			authorizeNetwork: async (toolUseId, name) => {
				if (
					this.closed ||
					file
						.read()
						.turns.find((turn) => turn.executionId === command.executionId)
						?.status !== "running"
				)
					return false;
				if (!networkPermits.has(toolUseId)) {
					// Native auxiliary HTTP has no tool-use ID: admit one unambiguous
					// network invocation at a time instead of guessing a concurrent owner.
					if (networkPermits.size >= 1) return false;
					networkPermits.set(toolUseId, { name, used: false });
				}
				return true;
			},
			authorize: async () => {
				if (this.closed || handle?.retiring) return false;
				return (
					file
						.read()
						.turns.find((turn) => turn.executionId === command.executionId)
						?.status === "running"
				);
			},
			onStarted: async (toolUseId, toolName) => {
				if (
					!claudeWorkspaceToolNames.includes(toolName) ||
					toolFacts.has(toolUseId)
				)
					return;
				// Completion hooks confirm execution but supply no start timestamp.
				// Leave timing absent rather than measure post-execution persistence.
				const tool = {
					operationRef: randomUUID(),
					attemptRef: randomUUID(),
					toolId: toolName,
				};
				toolFacts.set(toolUseId, tool);
				await this.recordFact(
					file,
					command.executionId,
					{
						kind: "tool",
						executionBoundary: "sandbox-local",
						operationRef: tool.operationRef,
						attemptRef: tool.attemptRef,
						phase: "started",
						toolId: toolName,
					},
					true,
				);
			},
			onCompleted: async (toolUseId, toolName) => {
				networkPermits.delete(toolUseId);
				const tool = toolFacts.get(toolUseId);
				if (!tool) return;
				const finishedAt = Date.now();
				await this.recordFact(file, command.executionId, {
					kind: "tool",
					executionBoundary: "sandbox-local",
					operationRef: tool.operationRef,
					attemptRef: tool.attemptRef,
					phase: "completed",
					finishedAt: new Date(finishedAt).toISOString(),
					toolId: toolName,
				});
				toolFacts.delete(toolUseId);
			},
			onFailed: async (toolUseId, toolName, durationMs) => {
				networkPermits.delete(toolUseId);
				const tool = toolFacts.get(toolUseId);
				if (!tool) return;
				await this.recordFact(file, command.executionId, {
					kind: "tool",
					executionBoundary: "sandbox-local",
					operationRef: tool.operationRef,
					attemptRef: tool.attemptRef,
					phase: "failed",
					finishedAt: new Date().toISOString(),
					...(durationMs === undefined ? {} : { durationMs }),
					failureCode: "operation_failed",
					toolId: toolName,
				});
				toolFacts.delete(toolUseId);
			},
		};
		const settleToolFacts = async () => {
			if (!primaryIssued) {
				const current = file
					.read()
					.turns.find((turn) => turn.executionId === command.executionId);
				const primary = current?.operationFacts
					?.filter((fact) => fact.operationRef === operationRef)
					.at(-1);
				if (primary?.phase === "intent")
					await this.recordFact(file, command.executionId, {
						...modelFact,
						phase: "failed",
						failureCode: "request_rejected",
						finishedAt: new Date().toISOString(),
					});
			}
			for (const [toolUseId, tool] of toolFacts) {
				await this.recordFact(file, command.executionId, {
					kind: "tool",
					executionBoundary: "sandbox-local",
					operationRef: tool.operationRef,
					attemptRef: tool.attemptRef,
					phase: "unknown",
					finishedAt: new Date().toISOString(),
					failureCode: "recovery_unconfirmed",
					toolId: tool.toolId,
				});
				toolFacts.delete(toolUseId);
			}
		};
		let native: ReturnType<typeof claudeQuery>;
		let initialMessage: Parameters<typeof claudeQuery>[1];
		try {
			const shellAvailable = await claudeShellAvailable(workspace);
			const workspaceOperations = shellAvailable
				? {
						...toolOperations,
						authorizeShell: () => claudeShellAvailable(workspace),
					}
				: toolOperations;
			const skillLaunchOptions = claudeNativeSkillLaunchOptions(
				this.options.skillDirectory,
			);
			const skillRoot = skillLaunchOptions.additionalDirectories?.[0];
			const resolveReadOnlySkillFile = skillRoot
				? async (filePath: string, signal: AbortSignal) => {
						if (signal.aborted) return undefined;
						const relativePath = relative(skillRoot, filePath);
						if (
							!relativePath ||
							relativePath.startsWith("..") ||
							isAbsolute(relativePath)
						)
							return undefined;
						const [name, ...parts] = relativePath.split("/");
						const resourcePath = parts.join("/");
						if (!name || !resourcePath) return undefined;
						const bytes = await this.options.skillDirectory?.readSkill(
							name,
							resourcePath,
						);
						if (!bytes || signal.aborted) return undefined;
						const verifiedRoot = join(directory, "tmp", "verified-skill-reads");
						await mkdir(verifiedRoot, { recursive: true, mode: 0o700 });
						const target = join(
							verifiedRoot,
							`${randomUUID()}-${basename(resourcePath)}`,
						);
						await writeFile(target, bytes, { mode: 0o400 });
						await chmod(target, 0o400);
						return target;
					}
				: undefined;
			initialMessage = {
				type: "user" as const,
				session_id: before.nativeId,
				uuid: userMessageId,
				parent_tool_use_id: null,
				message: {
					role: "user" as const,
					content,
				},
			};
			native = claudeQuery(
				{
					pathToClaudeCodeExecutable: this.executable,
					cwd: join(directory, "workspace"),
					env: {
						PATH: process.env.PATH,
						HOME: join(directory, "home"),
						TMPDIR: join(directory, "tmp"),
						CLAUDE_CONFIG_DIR: join(directory, "config"),
						ANTHROPIC_BASE_URL: transport.modelAccess.endpoint,
						ANTHROPIC_AUTH_TOKEN: transport.modelAccess.credential,
						CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
						ANTHROPIC_SMALL_FAST_MODEL: option.model,
						ANTHROPIC_DEFAULT_HAIKU_MODEL: option.model,
						...(shellAvailable ? claudeShellEnvironment(workspace) : {}),
					},
					sandbox: { enabled: false },
					...claudeNativeQuerySettings(),
					...claudeWorkspaceTools(
						workspace,
						join(directory, "memory"),
						resolveReadOnlySkillFile
							? {
									...workspaceOperations,
									resolveReadOnlyFile: resolveReadOnlySkillFile,
									cleanupReadOnlyFile: async (filePath: string) => {
										await unlink(filePath).catch(() => undefined);
									},
								}
							: workspaceOperations,
					),
					strictMcpConfig: true,
					mcpServers: {
						...(standardMcpServer ? { connection: standardMcpServer } : {}),
						...(browserMcpServer ? { browser: browserMcpServer } : {}),
					},
					...skillLaunchOptions,
					systemPrompt: `You are an assistant. Follow the user's request. Your workspace is ${join(directory, "workspace")}. Your private persistent memory directory is ${join(directory, "memory")}. You may read and write files only in these two directories. Read MEMORY.md there for saved user preferences when present.\n${SANDBOX_FILE_INSTRUCTIONS_V1}`,
					model: option.model,
					effort: selection.reasoningLevel as EffortLevel,
					thinking: { type: "adaptive" },
					includePartialMessages: true,
					...(before.started
						? { resume: before.nativeId }
						: { sessionId: before.nativeId }),
				},
				command.kind === "native-command" ? undefined : initialMessage,
			);
		} catch {
			if (standardMcp) await standardMcp.close().catch(() => {});
			browserAbortController.abort();
			await transport.close();
			await settleToolFacts();
			return result(command, ref, unknownResult);
		}
		if (command.kind === "native-command") {
			try {
				const skillNames = verifiedClaudeNativeSkillNames(
					this.options.skillDirectory,
				);
				const current = parseClaudeNativeCommands(
					selectClaudeNativeCommandRecords(
						await boundedNativeCommandRead(native.query.supportedCommands(), {
							signal: AbortSignal.timeout(30_000),
							expiresAt: Date.now() + 30_000,
						}),
						skillNames,
					),
				);
				const projection = projectClaudeNativeCommands({
					nativeSessionRef: command.nativeSessionRef,
					configVersion: this.options.configVersion,
					commands: current,
					...(skillNames ? { skillNames } : {}),
				});
				if (
					projection.selector !== "commands" ||
					projection.revision !== command.directoryRevision ||
					!projection.capabilities.some(
						(entry) =>
							entry.id === command.capabilityId &&
							entry.name === command.capabilityName &&
							entry.source.version === command.capabilitySourceVersion,
					)
				)
					throw new Error("RUNTIME_NATIVE_CAPABILITY_STALE");
			} catch {
				await native.close().catch(() => {});
				if (standardMcp) await standardMcp.close().catch(() => {});
				browserAbortController.abort();
				await transport.close();
				await file.update((state) => {
					state.operations = state.operations.filter(
						(entry) => entry.key !== operationKey(command),
					);
					state.turns = state.turns.filter(
						(entry) => entry.executionId !== command.executionId,
					);
				});
				nativeSkillUnsupported();
			}
			await admit();
			native.send(initialMessage);
		}
		handle = {
			native,
			transport,
			...(standardMcp ? { standardMcp } : {}),
			abortController: browserAbortController,
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
						await settleToolFacts();
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
							if (!name.startsWith("mcp_"))
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
						const nativeToolName = message.event.content_block.name;
						const requested = nativeToolName.startsWith("mcp__connection__")
							? nativeToolName.slice("mcp__connection__".length)
							: nativeToolName;
						// #3217：模型调用未开放的工具时，原生 CLI 自己返回工具错误；这里只记为
						// unavailable 工具，不让本轮失败。
						const name =
							claudeWorkspaceToolNames.includes(requested) ||
							["WebFetch", "WebSearch"].includes(requested) ||
							requested.startsWith("mcp_")
								? requested
								: "unavailable";
						tools.set(message.event.content_block.id, name);
						if (!name.startsWith("mcp_"))
							await this.event(file, command.executionId, {
								type: "tool",
								payload: {
									toolCallId: createHash("sha256")
										.update(message.event.content_block.id)
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
						await settleToolFacts();
						const status =
							transport.failure() ??
							(message.subtype === "success" && !message.is_error
								? "completed"
								: "failed");
						// #3226：SDK result 确认最终回答后、写终态前发布回答内 sandbox: 引用。
						if (status === "completed" && !handle.retiring)
							await this.publishTurnResults(
								file,
								command,
								fileBridge,
								workspace,
							);
						await this.status(file, command.executionId, status);
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
				) {
					await settleToolFacts();
					await this.status(
						file,
						command.executionId,
						transport.failure() ?? "unknown",
					);
				}
			} catch {
				if (
					!handle.retiring &&
					!terminal(
						file
							.read()
							.turns.find((turn) => turn.executionId === command.executionId)
							?.status ?? unavailable(),
					)
				) {
					await settleToolFacts();
					await this.status(
						file,
						command.executionId,
						transport.failure() ?? "unknown",
					);
				}
			} finally {
				browserAbortController.abort();
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
	/**
	 * #3226：解析最终回答中的 `sandbox:` 引用，持久保存发布计划后逐个发布；计划与每一步
	 * 进度都在 Turn 写终态之前进入同一持久状态。
	 */
	private async publishTurnResults(
		file: DurableJsonFile<Session>,
		command: RuntimeDriverCommand,
		fileBridge:
			| import("./runtime-file-bridge.js").RuntimeFileBridgePortV1
			| undefined,
		workspace: string,
	) {
		const current = () =>
			file
				.read()
				.turns.find((turn) => turn.executionId === command.executionId);
		const turn = current();
		if (!turn || turn.status !== "running" || turn.unknownHold) return;
		const { plan } = planSandboxResultsV1({
			text: sandboxResultAnswerText(turn.events),
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
			draft.resultPublication = { plan };
		});
		await publishSandboxResultsV1({
			bridge: fileBridge,
			workspaceRoot: workspace,
			ledger: {
				read: () => current()?.resultPublication?.plan,
				commit: async ({ plan: next, facts, receipt }) => {
					if (receipt) await this.recordResultFile(command, receipt);
					await file.update((state) => {
						const draft = state.turns.find(
							(entry) => entry.executionId === command.executionId,
						);
						if (!draft?.resultPublication || terminal(draft.status))
							throw new RuntimeHostError(
								"RUNTIME_OPERATION_CONFLICT",
								"Runtime operation fact is no longer current",
								409,
							);
						for (const fact of facts) appendTurnOperationFactV1(draft, fact);
						draft.resultPublication.plan = next;
					});
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
	private async connectionOperation(
		file: DurableJsonFile<Session>,
		executionId: string,
		callId: string,
		change: (operation: ConnectionOperation) => ConnectionOperation,
		initial?: ConnectionOperation,
	) {
		await file.update((state) => {
			const turn = state.turns.find(
				(entry) => entry.executionId === executionId,
			);
			if (!turn || terminal(turn.status)) return;
			turn.connectionOperations ??= [];
			const index = turn.connectionOperations.findIndex(
				(operation) => operation.callId === callId,
			);
			if (index === -1) {
				const first = initial;
				if (!first) unavailable();
				if (turn.connectionOperations.length >= 32) unavailable();
				turn.connectionOperations.push(first);
				return;
			}
			const current = turn.connectionOperations[index];
			if (!current) unavailable();
			turn.connectionOperations[index] = change(current);
		});
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
		handle.abortController.abort();
		if (handle.standardMcp) await handle.standardMcp.close();
		await handle.transport.close();
		await handle.native.close();
		await handle.pump;
		if (this.handles.get(ref) === handle) this.handles.delete(ref);
	}
	close() {
		this.closing ??= (async () => {
			this.closed = true;
			this.readinessAbort.abort();
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

	/** Read bounded non-Codex metadata without opening a native Turn. */
	async readNativeMetadataV1(
		selector: NativeMetadataSelectorV1,
		read: RuntimeNativeMetadataReadContextV1,
	): Promise<NativeMetadataProjectionV1> {
		read.assertCurrent();
		const nativeRead: ClaudeNativeCommandReadContext = {
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
			const commands = await this.discoverNativeCommands(nativeRead);
			const projection = projectClaudeNativeCommands({
				nativeSessionRef: read.nativeSessionRef,
				configVersion: this.options.configVersion,
				commands,
			});
			if (projection.selector !== "commands") nativeMetadataUnsupported();
			read.assertCurrent();
			return projection;
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

	async discoverNativeCommands(
		read: ClaudeNativeCommandReadContext,
	): Promise<readonly ClaudeNativeCommandV1[]> {
		const handle = this.handles.get(read.nativeSessionRef);
		if (!handle || handle.retiring) unavailable();
		const assertCurrent = () => {
			if (
				read.signal.aborted ||
				handle.retiring ||
				read.expiresAt <= Date.now() ||
				this.handles.get(read.nativeSessionRef) !== handle
			)
				runtimeAuthorizationDenied();
			read.assertCurrent();
		};
		const revalidate = async () => {
			assertCurrent();
			try {
				await boundedNativeCommandRead(read.revalidate(), read);
			} catch {
				runtimeAuthorizationDenied();
			}
			assertCurrent();
		};
		await revalidate();
		const commands = await boundedNativeCommandRead(
			handle.native.query.supportedCommands(),
			read,
		);
		await revalidate();
		const skillNames = verifiedClaudeNativeSkillNames(
			this.options.skillDirectory,
		);
		return parseClaudeNativeCommands(
			selectClaudeNativeCommandRecords(commands, skillNames),
		);
	}
	/** Return the deployment-owned Hub projection without consulting Claude. */
	async discoverNativeSkills(read: ClaudeNativeCommandReadContext) {
		const handle = this.handles.get(read.nativeSessionRef);
		const directory = this.options.skillDirectory;
		if (!handle || handle.retiring || !directory)
			throw new RuntimeSkillDirectoryErrorV1();
		const generationId = directory.generationId;
		const projectionSnapshot = JSON.stringify(directory.findSkills());
		const assertCurrent = () => {
			if (
				read.signal.aborted ||
				read.expiresAt <= Date.now() ||
				handle.retiring ||
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
				await boundedNativeCommandRead(read.revalidate(), read);
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
		read: ClaudeNativeCommandReadContext,
		name: string,
		relativePath: string,
	): Promise<Uint8Array> {
		const handle = this.handles.get(read.nativeSessionRef);
		const directory = this.options.skillDirectory;
		if (!handle || handle.retiring || !directory)
			throw new RuntimeSkillDirectoryErrorV1();
		const generationId = directory.generationId;
		const projectionSnapshot = JSON.stringify(directory.findSkills());
		const assertCurrent = () => {
			if (
				read.signal.aborted ||
				read.expiresAt <= Date.now() ||
				handle.retiring ||
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
		await revalidateClaudeSkillRead(read, assertCurrent);
		const bytes = await boundedRuntimeSkillRead({
			pending: directory.readSkill(name, relativePath),
			signal: read.signal,
			expiresAt: read.expiresAt,
		});
		assertCurrent();
		await revalidateClaudeSkillRead(read, assertCurrent);
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
		const session = await this.binding(command, false);
		if (!session) unavailable();
		const file = await this.file(session);
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
				cursor: `claude-${state.sequence}`,
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
		for (const wake of this.waiters.get(session.ref) ?? []) wake();
	}

	probeReadiness(signal: AbortSignal) {
		const pending = this.probeNativeReadiness(
			AbortSignal.any([signal, this.readinessAbort.signal]),
		);
		this.pending.add(pending);
		void pending.then(
			() => this.pending.delete(pending),
			() => this.pending.delete(pending),
		);
		return pending;
	}

	private async probeNativeReadiness(signal: AbortSignal) {
		if (this.closed) unavailable();
		signal.throwIfAborted();
		const option =
			this.options.modelOptions.find(
				(option) => option.modelOptionId === this.options.defaultModelOptionId,
			) ?? unavailable();
		const directory = await mkdtemp(
			join(tmpdir(), "agent-infra-claude-readiness-"),
		);
		let transport:
			| Awaited<ReturnType<typeof openRuntimeMessagesTransport>>
			| undefined;
		let native: ReturnType<typeof claudeQuery> | undefined;
		const denyModelAccess = async (): Promise<never> => {
			throw new Error("RUNTIME_READINESS_UNAVAILABLE");
		};
		try {
			await Promise.all(
				["home", "config", "workspace", "tmp"].map((name) =>
					mkdir(join(directory, name), { mode: 0o700 }),
				),
			);
			// Readiness has no Execution Key or authority to contact the model.
			transport = await openRuntimeMessagesTransport({
				endpoint: option.endpoint,
				authentication: option.authentication,
				model: option.model,
				effort: this.options.defaultReasoningLevel,
				client: "claude",
				admit: denyModelAccess,
				resolveCredential: denyModelAccess,
			});
			signal.throwIfAborted();
			native = claudeQuery({
				pathToClaudeCodeExecutable: this.executable,
				cwd: join(directory, "workspace"),
				env: {
					PATH: process.env.PATH,
					HOME: join(directory, "home"),
					TMPDIR: join(directory, "tmp"),
					CLAUDE_CONFIG_DIR: join(directory, "config"),
					ANTHROPIC_BASE_URL: transport.modelAccess.endpoint,
					ANTHROPIC_AUTH_TOKEN: transport.modelAccess.credential,
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				},
				...claudeNativeQuerySettings(),
				model: option.model,
				tools: [],
				mcpServers: {},
				strictMcpConfig: true,
				permissionMode: "dontAsk",
				persistSession: false,
			});
			await boundedNativeCommandRead(native.query.initializationResult(), {
				signal,
				expiresAt: Date.now() + 10_000,
			});
			signal.throwIfAborted();
			return await this.getCapabilities();
		} catch {
			throw new Error("RUNTIME_READINESS_UNAVAILABLE");
		} finally {
			try {
				await native?.close();
			} finally {
				try {
					await transport?.close();
				} finally {
					await rm(directory, { recursive: true, force: true });
				}
			}
		}
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
			attachments: true,
			resultFiles: true,
			connection: this.options.standardConnectionClient !== undefined,
			supplementaryInstruction: false,
			...(skills && skills.length > 0 ? { skills } : {}),
		};
		const parsed = RuntimeCapabilitiesV1Schema.safeParse(capabilities);
		if (!parsed.success) throw new RuntimeSkillDirectoryErrorV1();
		return parsed.data;
	}
	async getModelDirectory(
		_nativeSessionRef: string,
	): Promise<RuntimeModelDirectory> {
		return unavailable();
	}

	/** Execute Browser handoff through the existing request-local controller. */
	async executeBrowserHandoff(
		nativeSessionRef: string,
		executionId: string,
		request: RuntimeBrowserHandoffRequestV1,
		context: RuntimeDriverExecutionContextV1,
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
		context: RuntimeDriverExecutionContextV1,
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

	/** Return the same bounded Browser descriptor contract used by Codex. */
	getBrowserToolDescriptors(): readonly CodexBrowserToolDescriptorV1[] {
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
