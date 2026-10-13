import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { FileProjectionV1Schema } from "@agent-infra/contracts/files";
import {
	type NativeMetadataProjectionV1,
	type NativeMetadataSelectorV1,
	RuntimeCapabilitiesV1Schema,
	RuntimeDriverCommandV1Schema,
	RuntimeDriverOperationRecordV1Schema,
	RuntimeDriverSubmitTurnCommandV2Schema,
	RuntimeDriverSubmitTurnOperationRecordV2Schema,
	type RuntimeEventV1,
	RuntimeEventV1Schema,
	RuntimeModelConfigurationV3Schema,
	type RuntimeOperationFactV2,
	RuntimeOperationFactV2Schema,
	type RuntimeSelectionV1,
	RuntimeSelectionV1Schema,
	type RuntimeStatusV1,
	RuntimeStatusV1Schema,
} from "@agent-infra/contracts/runtime";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeBrowserMcpServer } from "./claude-browser-mcp.js";
import {
	CLAUDE_NATIVE_PROVENANCE,
	verifyClaudeInstallation,
} from "./claude-installation.js";
import { claudeQuery } from "./claude-query.js";
import { readClaudeSessionHistory } from "./claude-session-history.js";
import { createClaudeStandardMcpServer } from "./claude-standard-mcp.js";
import {
	type ClaudeFileWriteOutput,
	type ClaudeToolOperationCallbacks,
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
	RuntimeDriver,
	RuntimeDriverCommand,
	RuntimeDriverExecutionContextV1,
	RuntimeDriverLookup,
	RuntimeDriverOperationRecord,
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
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
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import {
	projectNativeMetadataCommandsV1,
	projectNativeMetadataSkillsV1,
} from "./native-metadata-projection.js";
import { runtimeAuthorizationDenied } from "./runtime-authorization.js";
import {
	type RuntimeFileBridgePortV1,
	readRuntimeFileResultReceiptV1,
} from "./runtime-file-bridge.js";
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
	/** Durable metadata-only facts emitted at the Claude model/tool boundary. */
	operationFacts?: RuntimeOperationFactV2[];
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

const maxNativeCommands = 150;
const maxNativeCommandText = 4096;
const maxNativeCommandArgumentHint = 512;
const maxNativeCommandAliases = 32;
const claudeAttachmentMaximumBytes = 50 * 1024 * 1024;
const claudeAttachmentMediaTypes = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
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
	private readonly pending = new Set<Promise<RuntimeDriverOperationRecord>>();
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
		if (
			!turn ||
			turn.operationRef !== action.operationRef ||
			turn.attemptRef !== action.attemptRef
		)
			runtimeAuthorizationDenied();
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
			const latestPhases = new Map<string, RuntimeOperationFactV2["phase"]>();
			for (const entry of turn.operationFacts)
				latestPhases.set(
					JSON.stringify([entry.operationRef, entry.attemptRef]),
					entry.phase,
				);
			latestPhases.set(
				JSON.stringify([fact.operationRef, fact.attemptRef]),
				fact.phase,
			);
			let reservedSlots = 0;
			for (const phase of latestPhases.values()) {
				if (phase === "intent") reservedSlots += 2;
				else if (phase === "started") reservedSlots += 1;
			}
			if (turn.operationFacts.length + 1 + reservedSlots > 256)
				throw new RuntimeHostError(
					"RUNTIME_OPERATION_CONFLICT",
					"Runtime operation fact journal is full",
					409,
				);
			turn.operationFacts.push(fact);
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
									["Read", "Write", "Edit"].includes(
										event.payload.name ?? "",
									) ||
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
		command: Submit,
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
		const content: Exclude<
			Parameters<typeof claudeQuery>[1]["message"]["content"],
			string
		> = [{ type: "text", text: command.input.text }];
		for (const fileId of command.input.attachments) {
			if (!fileBridge) unavailable();
			const input = await fileBridge.readInput(fileId);
			if (
				input.fileId !== fileId ||
				!claudeAttachmentMediaTypes.has(input.descriptor.mediaType) ||
				input.descriptor.sizeBytes > claudeAttachmentMaximumBytes
			)
				unavailable();
			const reader = input.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					if (!(next.value instanceof Uint8Array)) unavailable();
					size += next.value.byteLength;
					if (size > claudeAttachmentMaximumBytes) unavailable();
					chunks.push(next.value);
				}
			} catch (error) {
				await reader.cancel().catch(() => undefined);
				throw error;
			} finally {
				reader.releaseLock();
			}
			const bytes = Buffer.concat(chunks);
			if (
				size !== input.descriptor.sizeBytes ||
				createHash("sha256").update(bytes).digest("hex") !==
					input.descriptor.sha256
			)
				unavailable();
			content.push({
				type: "image",
				source: {
					type: "base64",
					media_type: input.descriptor.mediaType,
					data: bytes.toString("base64"),
				},
			} as Exclude<
				Parameters<typeof claudeQuery>[1]["message"]["content"],
				string
			>[number]);
		}
		// A File Grant that lapsed while the attachments were acquired must not
		// survive into retirement or the native request.
		fileBridge?.revalidate();
		// Paseo ensureQuery retirement order: detach old work, drain it, then resume the same native ID.
		await this.retire(ref);
		const directory = join(this.options.path, ref);
		const workspace = join(directory, "workspace");
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
		let modelPhase: "intent" | "started" | "completed" | "failed" | "unknown" =
			"intent";
		let modelStartedAt: number | undefined;
		let admitted: () => void = () => {};
		const admission = new Promise<void>((resolve) => {
			admitted = resolve;
		});
		const transport = await openRuntimeMessagesTransport({
			...option,
			effort: selection.reasoningLevel,
			...(this.options.authorizeModelAction
				? {
						resolveCredential: async () => {
							const authorized = await this.options.authorizeModelAction?.({
								kind: "model",
								nativeSessionRef: before.nativeId,
								executionId: command.executionId,
								runtimeOperationId: command.executionId,
								operationRef,
								attemptRef,
							});
							if (!authorized?.relayKey)
								throw new Error("RUNTIME_AUTHORIZATION_DENIED");
							return authorized.relayKey;
						},
					}
				: {}),
			receipt: async (response, endTurn = false) => {
				const now = Date.now();
				if (response === "sent" && modelPhase === "intent") {
					modelStartedAt = now;
					modelPhase = "started";
					await this.recordFact(file, command.executionId, {
						...modelFact,
						phase: "started",
						startedAt: new Date(now).toISOString(),
					});
				} else if (
					modelStartedAt !== undefined &&
					modelPhase === "started" &&
					(response === "completed" ||
						response === "failed" ||
						response === "unknown")
				) {
					modelPhase = response;
					await this.recordFact(file, command.executionId, {
						...modelFact,
						phase: response,
						finishedAt: new Date(now).toISOString(),
						durationMs: Math.max(0, now - modelStartedAt),
						...(response === "failed"
							? { failureCode: "operation_failed" as const }
							: response === "unknown"
								? { failureCode: "recovery_unconfirmed" as const }
								: {}),
					});
				}
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
								if (handle) handle.retiring = true;
								void standardMcp?.close();
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
			throw error;
		}
		let resultFileWritten = false;
		let resultFileInFlight = false;
		const onResultFile = async (output: ClaudeFileWriteOutput) => {
			if (!fileBridge || resultFileWritten || resultFileInFlight) return;
			resultFileInFlight = true;
			try {
				if (!isAbsolute(output.filePath)) return;
				const root = await realpath(workspace).catch(() => undefined);
				const actual = await realpath(output.filePath).catch(() => undefined);
				if (!root || !actual) return;
				const within = relative(root, actual);
				if (!within || within.startsWith("..") || isAbsolute(within)) return;
				const content =
					typeof output.content === "string"
						? output.content
						: await readFile(actual, "utf8").catch(() => undefined);
				if (content === undefined) return;
				const bytes = Buffer.from(content, "utf8");
				if (bytes.byteLength > 10 * 1024 * 1024) return;
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
			} catch {
				// Result publication is fail-closed and must not corrupt the native Turn.
			} finally {
				resultFileInFlight = false;
			}
		};
		const toolFacts = new Map<
			string,
			{
				readonly operationRef: string;
				readonly attemptRef: string;
				readonly toolId: string;
				startedAt?: number;
			}
		>();
		const toolOperations: ClaudeToolOperationCallbacks = {
			authorize: async () => {
				if (this.closed || handle?.retiring) return false;
				return (
					file
						.read()
						.turns.find((turn) => turn.executionId === command.executionId)
						?.status === "running"
				);
			},
			onIntent: async (toolUseId, toolName) => {
				if (toolFacts.has(toolUseId)) return;
				const operationRef = randomUUID();
				const attemptRef = randomUUID();
				const tool = { operationRef, attemptRef, toolId: toolName };
				await this.recordFact(file, command.executionId, {
					kind: "tool",
					operationRef,
					attemptRef,
					phase: "intent",
					toolId: toolName,
				});
				toolFacts.set(toolUseId, tool);
			},
			onStarted: async (toolUseId, toolName) => {
				const tool = toolFacts.get(toolUseId);
				if (!tool || tool.startedAt !== undefined) return;
				const startedAt = Date.now();
				tool.startedAt = startedAt;
				await this.recordFact(file, command.executionId, {
					kind: "tool",
					operationRef: tool.operationRef,
					attemptRef: tool.attemptRef,
					phase: "started",
					startedAt: new Date(startedAt).toISOString(),
					toolId: toolName,
				});
			},
			onCompleted: async (toolUseId, toolName) => {
				const tool = toolFacts.get(toolUseId);
				if (!tool) return;
				const finishedAt = Date.now();
				await this.recordFact(file, command.executionId, {
					kind: "tool",
					operationRef: tool.operationRef,
					attemptRef: tool.attemptRef,
					phase: "completed",
					finishedAt: new Date(finishedAt).toISOString(),
					...(tool.startedAt === undefined
						? {}
						: { durationMs: Math.max(0, finishedAt - tool.startedAt) }),
					toolId: toolName,
				});
				toolFacts.delete(toolUseId);
			},
			onFailed: async (toolUseId, toolName, durationMs) => {
				const tool = toolFacts.get(toolUseId);
				if (!tool) return;
				await this.recordFact(file, command.executionId, {
					kind: "tool",
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
			for (const [toolUseId, tool] of toolFacts) {
				await this.recordFact(file, command.executionId, {
					kind: "tool",
					operationRef: tool.operationRef,
					attemptRef: tool.attemptRef,
					phase: "unknown",
					finishedAt: new Date().toISOString(),
					...(tool.startedAt === undefined
						? {}
						: { durationMs: Math.max(0, Date.now() - tool.startedAt) }),
					failureCode: "recovery_unconfirmed",
					toolId: tool.toolId,
				});
				toolFacts.delete(toolUseId);
			}
		};
		let native: ReturnType<typeof claudeQuery>;
		try {
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
					},
					settingSources: [],
					...claudeWorkspaceTools(
						workspace,
						join(directory, "memory"),
						onResultFile,
						toolOperations,
					),
					strictMcpConfig: true,
					mcpServers: {
						...(standardMcpServer ? { connection: standardMcpServer } : {}),
						...(browserMcpServer ? { browser: browserMcpServer } : {}),
					},
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
						content,
					},
				},
			);
		} catch {
			if (standardMcp) await standardMcp.close().catch(() => {});
			browserAbortController.abort();
			await transport.close();
			return result(command, ref, unknownResult);
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
						const name = nativeToolName.startsWith("mcp__connection__")
							? nativeToolName.slice("mcp__connection__".length)
							: nativeToolName;
						if (
							!["Read", "Write", "Edit"].includes(name) &&
							!name.startsWith("mcp_")
						)
							unavailable();
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
			const directory = await this.discoverNativeCommands(nativeRead);
			return projectNativeMetadataCommandsV1({
				nativeSessionRef: read.nativeSessionRef,
				configVersion: this.options.configVersion,
				source: {
					name: "Claude",
					version: CLAUDE_NATIVE_PROVENANCE.nativeVersion,
				},
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
		return parseClaudeNativeCommands(commands);
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
			turn.events.push(
				RuntimeEventV1Schema.parse({
					schemaVersion: 1,
					executionId: command.executionId,
					adapterEventKey: randomUUID(),
					cursor: `claude-${state.sequence}`,
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
		for (const wake of this.waiters.get(session.ref) ?? []) wake();
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
