import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	RuntimeDriverCommandV1,
	RuntimeDriverSubmitTurnCommandV2,
	RuntimeGenerationCancelRequestV1,
	RuntimeStopRequestV1,
	RuntimeSubmitTurnRequestV1,
	RuntimeSubmitTurnRequestV2,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	CODEX_APP_SERVER_V2_PROVENANCE,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
	type CodexModelAccess,
} from "./codex-app-server-bridge.js";
import type {
	CodexModelTurnAdmission,
	CodexNativeTurn,
} from "./codex-model-transport.js";
import {
	CodexRuntimeDriver,
	type CodexRuntimeDriverOptions,
} from "./codex-runtime-driver.js";
import { openCodexRuntimeDriverForTest } from "./codex-runtime-driver.test-support.js";
import { DurableJsonFile } from "./durable-json.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import {
	ingressVerifiedRuntimeHost,
	runtimeGrantFixture,
} from "./grant-fixture.test-support.js";
import { RuntimeHost } from "./runtime-host.js";

type CancelTurnTestHook = (
	turn: CodexNativeTurn,
	cancel: () => Promise<void>,
) => Promise<void>;

type RegisterTurnTestHook = (
	turn: CodexNativeTurn,
	deadline: number | undefined,
	register: () => boolean,
) => boolean;

class ObservableCleanupPromise extends Promise<void> {
	static override get [Symbol.species]() {
		return Promise;
	}

	constructor(
		executor: (
			resolve: (value?: void | PromiseLike<void>) => void,
			reject: (reason?: unknown) => void,
		) => void,
		private readonly onConsumed: () => void,
	) {
		super(executor);
	}

	// biome-ignore lint/suspicious/noThenProperty: Await consumption is the behavior under test.
	override then<TResult1 = void, TResult2 = never>(
		// biome-ignore lint/suspicious/noConfusingVoidType: This overrides the native Promise signature.
		onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		this.onConsumed();
		return super.then(onfulfilled, onrejected);
	}
}

const modelTransportTestHooks = vi.hoisted(() => ({
	cancelTurn: undefined as CancelTurnTestHook | undefined,
	registerTurn: undefined as RegisterTurnTestHook | undefined,
}));

vi.mock("./codex-model-transport.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./codex-model-transport.js")>();
	return {
		...actual,
		openCodexModelTransport: async (
			...args: Parameters<typeof actual.openCodexModelTransport>
		) => {
			const transport = await actual.openCodexModelTransport(...args);
			const deadlines = new WeakMap<CodexModelTurnAdmission, number>();
			return {
				...transport,
				beginTurnAdmission: (deadline: number, internalModel: string) => {
					const admission = transport.beginTurnAdmission(
						deadline,
						internalModel,
					);
					deadlines.set(admission, deadline);
					return admission;
				},
				registerTurn: (
					admission: CodexModelTurnAdmission,
					turn: CodexNativeTurn,
				) =>
					modelTransportTestHooks.registerTurn?.(
						turn,
						deadlines.get(admission),
						() => transport.registerTurn(admission, turn),
					) ?? transport.registerTurn(admission, turn),
				cancelTurn: (turn: CodexNativeTurn) =>
					modelTransportTestHooks.cancelTurn?.(turn, () =>
						transport.cancelTurn(turn),
					) ?? transport.cancelTurn(turn),
			};
		},
	};
});

const directories: string[] = [];
const drivers: CodexRuntimeDriver[] = [];
const servers: Server[] = [];

type CodexTurnStatus = "inProgress" | "completed" | "failed" | "interrupted";

interface TestItemsListPage {
	data: {
		turnId: string;
		item: { id: string; type: string; text?: string };
	}[];
	nextCursor?: string | null;
}

interface StoredEventJournal {
	events: Record<string, unknown>[];
}

interface StoredCodexExecution {
	status?: unknown;
}

interface StoredCodexOperation {
	internalModel?: string;
	state?: unknown;
	nativeSessionRef?: string;
	configVersion?: unknown;
	admissionPending?: unknown;
	record?: {
		result?: { outcome?: unknown; status?: unknown };
	};
}

interface StoredCodexSession {
	acceptanceUncertainOperationKey?: string;
	eventSequence?: number;
	journals?: Record<string, StoredEventJournal>;
	executions?: Record<string, StoredCodexExecution>;
}

interface StoredCodexDriverState {
	sessions: Record<string, StoredCodexSession>;
	operations: Record<string, StoredCodexOperation>;
}

async function persistedExecutionStatus(
	path: string,
	nativeSessionRef: string,
	executionId: string,
) {
	const state = JSON.parse(
		await readFile(path, "utf8"),
	) as StoredCodexDriverState;
	return state.sessions[nativeSessionRef]?.executions?.[executionId]?.status;
}

// Narrow fixtures copied from the generated schema pinned by the Bridge provenance.
const pinnedV2EventRecoveryFrames = {
	threadStarted: {
		method: "turn/started",
		params: {
			threadId: "codex-native-thread-private",
			turn: {
				id: "codex-native-turn-private",
				status: "inProgress",
				items: [],
			},
		},
	},
	agentMessageDelta: {
		method: "item/agentMessage/delta",
		params: {
			threadId: "codex-native-thread-private",
			turnId: "codex-native-turn-private",
			itemId: "codex-native-item-private",
			delta: "schema-delta",
		},
	},
	turnCompleted: {
		method: "turn/completed",
		params: {
			threadId: "codex-native-thread-private",
			turn: {
				id: "codex-native-turn-private",
				status: "completed",
				items: [],
			},
		},
	},
	threadItemsListRequest: {
		threadId: "codex-native-thread-private",
		turnId: "codex-native-turn-private",
		limit: 100,
		sortDirection: "asc",
	},
	threadItemsListResponse: {
		data: [
			{
				turnId: "codex-native-turn-private",
				item: {
					id: "codex-native-item-private",
					type: "agentMessage",
					text: "schema-history",
				},
			},
		],
		nextCursor: null,
	},
};

async function runtimeDirectory() {
	const directory = await mkdtemp(
		join(tmpdir(), "agent-runtime-codex-driver-"),
	);
	directories.push(directory);
	return directory;
}

function submitRequest(): RuntimeSubmitTurnRequestV1 {
	const binding = {
		agentId: "agent-codex",
		actorId: "actor-codex",
		channelId: "web",
		conversationId: "conversation-codex",
		executionId: "execution-codex",
		turnId: "turn-codex",
		sessionGeneration: 1,
		traceId: "trace-codex",
	};
	return {
		schemaVersion: 1,
		requestId: "request-codex",
		...binding,
		deliveryFence: 1,
		grant: runtimeGrantFixture(binding, ["turn.submit"]),
		input: { text: "synthetic-input", attachments: [] },
	};
}

function submitRequestV2(
	overrides: Partial<RuntimeSubmitTurnRequestV2> = {},
): RuntimeSubmitTurnRequestV2 {
	return {
		...submitRequest(),
		schemaVersion: 2,
		selection: {
			schemaVersion: 1,
			modelOptionId: "model-option-primary",
			reasoningLevel: "high",
		},
		...overrides,
	};
}

function submitCommand(
	overrides: Partial<
		Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>
	> = {},
): Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }> {
	return {
		schemaVersion: 1,
		kind: "submit-turn",
		operationId: "execution-codex",
		agentId: "agent-codex",
		conversationId: "conversation-codex",
		executionId: "execution-codex",
		turnId: "turn-codex",
		sessionGeneration: 1,
		input: { text: "synthetic-input", attachments: [] },
		...overrides,
	};
}

function submitCommandV2(
	overrides: Partial<RuntimeDriverSubmitTurnCommandV2> = {},
): RuntimeDriverSubmitTurnCommandV2 {
	return {
		...submitCommand(),
		schemaVersion: 2,
		selection: {
			schemaVersion: 1,
			modelOptionId: "model-option-primary",
			reasoningLevel: "high",
		},
		...overrides,
	};
}

function stopCommand(
	nativeSessionRef: string,
): Extract<RuntimeDriverCommandV1, { kind: "stop" }> {
	return {
		schemaVersion: 1,
		kind: "stop",
		operationId: "stop-codex",
		agentId: "agent-codex",
		conversationId: "conversation-codex",
		executionId: "execution-codex",
		turnId: "turn-codex",
		sessionGeneration: 1,
		nativeSessionRef,
	};
}

function generationCancelCommand(
	nativeSessionRef: string,
): Extract<RuntimeDriverCommandV1, { kind: "generation-cancel" }> {
	return {
		...stopCommand(nativeSessionRef),
		kind: "generation-cancel",
		operationId: "generation-cancel-codex",
	};
}

function stopRequest(
	request: RuntimeSubmitTurnRequestV1,
	hostSessionRef: string,
	overrides: Partial<RuntimeStopRequestV1> = {},
): RuntimeStopRequestV1 {
	const binding = {
		agentId: request.agentId,
		actorId: request.actorId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
	};
	return {
		schemaVersion: 1,
		requestId: "request-codex-stop",
		...binding,
		deliveryFence: 1,
		executionDeliveryFence: 1,
		hostSessionRef,
		stopRequestId: "stop-codex",
		grant: runtimeGrantFixture(binding, ["turn.stop"]),
		...overrides,
	};
}

function generationCancelRequest(
	request: RuntimeSubmitTurnRequestV1,
	hostSessionRef: string,
	overrides: Partial<RuntimeGenerationCancelRequestV1> = {},
): RuntimeGenerationCancelRequestV1 {
	const binding = {
		agentId: request.agentId,
		actorId: request.actorId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
	};
	return {
		schemaVersion: 1,
		requestId: "request-codex-generation-cancel",
		...binding,
		deliveryFence: 1,
		hostSessionRef,
		tombstoneId: "generation-codex",
		grant: runtimeGrantFixture(binding, ["generation.cancel"]),
		...overrides,
	};
}

function driverOptions(path: string, configVersion = "synthetic-config-1") {
	return {
		path,
		configVersion,
		defaultModelOptionId: "model-option-primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "model-option-primary",
				model: "gpt-5.3-codex",
				reasoningLevels: ["high"],
			},
			{
				modelOptionId: "model-option-alternate",
				model: "gpt-5.2-codex",
				reasoningLevels: ["low"],
			},
		],
	};
}

function internalModel(modelOptionId: string, model: string) {
	return `${createHash("sha256").update(modelOptionId).digest("hex")}/${model}`;
}

function openDriver(
	path: string,
	bridge: TestCodexBridge,
	onOpen?: (options: CodexAppServerBridgeOptions) => void,
	configVersion?: string,
) {
	return openCodexRuntimeDriverForTest(
		driverOptions(path, configVersion),
		async (options) => {
			onOpen?.(options);
			return bridge;
		},
	);
}

function configReadResult(
	overrides: {
		config?: Record<string, unknown>;
		origins?: Record<string, unknown>;
	} = {},
) {
	return {
		config: {
			model: "gpt-5.3-codex",
			model_reasoning_effort: "high",
			mcp_servers: {},
			plugins: {},
			marketplaces: {},
			features: { plugins: false },
			...overrides.config,
		},
		origins: {
			model: { name: { type: "sessionFlags" }, version: "1" },
			model_reasoning_effort: { name: { type: "sessionFlags" }, version: "1" },
			"features.plugins": {
				name: { type: "sessionFlags" },
				version: "1",
			},
			...overrides.origins,
		},
	};
}

const upstreamModelAccess = {
	endpoint: "http://127.0.0.1:8080/approved/v1",
	credential: "synthetic-active-credential",
};

function sessionFlagOrigin() {
	return { name: { type: "sessionFlags" }, version: "1" };
}

function modelAccessConfigReadResult(
	modelAccess: CodexModelAccess,
	model = internalModel("model-option-primary", "gpt-5.3-codex"),
	reasoningEffort = "high",
) {
	const configuredProvider = {
		name: "Agent Infra Active Model",
		base_url: modelAccess.endpoint,
		env_key: "AGENT_INFRA_CODEX_MODEL_CREDENTIAL",
		wire_api: "responses",
		requires_openai_auth: false,
		supports_websockets: false,
		request_max_retries: 0,
		stream_max_retries: 0,
	};
	const provider = {
		...configuredProvider,
		env_key_instructions: null,
		experimental_bearer_token: null,
		auth: null,
		aws: null,
		query_params: null,
		http_headers: null,
		env_http_headers: null,
		stream_idle_timeout_ms: null,
		websocket_connect_timeout_ms: null,
		supports_standalone_web_search: false,
	};
	return configReadResult({
		config: {
			model,
			model_reasoning_effort: reasoningEffort,
			model_provider: "agent_infra",
			model_providers: { agent_infra: provider },
		},
		origins: {
			model_provider: sessionFlagOrigin(),
			...Object.fromEntries(
				Object.keys(configuredProvider).map((key) => [
					`model_providers.agent_infra.${key}`,
					sessionFlagOrigin(),
				]),
			),
		},
	});
}

function openDriverWithModelAccess(
	path: string,
	bridge: TestCodexBridge,
	onOpen?: (options: CodexAppServerBridgeOptions) => void,
) {
	return openCodexRuntimeDriverForTest(
		{
			...driverOptions(path),
			modelOptions: driverOptions(path).modelOptions.map((option) => ({
				...option,
				...upstreamModelAccess,
			})),
		},
		async (options) => {
			if (!options.modelAccess) throw new Error("missing loopback access");
			bridge.setConfigReadResult(
				modelAccessConfigReadResult(options.modelAccess),
			);
			onOpen?.(options);
			return bridge;
		},
	);
}

function openDriverWithModelEndpoint(
	path: string,
	bridge: TestCodexBridge,
	endpoint: string,
	onOpen?: (options: CodexAppServerBridgeOptions) => void,
	configVersion?: string,
	credential = upstreamModelAccess.credential,
) {
	return openCodexRuntimeDriverForTest(
		{
			...driverOptions(path, configVersion),
			modelOptions: driverOptions(path).modelOptions.map((option) => ({
				...option,
				endpoint,
				credential,
			})),
		},
		async (options) => {
			if (!options.modelAccess) throw new Error("missing loopback access");
			bridge.setConfigReadResult(
				modelAccessConfigReadResult(options.modelAccess),
			);
			onOpen?.(options);
			return bridge;
		},
	);
}

async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("missing address");
	return `http://127.0.0.1:${address.port}/v1`;
}

function modelRequest(
	modelAccess: CodexModelAccess,
	bridge: TestCodexBridge,
	nativeTurnId = bridge.nativeTurnId,
	model = internalModel("model-option-primary", "gpt-5.3-codex"),
) {
	return fetch(`${modelAccess.endpoint}/responses`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${modelAccess.credential}`,
			"x-client-request-id": bridge.nativeThreadId,
			"x-codex-turn-metadata": JSON.stringify({
				thread_id: bridge.nativeThreadId,
				turn_id: nativeTurnId,
			}),
		},
		body: JSON.stringify({
			model,
			stream: true,
		}),
	});
}

function completedEvent() {
	return `data: ${JSON.stringify({
		type: "response.completed",
		response: { id: "response-synthetic", status: "completed" },
	})}\n\n`;
}

class TestCodexBridge {
	readonly requests: { method: string; params: unknown }[] = [];
	readonly responses: CodexAppServerFrame[] = [];

	private readonly queuedFrames: CodexAppServerFrame[] = [];
	private readonly heldTurnsListRequestIds: number[] = [];
	private readonly heldTurnStartRequestIds: number[] = [];
	private wake?: () => void;
	private notificationRead?: () => void;
	private closed = false;
	private turnStatus: CodexTurnStatus = "inProgress";
	private holdTurnStartResponses = false;
	private holdTurnsListResponses = false;
	private holdTurnsListSend = false;
	private turnsListResult?: unknown;
	private turnsListError?: { code: number; message: string };
	private nextTurnsListError?: { code: number; message: string };
	private itemsListPages?: TestItemsListPage[];
	private turnStartCount = 0;
	private duplicateNextNativeTurnId = false;
	private dropThreadStartResponse = false;
	private dropThreadResumeResponse = false;
	private terminalStatusOnThreadResume?: Exclude<CodexTurnStatus, "inProgress">;
	private dropInterruptResponse = false;
	private nextTurnStartError?: { code: number; message: string };
	private interruptTerminalStatus?: Exclude<CodexTurnStatus, "inProgress">;
	private configReadResult: Record<string, unknown> = configReadResult();

	constructor(
		readonly nativeThreadId = "codex-native-thread-private",
		readonly nativeTurnId = "codex-native-turn-private",
		private readonly closeOnTurnStart = false,
	) {}

	async send(frame: CodexAppServerFrame) {
		const { id, method, params } = frame;
		if (
			(typeof id === "string" ||
				(typeof id === "number" && Number.isSafeInteger(id))) &&
			!("method" in frame) &&
			"error" in frame
		) {
			this.responses.push(frame);
			return;
		}
		if (
			typeof id !== "number" ||
			!Number.isSafeInteger(id) ||
			typeof method !== "string"
		) {
			throw new Error("Expected a Codex JSON-RPC request");
		}
		this.requests.push({ method, params });
		if (method === "initialize") {
			this.respond(id, {});
			return;
		}
		if (method === "config/read") {
			this.respond(id, this.configReadResult);
			return;
		}
		if (method === "model/list") {
			this.respond(id, {
				data: [
					{
						model: "gpt-5.3-codex",
						supportedReasoningEfforts: [
							{ reasoningEffort: "high", description: "Synthetic high" },
						],
					},
					{
						model: "gpt-5.2-codex",
						supportedReasoningEfforts: [
							{ reasoningEffort: "low", description: "Synthetic low" },
						],
					},
				],
				nextCursor: null,
			});
			return;
		}
		if (method === "thread/start") {
			if (this.dropThreadStartResponse) {
				await this.close();
				return;
			}
			this.respond(id, { thread: { id: this.nativeThreadId } });
			return;
		}
		if (method === "thread/resume") {
			if (this.dropThreadResumeResponse) {
				await this.close();
				return;
			}
			if (this.terminalStatusOnThreadResume) {
				const status = this.terminalStatusOnThreadResume;
				this.terminalStatusOnThreadResume = undefined;
				this.push({
					method: "turn/completed",
					params: {
						threadId: this.nativeThreadId,
						turn: { id: this.nativeTurnId, status, items: [] },
					},
				});
			}
			this.respond(id, { thread: { id: this.nativeThreadId } });
			return;
		}
		if (method === "thread/turns/list") {
			if (this.holdTurnsListSend) return new Promise<void>(() => {});
			if (this.holdTurnsListResponses) {
				this.heldTurnsListRequestIds.push(id);
				return;
			}
			this.respondTurnsList(id);
			return;
		}
		if (method === "thread/items/list") {
			this.respondItemsList(id);
			return;
		}
		if (method === "turn/start") {
			if (this.nextTurnStartError) {
				const error = this.nextTurnStartError;
				this.nextTurnStartError = undefined;
				this.push({
					id,
					error,
				});
				return;
			}
			if (this.closeOnTurnStart) {
				await this.close();
				return;
			}
			if (this.holdTurnStartResponses) {
				this.heldTurnStartRequestIds.push(id);
				return;
			}
			const nativeTurnId = this.nextNativeTurnId();
			this.respond(id, {
				turn: { id: nativeTurnId, status: "inProgress" },
			});
			this.push({
				method: "turn/started",
				params: {
					threadId: this.nativeThreadId,
					turn: { id: nativeTurnId, status: "inProgress", items: [] },
				},
			});
			return;
		}
		if (method === "turn/interrupt") {
			if (this.interruptTerminalStatus) {
				this.turnStatus = this.interruptTerminalStatus;
			}
			if (this.dropInterruptResponse) {
				this.dropInterruptResponse = false;
				await this.close();
				return;
			}
			this.respond(id, {});
			return;
		}
		throw new Error(`Unexpected Codex JSON-RPC method: ${method}`);
	}

	setTurnStatus(status: CodexTurnStatus) {
		this.turnStatus = status;
	}

	setTurnsListResult(result: unknown) {
		this.turnsListResult = structuredClone(result);
		this.turnsListError = undefined;
	}

	setTurnsListError(error: { code: number; message: string }) {
		this.turnsListError = { ...error };
		this.turnsListResult = undefined;
	}

	rejectNextTurnsList(error: { code: number; message: string }) {
		this.nextTurnsListError = { ...error };
	}

	setConfigReadResult(result: Record<string, unknown>) {
		this.configReadResult = structuredClone(result);
	}

	setItemsListPages(pages: TestItemsListPage[]) {
		this.itemsListPages = structuredClone(pages);
	}

	duplicateNextTurnResponse() {
		this.duplicateNextNativeTurnId = true;
	}

	continueAfterPersistedTurn() {
		this.turnStartCount = 1;
	}

	dropNextThreadStartResponse() {
		this.dropThreadStartResponse = true;
	}

	dropNextThreadResumeResponse() {
		this.dropThreadResumeResponse = true;
	}

	completeOnThreadResume(status: Exclude<CodexTurnStatus, "inProgress">) {
		this.terminalStatusOnThreadResume = status;
	}

	dropNextInterruptResponse() {
		this.dropInterruptResponse = true;
	}

	rejectNextSelectedTurn(
		error = {
			code: -32_600,
			message: "invalid thread settings override: synthetic selection",
		},
	) {
		this.nextTurnStartError = error;
	}

	completeOnInterrupt(status: Exclude<CodexTurnStatus, "inProgress">) {
		this.interruptTerminalStatus = status;
	}

	holdTurnsList() {
		this.holdTurnsListResponses = true;
	}

	holdTurnStart() {
		this.holdTurnStartResponses = true;
	}

	pendingTurnStartCount() {
		return this.heldTurnStartRequestIds.length;
	}

	respondToHeldTurnStart(status: CodexTurnStatus = "inProgress") {
		const id = this.heldTurnStartRequestIds.shift();
		if (id === undefined) throw new Error("No held turn-start request");
		this.respond(id, {
			turn: { id: this.nextNativeTurnId(), status },
		});
	}

	holdTurnsListRequestSend() {
		this.holdTurnsListSend = true;
	}

	pendingTurnsListCount() {
		return this.heldTurnsListRequestIds.length;
	}

	isClosed() {
		return this.closed;
	}

	respondToHeldTurnsList(kind: "error" | "missing-result") {
		const id = this.heldTurnsListRequestIds.shift();
		if (id === undefined) throw new Error("No held thread/turns/list request");
		if (kind === "error") {
			this.push({
				id,
				error: { code: -32_000, message: "synthetic protocol error" },
			});
			return;
		}
		this.push({ id });
	}

	respondToHeldTurnsListWithError(
		error: { code: number; message: string },
		index = 0,
	) {
		const id = this.heldTurnsListRequestIds.splice(index, 1)[0];
		if (id === undefined) throw new Error("No held thread/turns/list request");
		this.push({ id, error: { ...error } });
	}

	respondToHeldTurnsListWithStatus(status: CodexTurnStatus, index = 0) {
		const id = this.heldTurnsListRequestIds.splice(index, 1)[0];
		if (id === undefined) throw new Error("No held thread/turns/list request");
		this.respond(id, {
			data: [{ id: this.nativeTurnId, status, items: [] }],
		});
	}

	respondToHeldTurnsListWithInvalidData(index = 0) {
		const id = this.heldTurnsListRequestIds.splice(index, 1)[0];
		if (id === undefined) throw new Error("No held thread/turns/list request");
		this.respond(id, { data: "invalid" });
	}

	emitNotification(status: CodexTurnStatus = "inProgress") {
		return new Promise<void>((resolve) => {
			this.notificationRead = resolve;
			this.push({
				method: "turn/started",
				params: {
					threadId: this.nativeThreadId,
					turn: {
						id: this.nativeTurnId,
						status,
						items: [],
					},
				},
			});
		});
	}

	emitServerRequest(method: string, params: Record<string, unknown>) {
		this.push({
			id: "native-tool-request-private",
			method,
			params,
		});
	}

	emitAgentMessageDelta(delta: string) {
		return new Promise<void>((resolve) => {
			this.notificationRead = resolve;
			this.push({
				method: "item/agentMessage/delta",
				params: {
					threadId: this.nativeThreadId,
					turnId: this.nativeTurnId,
					itemId: "codex-native-item-private",
					delta,
				},
			});
		});
	}

	emitTurnCompleted(status: Exclude<CodexTurnStatus, "inProgress">) {
		return new Promise<void>((resolve) => {
			this.notificationRead = resolve;
			this.push({
				method: "turn/completed",
				params: {
					threadId: this.nativeThreadId,
					turn: {
						id: this.nativeTurnId,
						status,
						items: [],
					},
				},
			});
		});
	}

	emitFrame(frame: CodexAppServerFrame) {
		return new Promise<void>((resolve) => {
			this.notificationRead = resolve;
			this.push(frame);
		});
	}

	frames(): AsyncIterable<CodexAppServerFrame> {
		const bridge = this;
		return (async function* () {
			while (true) {
				const frame = await bridge.nextFrame();
				if (!frame) return;
				yield frame;
			}
		})();
	}

	async close() {
		this.closed = true;
		const wake = this.wake;
		this.wake = undefined;
		wake?.();
	}

	private respond(id: number, result: unknown) {
		this.push({ id, result });
	}

	private respondTurnsList(id: number) {
		if (this.nextTurnsListError) {
			const error = this.nextTurnsListError;
			this.nextTurnsListError = undefined;
			this.push({ id, error });
			return;
		}
		if (this.turnsListError) {
			this.push({ id, error: this.turnsListError });
			return;
		}
		this.respond(
			id,
			this.turnsListResult ?? {
				data: [{ id: this.nativeTurnId, status: this.turnStatus, items: [] }],
			},
		);
	}

	private respondItemsList(id: number) {
		const page = this.itemsListPages?.shift() ?? { data: [] };
		this.respond(id, {
			data: page.data.map((entry) => structuredClone(entry)),
			...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
		});
	}

	private nextNativeTurnId() {
		const nativeTurnId = this.duplicateNextNativeTurnId
			? this.nativeTurnId
			: this.turnStartCount === 0
				? this.nativeTurnId
				: `${this.nativeTurnId}-${this.turnStartCount + 1}`;
		this.duplicateNextNativeTurnId = false;
		this.turnStartCount += 1;
		return nativeTurnId;
	}

	private push(frame: CodexAppServerFrame) {
		this.queuedFrames.push(frame);
		const wake = this.wake;
		this.wake = undefined;
		wake?.();
	}

	private async nextFrame() {
		while (true) {
			const frame = this.queuedFrames.shift();
			if (frame) {
				const notificationRead = this.notificationRead;
				this.notificationRead = undefined;
				notificationRead?.();
				return frame;
			}
			if (this.closed) return undefined;
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	modelTransportTestHooks.cancelTurn = undefined;
	modelTransportTestHooks.registerTurn = undefined;
	await Promise.all(drivers.splice(0).map((driver) => driver.close()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true })),
	);
});

describe("Codex Runtime Driver", () => {
	it("replaces upstream access with loopback access and revokes it on Driver close", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const bridge = new TestCodexBridge();
		let loopback: CodexModelAccess | undefined;
		const driver = await openDriverWithModelAccess(path, bridge, (options) => {
			loopback = options.modelAccess;
		});
		if (!loopback) throw new Error("missing loopback access");
		expect(loopback.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(loopback.credential).not.toBe(upstreamModelAccess.credential);
		expect(await readFile(path, "utf8")).not.toContain(
			upstreamModelAccess.credential,
		);
		expect(await readFile(path, "utf8")).not.toContain(loopback.credential);
		const beforeClose = await fetch(`${loopback.endpoint}/arbitrary`, {
			method: "POST",
			headers: { authorization: `Bearer ${loopback.credential}` },
			body: "{}",
		});
		expect(beforeClose.status).toBe(404);
		await driver.close();
		await expect(
			fetch(`${loopback.endpoint}/responses`, {
				method: "POST",
				headers: { authorization: `Bearer ${loopback.credential}` },
				body: "{}",
			}),
		).rejects.toThrow();
	});

	it("fails closed when Codex reports a different model provider configuration", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		let loopback: CodexModelAccess | undefined;
		await expect(
			openDriverWithModelAccess(
				join(directory, "driver.json"),
				bridge,
				(options) => {
					if (!options.modelAccess) throw new Error("missing loopback access");
					loopback = options.modelAccess;
					const result = modelAccessConfigReadResult(options.modelAccess);
					const providers = (
						result.config as typeof result.config & {
							model_providers: Record<string, Record<string, unknown>>;
						}
					).model_providers;
					const provider = providers.agent_infra as
						| Record<string, unknown>
						| undefined;
					if (!provider) throw new Error("missing model provider fixture");
					provider.base_url = "http://127.0.0.1:1";
					bridge.setConfigReadResult(result);
				},
			),
		).rejects.toMatchObject({
			code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
		});
		if (!loopback) throw new Error("missing captured loopback access");
		await expect(
			fetch(`${loopback.endpoint}/responses`, {
				method: "POST",
				headers: { authorization: `Bearer ${loopback.credential}` },
				body: "{}",
			}),
		).rejects.toThrow();
	});

	it.each([
		["missing model metadata", "unverified-model", "high"],
		["unsupported reasoning profile", "gpt-5.3-codex", "ultra"],
	] as const)(
		"rejects routed configuration with %s",
		async (_name, model, reasoningLevel) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			await expect(
				openCodexRuntimeDriverForTest(
					{
						path: join(directory, "driver.json"),
						configVersion: "synthetic-config-1",
						defaultModelOptionId: "model-option-primary",
						defaultReasoningLevel: reasoningLevel,
						modelOptions: [
							{
								modelOptionId: "model-option-primary",
								model,
								reasoningLevels: [reasoningLevel],
								...upstreamModelAccess,
							},
						],
					},
					async (options) => {
						if (!options.modelAccess)
							throw new Error("missing loopback access");
						bridge.setConfigReadResult(
							modelAccessConfigReadResult(
								options.modelAccess,
								internalModel("model-option-primary", model),
								reasoningLevel,
							),
						);
						return bridge;
					},
				),
			).rejects.toMatchObject({
				code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
			});
		},
	);

	it("keeps duplicate real models distinct when one conversation changes option", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const options: CodexRuntimeDriverOptions = {
			path: join(directory, "driver.json"),
			configVersion: "synthetic-config-1",
			defaultModelOptionId: "model-option-primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "model-option-primary",
					model: "gpt-5.3-codex",
					reasoningLevels: ["high"],
					endpoint: "http://127.0.0.1:8080/one/v1",
					credential: "synthetic-credential-one",
				},
				{
					modelOptionId: "model-option-alternate",
					model: "gpt-5.3-codex",
					reasoningLevels: ["high"],
					endpoint: "http://127.0.0.1:8080/two/v1",
					credential: "synthetic-credential-two",
				},
			],
		};
		const driver = await openCodexRuntimeDriverForTest(
			options,
			async (bridgeOptions) => {
				if (!bridgeOptions.modelAccess)
					throw new Error("missing loopback access");
				bridge.setConfigReadResult(
					modelAccessConfigReadResult(bridgeOptions.modelAccess),
				);
				return bridge;
			},
		);
		drivers.push(driver);
		const first = await driver.execute(submitCommandV2());
		bridge.setTurnStatus("completed");
		await driver.getStatus(first.nativeSessionRef, "execution-codex");

		await driver.execute(
			submitCommandV2({
				operationId: "execution-codex-alternate",
				executionId: "execution-codex-alternate",
				turnId: "turn-codex-alternate",
				nativeSessionRef: first.nativeSessionRef,
				selection: {
					schemaVersion: 1,
					modelOptionId: "model-option-alternate",
					reasoningLevel: "high",
				},
			}),
		);

		expect(
			bridge.requests
				.filter(({ method }) => method === "turn/start")
				.map(({ params }) => (params as { model?: unknown }).model),
		).toEqual([
			internalModel("model-option-primary", "gpt-5.3-codex"),
			internalModel("model-option-alternate", "gpt-5.3-codex"),
		]);
	});

	it.each([undefined, null, 123])(
		"redacts an invalid deployment path %s before launch",
		async (path) => {
			await expect(
				CodexRuntimeDriver.open(driverOptions(path as unknown as string)),
			).rejects.toMatchObject({
				code: "RUNTIME_CODEX_STATE_INVALID",
				message: "Codex Runtime session state is unavailable",
			});
		},
	);

	it.each([
		["missing options", undefined],
		["empty options", []],
		[
			"missing default model",
			[
				{
					modelOptionId: "model-option-alternate",
					model: "gpt-5.2-codex",
					reasoningLevels: ["low"],
				},
			],
		],
		[
			"missing default reasoning",
			[
				{
					modelOptionId: "model-option-primary",
					model: "gpt-5.3-codex",
					reasoningLevels: ["low"],
				},
			],
		],
	] as const)(
		"rejects %s before opening Codex",
		async (_name, modelOptions) => {
			const directory = await runtimeDirectory();
			const options = {
				...driverOptions(join(directory, "driver.json")),
				modelOptions,
			} as unknown as CodexRuntimeDriverOptions;
			let opened = false;

			await expect(
				openCodexRuntimeDriverForTest(options, async () => {
					opened = true;
					return new TestCodexBridge();
				}),
			).rejects.toMatchObject({
				code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
				message: "Codex Runtime configuration is unavailable",
			});
			expect(opened).toBe(false);
		},
	);

	it("initializes one bounded Codex Session and Turn without leaking native references", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		let openedWith: CodexAppServerBridgeOptions | undefined;
		const driver = await openDriver(
			join(directory, "driver.json"),
			bridge,
			(options) => {
				openedWith = options;
			},
		);
		drivers.push(driver);
		const runtimeHost = ingressVerifiedRuntimeHost(
			await RuntimeHost.open({
				store: await FileRuntimeStore.open(join(directory, "host.json")),
				driver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			}),
		);
		const request = submitRequest();

		const response = await runtimeHost.submitTurn(request);

		expect(openedWith).toEqual({
			model: "gpt-5.3-codex",
			reasoningEffort: "high",
			provenance: CODEX_APP_SERVER_V2_PROVENANCE,
			dataDirectory: `${join(directory, "driver.json")}.native`,
		});
		expect(bridge.requests.map(({ method }) => method)).toEqual([
			"initialize",
			"config/read",
			"thread/start",
			"turn/start",
			"thread/turns/list",
		]);
		expect(bridge.requests[1]?.params).toEqual({ includeLayers: false });
		expect(bridge.requests[2]?.params).toEqual({ historyMode: "paginated" });
		expect(bridge.requests[4]?.params).toEqual({
			threadId: bridge.nativeThreadId,
			itemsView: "notLoaded",
			limit: 100,
		});
		expect(response).toMatchObject({
			operationId: request.executionId,
			result: { outcome: "accepted", status: "running" },
		});
		expect(response.hostSessionRef).not.toBe(bridge.nativeThreadId);
		expect(JSON.stringify(response)).not.toContain(bridge.nativeThreadId);
		expect(JSON.stringify(response)).not.toContain(bridge.nativeTurnId);
		expect(await driver.getCapabilities()).toMatchObject({
			modelSelection: true,
			connection: false,
		});
	});

	it("maps V2 selection at turn/start while preserving opaque Host output", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const runtimeHost = ingressVerifiedRuntimeHost(
			await RuntimeHost.open({
				store: await FileRuntimeStore.open(join(directory, "host.json")),
				driver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			}),
		);
		const request = submitRequestV2();

		const response = await runtimeHost.submitTurnV2(request);

		expect(
			bridge.requests.find(({ method }) => method === "turn/start")?.params,
		).toEqual({
			threadId: bridge.nativeThreadId,
			clientUserMessageId: request.executionId,
			input: [{ type: "text", text: "synthetic-input" }],
			model: "gpt-5.3-codex",
			effort: "high",
		});
		expect(response).toMatchObject({
			schemaVersion: 2,
			result: { outcome: "accepted" },
		});
		expect(JSON.stringify(response)).not.toMatch(
			/native|provider|credential|protocol/i,
		);
	});

	it("rejects an unsupported V2 selection before starting a native Turn", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);

		const result = await driver.execute(
			submitCommandV2({
				selection: {
					schemaVersion: 1,
					modelOptionId: "model-option-unsupported",
					reasoningLevel: "high",
				},
			}),
		);

		expect(result.result).toEqual({
			outcome: "rejected",
			code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
			message: "Runtime model selection is unsupported",
			retryable: false,
		});
		expect(bridge.requests.map(({ method }) => method)).toEqual([
			"initialize",
			"config/read",
		]);
		expect(JSON.stringify(result)).not.toContain("gpt-5.3-codex");
	});

	it("replays an unsupported selection after a crash immediately following its first durable write", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const bridge = new TestCodexBridge();
		const driver = await openDriver(path, bridge);
		drivers.push(driver);
		const command = submitCommandV2({
			selection: {
				schemaVersion: 1,
				modelOptionId: "model-option-unsupported",
				reasoningLevel: "high",
			},
		});
		const originalUpdate = DurableJsonFile.prototype.update;
		const crash = vi
			.spyOn(DurableJsonFile.prototype, "update")
			.mockImplementationOnce(function (
				this: DurableJsonFile<unknown>,
				change,
			) {
				return originalUpdate.call(this, change).then(() => {
					throw new Error("simulated process loss after persist");
				});
			});
		await expect(driver.execute(command)).rejects.toThrow();
		crash.mockRestore();
		await driver.close();
		const persisted = JSON.parse(
			await readFile(path, "utf8"),
		) as StoredCodexDriverState;
		expect(Object.values(persisted.operations)).toEqual([
			expect.objectContaining({
				state: "resolved",
				record: expect.objectContaining({
					result: expect.objectContaining({
						outcome: "rejected",
						code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
					}),
				}),
			}),
		]);
		expect(bridge.requests.map(({ method }) => method)).toEqual([
			"initialize",
			"config/read",
		]);
		const recoveredBridge = new TestCodexBridge();
		const recovered = await openDriver(path, recoveredBridge);
		drivers.push(recovered);
		const before = recoveredBridge.requests.length;
		const replay = await recovered.execute(command);
		expect(replay.result).toMatchObject({
			outcome: "rejected",
			code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
		});
		expect(await recovered.lookupOperation(command)).toEqual({
			state: "found",
			record: replay,
		});
		expect(recoveredBridge.requests.slice(before)).toEqual([]);
	});

	it("resets a legacy V1 Turn to configured defaults after a V2 override", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const selected = await driver.execute(
			submitCommandV2({
				selection: {
					schemaVersion: 1,
					modelOptionId: "model-option-alternate",
					reasoningLevel: "low",
				},
			}),
		);
		bridge.setTurnStatus("completed");
		await driver.getStatus(selected.nativeSessionRef, "execution-codex");

		await driver.execute(
			submitCommand({
				operationId: "execution-codex-v1-after-v2",
				executionId: "execution-codex-v1-after-v2",
				turnId: "turn-codex-v1-after-v2",
				nativeSessionRef: selected.nativeSessionRef,
			}),
		);

		expect(
			bridge.requests
				.filter(({ method }) => method === "turn/start")
				.map(({ params }) => params),
		).toEqual([
			{
				threadId: bridge.nativeThreadId,
				clientUserMessageId: "execution-codex",
				input: [{ type: "text", text: "synthetic-input" }],
				model: "gpt-5.2-codex",
				effort: "low",
			},
			{
				threadId: bridge.nativeThreadId,
				clientUserMessageId: "execution-codex-v1-after-v2",
				input: [{ type: "text", text: "synthetic-input" }],
				model: "gpt-5.3-codex",
				effort: "high",
			},
		]);
	});

	it("persists a redacted unsupported result for a native V2 refusal", async () => {
		const directory = await runtimeDirectory();
		const driverPath = join(directory, "driver.json");
		const bridge = new TestCodexBridge();
		bridge.rejectNextSelectedTurn();
		const driver = await openDriver(driverPath, bridge);
		drivers.push(driver);
		const runtimeHost = ingressVerifiedRuntimeHost(
			await RuntimeHost.open({
				store: await FileRuntimeStore.open(join(directory, "host.json")),
				driver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			}),
		);
		const request = submitRequestV2();

		const rejected = await runtimeHost.submitTurnV2(request);
		expect(rejected.result).toEqual({
			outcome: "rejected",
			code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
			message: "Runtime model selection is unsupported",
			retryable: false,
		});
		expect(
			await runtimeHost.submitTurnV2({
				...request,
				requestId: "request-codex-native-refusal-replay",
			}),
		).toEqual(rejected);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
		const state = await readFile(driverPath, "utf8");
		expect(state).not.toContain("acceptanceUncertainOperationKey");
		expect(JSON.stringify(rejected)).not.toContain(
			"invalid thread settings override",
		);
	});

	it.each([
		[-32_600, "other native request failure"],
		[-32_602, "invalid thread settings override: generic invalid params"],
		[-32_603, "invalid thread settings override: internal failure"],
		[-32_001, "invalid thread settings override: overloaded"],
	] as const)(
		"keeps non-selection JSON-RPC error %i on the uncertain path",
		async (code, message) => {
			const directory = await runtimeDirectory();
			const driverPath = join(directory, "driver.json");
			const bridge = new TestCodexBridge();
			bridge.rejectNextSelectedTurn({ code, message });
			const driver = await openDriver(driverPath, bridge);
			drivers.push(driver);

			await expect(driver.execute(submitCommandV2())).rejects.toMatchObject({
				code: "RUNTIME_CODEX_PROTOCOL_INVALID",
			});
			const state = await readFile(driverPath, "utf8");
			expect(state).toContain("acceptanceUncertainOperationKey");
			expect(state).not.toContain(message);
		},
	);

	it.each(["stop", "generation-cancel"] as const)(
		"keeps %s pending until exact model Turn cleanup completes",
		async (kind) => {
			const directory = await runtimeDirectory();
			const driverPath = join(directory, "driver.json");
			const bridge = new TestCodexBridge();
			bridge.completeOnInterrupt("interrupted");
			let releaseCleanup: (() => void) | undefined;
			let cleanupStarted: (() => void) | undefined;
			const cleanupGate = new Promise<void>((resolve) => {
				releaseCleanup = resolve;
			});
			const cleanupStartedPromise = new Promise<void>((resolve) => {
				cleanupStarted = resolve;
			});
			const cleanupCalls: { consumed: boolean; turn: CodexNativeTurn }[] = [];
			modelTransportTestHooks.cancelTurn = (turn, cancel) => {
				const call = { consumed: false, turn };
				cleanupCalls.push(call);
				if (cleanupCalls.length > 1) return cancel();
				const completion = cancel().then(() => {
					cleanupStarted?.();
					return cleanupGate;
				});
				return new ObservableCleanupPromise(
					(resolve, reject) => {
						void completion.then(resolve, reject);
					},
					() => {
						call.consumed = true;
					},
				);
			};
			const driver = await openDriverWithModelAccess(driverPath, bridge);
			drivers.push(driver);
			const submitted = await driver.execute(submitCommand());
			const command =
				kind === "stop"
					? stopCommand(submitted.nativeSessionRef)
					: generationCancelCommand(submitted.nativeSessionRef);
			const interruption = driver.execute(command);
			void interruption.catch(() => {});
			let settled = false;
			void interruption.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);

			await cleanupStartedPromise;
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
			try {
				expect(settled).toBe(false);
				expect(cleanupCalls).toEqual([
					{
						consumed: true,
						turn: {
							threadId: bridge.nativeThreadId,
							turnId: bridge.nativeTurnId,
						},
					},
				]);
				const pendingState = JSON.parse(
					await readFile(driverPath, "utf8"),
				) as StoredCodexDriverState;
				const operationKey = JSON.stringify([
					command.agentId,
					command.conversationId,
					command.sessionGeneration,
					command.kind,
					command.operationId,
				]);
				expect(pendingState.operations[operationKey]).toMatchObject({
					state: "prepared",
				});
				expect(pendingState.operations[operationKey]?.record).toBeUndefined();
			} finally {
				releaseCleanup?.();
			}

			await expect(interruption).resolves.toMatchObject({
				result: { outcome: "accepted", status: "cancelled" },
			});
			const resolvedState = JSON.parse(
				await readFile(driverPath, "utf8"),
			) as StoredCodexDriverState;
			const operationKey = JSON.stringify([
				command.agentId,
				command.conversationId,
				command.sessionGeneration,
				command.kind,
				command.operationId,
			]);
			expect(resolvedState.operations[operationKey]).toMatchObject({
				state: "resolved",
				record: {
					result: { outcome: "accepted", status: "cancelled" },
				},
			});
		},
	);

	it.each(["stop", "generation-cancel"] as const)(
		"closes the exact silent upstream during bounded %s handling",
		async (kind) => {
			const directory = await runtimeDirectory();
			let upstreamClosed: (() => void) | undefined;
			let upstreamContacted: (() => void) | undefined;
			const upstreamClosedPromise = new Promise<void>((resolve) => {
				upstreamClosed = resolve;
			});
			const upstreamContactedPromise = new Promise<void>((resolve) => {
				upstreamContacted = resolve;
			});
			const endpoint = await listen(
				createServer((_request, response) => {
					upstreamContacted?.();
					response.once("close", () => upstreamClosed?.());
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.write('data: {"type":"response.created","response":{}}\n\n');
				}),
			);
			const bridge = new TestCodexBridge();
			let loopback: CodexModelAccess | undefined;
			const driver = await openDriverWithModelEndpoint(
				join(directory, "driver.json"),
				bridge,
				endpoint,
				(options) => {
					loopback = options.modelAccess;
				},
			);
			drivers.push(driver);
			const submitted = await driver.execute(submitCommand());
			if (!loopback) throw new Error("missing loopback access");
			const response = await modelRequest(loopback, bridge);
			await upstreamContactedPromise;
			bridge.completeOnInterrupt("interrupted");

			const command =
				kind === "stop"
					? stopCommand(submitted.nativeSessionRef)
					: generationCancelCommand(submitted.nativeSessionRef);
			await expect(driver.execute(command)).resolves.toMatchObject({
				result: { outcome: "accepted", status: "cancelled" },
			});
			await expect(upstreamClosedPromise).resolves.toBeUndefined();
			expect(
				bridge.requests.filter(({ method }) => method === "turn/interrupt"),
			).toHaveLength(1);
			await response.body?.cancel().catch(() => {});
		},
	);

	it("waits for a recognized native Turn then admits its delayed start response", async () => {
		const directory = await runtimeDirectory();
		let upstreamCalls = 0;
		const endpoint = await listen(
			createServer((_request, response) => {
				upstreamCalls += 1;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		let loopback: CodexModelAccess | undefined;
		const driver = await openDriverWithModelEndpoint(
			join(directory, "driver.json"),
			bridge,
			endpoint,
			(options) => {
				loopback = options.modelAccess;
			},
		);
		drivers.push(driver);
		const submission = driver.execute(submitCommand());
		void submission.catch(() => {});
		await vi.waitFor(() => expect(bridge.pendingTurnStartCount()).toBe(1));
		await bridge.emitNotification();
		if (!loopback) throw new Error("missing loopback access");
		let modelSettled = false;
		const pendingModel = modelRequest(loopback, bridge).then((response) => {
			modelSettled = true;
			return response;
		});

		try {
			await new Promise<void>((resolve) => setTimeout(resolve, 2_100));
			expect(modelSettled).toBe(false);
			expect(upstreamCalls).toBe(0);
			bridge.respondToHeldTurnStart();
			const response = await pendingModel;
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(completedEvent());
			expect(upstreamCalls).toBe(1);
		} finally {
			if (bridge.pendingTurnStartCount() > 0) bridge.respondToHeldTurnStart();
			await submission;
		}
	});

	it("keeps a start response without a recognized notification unavailable", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		let upstreamCalls = 0;
		const endpoint = await listen(
			createServer((_request, response) => {
				upstreamCalls += 1;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const command = submitCommand();
		const bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		let loopback: CodexModelAccess | undefined;
		const driver = await openDriverWithModelEndpoint(
			path,
			bridge,
			endpoint,
			(options) => {
				loopback = options.modelAccess;
			},
		);
		drivers.push(driver);
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const submission = driver.execute(command);
		void submission.catch(() => {});
		await vi.waitFor(() => expect(bridge.pendingTurnStartCount()).toBe(1));
		if (!loopback) throw new Error("missing loopback access");
		const pendingModel = modelRequest(loopback, bridge).then(
			(response) => response.status,
			() => "closed" as const,
		);
		bridge.respondToHeldTurnStart();
		await vi.waitFor(async () => {
			const stored = JSON.parse(await readFile(path, "utf8")) as {
				operations: Record<string, StoredCodexOperation>;
			};
			expect(Object.values(stored.operations)).toContainEqual(
				expect.objectContaining({ admissionPending: true }),
			);
		});
		await vi.advanceTimersByTimeAsync(30_000);

		await expect(submission).rejects.toMatchObject({
			code: "RUNTIME_CODEX_UNAVAILABLE",
		});
		expect(await pendingModel).not.toBe(200);
		expect(upstreamCalls).toBe(0);
		const stored = JSON.parse(await readFile(path, "utf8")) as {
			operations: Record<string, StoredCodexOperation>;
		};
		expect(Object.values(stored.operations)).toContainEqual(
			expect.objectContaining({
				state: "resolved",
				admissionPending: true,
			}),
		);
		expect(await driver.lookupOperation(command)).toEqual({ state: "unknown" });
	});

	it("confirms a terminal result persisted after start recognition but before model registration", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		let upstreamCalls = 0;
		const endpoint = await listen(
			createServer((_request, response) => {
				upstreamCalls += 1;
				response.end();
			}),
		);
		const bridge = new TestCodexBridge();
		const driver = await openDriverWithModelEndpoint(path, bridge, endpoint);
		drivers.push(driver);
		const recognition = driver as unknown as {
			waitForNativeTurnStarted(
				threadId: string,
				turnId: string,
				deadline: number,
			): Promise<boolean>;
		};
		let terminalCancelled = false;
		modelTransportTestHooks.cancelTurn = async (_turn, cancel) => {
			await cancel();
			terminalCancelled = true;
		};
		const waitForStarted = recognition.waitForNativeTurnStarted.bind(driver);
		vi.spyOn(recognition, "waitForNativeTurnStarted").mockImplementationOnce(
			async (...args) => {
				const recognized = await waitForStarted(...args);
				expect(recognized).toBe(true);
				await bridge.emitTurnCompleted("completed");
				await vi.waitFor(() => expect(terminalCancelled).toBe(true));
				return recognized;
			},
		);
		let registered: boolean | undefined;
		modelTransportTestHooks.registerTurn = (_turn, _deadline, register) => {
			registered = register();
			return registered;
		};
		const command = submitCommand();
		const accepted = await driver.execute(command);
		expect(registered).toBe(false);
		expect(accepted.result).toEqual({
			outcome: "accepted",
			status: "completed",
		});
		expect(await driver.lookupOperation(command)).toMatchObject({
			state: "found",
		});
		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("completed");
		expect(
			await driver.replayEvents(accepted.nativeSessionRef, command.executionId),
		).toContainEqual(expect.objectContaining({ type: "completed" }));
		const stored = JSON.parse(await readFile(path, "utf8")) as {
			operations: Record<string, StoredCodexOperation>;
		};
		expect(
			Object.values(stored.operations).every(
				(operation) => operation.admissionPending === undefined,
			),
		).toBe(true);
		expect(upstreamCalls).toBe(0);
		await driver.close();
		const recovered = await openDriverWithModelEndpoint(
			path,
			new TestCodexBridge(),
			endpoint,
		);
		drivers.push(recovered);
		expect((await recovered.execute(command)).result).toEqual(accepted.result);
		expect(
			await recovered.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("completed");
	});

	it("keeps an expired durable model admission unavailable after restart", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		let upstreamCalls = 0;
		const endpoint = await listen(
			createServer((_request, response) => {
				upstreamCalls += 1;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const now = vi.spyOn(Date, "now");
		let observedDeadline: number | undefined;
		modelTransportTestHooks.registerTurn = (_turn, deadline, register) => {
			if (deadline === undefined) throw new Error("missing admission deadline");
			observedDeadline = deadline;
			now.mockReturnValue(deadline);
			return register();
		};
		const command = submitCommand();
		const bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		let loopback: CodexModelAccess | undefined;
		const driver = await openDriverWithModelEndpoint(
			path,
			bridge,
			endpoint,
			(options) => {
				loopback = options.modelAccess;
			},
		);
		drivers.push(driver);
		const submission = driver.execute(command);
		void submission.catch(() => {});
		await vi.waitFor(() => expect(bridge.pendingTurnStartCount()).toBe(1));
		await bridge.emitNotification();
		if (!loopback) throw new Error("missing loopback access");
		const pendingModel = modelRequest(loopback, bridge).then(
			(response) => response.status,
			() => "closed" as const,
		);
		bridge.respondToHeldTurnStart();

		await expect(submission).rejects.toMatchObject({
			code: "RUNTIME_CODEX_UNAVAILABLE",
		});
		expect(observedDeadline).toEqual(expect.any(Number));
		expect(await pendingModel).not.toBe(200);
		expect(upstreamCalls).toBe(0);
		const stored = JSON.parse(await readFile(path, "utf8")) as {
			sessions: Record<string, StoredCodexSession>;
			operations: Record<string, StoredCodexOperation>;
		};
		expect(Object.values(stored.operations)).toContainEqual(
			expect.objectContaining({
				state: "resolved",
				admissionPending: true,
			}),
		);
		expect(await driver.lookupOperation(command)).toEqual({ state: "unknown" });
		const nativeSessionRef = Object.keys(stored.sessions)[0];
		if (!nativeSessionRef) throw new Error("missing native Session");
		await expect(
			driver.getStatus(nativeSessionRef, command.executionId),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });

		await driver.close();
		modelTransportTestHooks.registerTurn = undefined;
		now.mockRestore();
		const recoveredBridge = new TestCodexBridge();
		const recovered = await openDriverWithModelEndpoint(
			path,
			recoveredBridge,
			endpoint,
		);
		drivers.push(recovered);
		const beforeRecovery = recoveredBridge.requests.length;
		await expect(
			recovered.replayEvents(nativeSessionRef, command.executionId),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		await expect(
			recovered.subscribeEvents(nativeSessionRef, command.executionId),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		expect(
			recoveredBridge.requests
				.slice(beforeRecovery)
				.filter(({ method }) =>
					["thread/resume", "thread/turns/list", "thread/items/list"].includes(
						method,
					),
				),
		).toHaveLength(0);

		await expect(recovered.execute(command)).rejects.toMatchObject({
			code: "RUNTIME_CODEX_UNAVAILABLE",
		});
		expect(await recovered.lookupOperation(command)).toEqual({
			state: "unknown",
		});
		await expect(
			recovered.getStatus(nativeSessionRef, command.executionId),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		expect(upstreamCalls).toBe(0);
	});

	it("expires model admission while durable update acknowledgement is held", async () => {
		const directory = await runtimeDirectory();
		let upstreamCalls = 0;
		const endpoint = await listen(
			createServer((_request, response) => {
				upstreamCalls += 1;
				response.end();
			}),
		);
		let releasePersistence: (() => void) | undefined;
		const persistenceReleased = new Promise<void>((resolve) => {
			releasePersistence = resolve;
		});
		let admissionPersisted: (() => void) | undefined;
		const admissionPersistedPromise = new Promise<void>((resolve) => {
			admissionPersisted = resolve;
		});
		let held = false;
		const originalUpdate = DurableJsonFile.prototype.update;
		vi.spyOn(DurableJsonFile.prototype, "update").mockImplementation(function (
			this: DurableJsonFile<unknown>,
			change,
		) {
			return originalUpdate.call(this, change).then(async (result) => {
				const state = this.read() as {
					operations?: Record<string, { admissionPending?: unknown }>;
				};
				if (
					!held &&
					Object.values(state.operations ?? {}).some(
						(operation) => operation.admissionPending === true,
					)
				) {
					held = true;
					admissionPersisted?.();
					await persistenceReleased;
				}
				return result;
			});
		});
		const bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		let loopback: CodexModelAccess | undefined;
		const driver = await openDriverWithModelEndpoint(
			join(directory, "driver.json"),
			bridge,
			endpoint,
			(options) => {
				loopback = options.modelAccess;
			},
		);
		drivers.push(driver);
		vi.useFakeTimers();
		const submission = driver.execute(submitCommand());
		void submission.catch(() => {});
		await vi.waitFor(() => expect(bridge.pendingTurnStartCount()).toBe(1));
		await bridge.emitNotification();
		if (!loopback) throw new Error("missing loopback access");
		const pendingModel = modelRequest(loopback, bridge).then(
			(response) => response.status,
			() => "closed" as const,
		);
		bridge.respondToHeldTurnStart();
		await admissionPersistedPromise;

		try {
			await vi.advanceTimersByTimeAsync(30_000);
			expect(await pendingModel).not.toBe(200);
			expect(upstreamCalls).toBe(0);
			let submissionSettled = false;
			void submission.then(
				() => {
					submissionSettled = true;
				},
				() => {
					submissionSettled = true;
				},
			);
			await Promise.resolve();
			expect(submissionSettled).toBe(false);
		} finally {
			releasePersistence?.();
		}
		await expect(submission).rejects.toMatchObject({
			code: "RUNTIME_CODEX_UNAVAILABLE",
		});
		expect(upstreamCalls).toBe(0);
	});

	it("does not admit a Turn completed before its start response is resolved", async () => {
		const directory = await runtimeDirectory();
		let upstreamCalls = 0;
		const endpoint = await listen(
			createServer((_request, response) => {
				upstreamCalls += 1;
				response.end();
			}),
		);
		const bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		let loopback: CodexModelAccess | undefined;
		const driver = await openDriverWithModelEndpoint(
			join(directory, "driver.json"),
			bridge,
			endpoint,
			(options) => {
				loopback = options.modelAccess;
			},
		);
		drivers.push(driver);
		const submission = driver.execute(submitCommand());
		await vi.waitFor(() => expect(bridge.pendingTurnStartCount()).toBe(1));
		await bridge.emitNotification();
		if (!loopback) throw new Error("missing loopback access");
		const pendingModel = modelRequest(loopback, bridge).then(
			(response) => response.status,
			() => "closed" as const,
		);
		await bridge.emitTurnCompleted("completed");
		bridge.respondToHeldTurnStart();

		await expect(submission).resolves.toMatchObject({
			result: { outcome: "accepted", status: "completed" },
		});
		expect(await pendingModel).not.toBe(200);
		expect(upstreamCalls).toBe(0);
	});

	it.each([
		["terminal status", "codex-native-turn-private", "completed"],
		["conflicting Turn ID", "codex-native-turn-conflicting", "inProgress"],
	] as const)(
		"does not admit a model request from a %s start notification",
		async (_name, notifiedTurnId, status) => {
			const directory = await runtimeDirectory();
			let upstreamCalls = 0;
			const endpoint = await listen(
				createServer((_request, response) => {
					upstreamCalls += 1;
					response.end();
				}),
			);
			const bridge = new TestCodexBridge();
			bridge.holdTurnStart();
			let loopback: CodexModelAccess | undefined;
			const driver = await openDriverWithModelEndpoint(
				join(directory, "driver.json"),
				bridge,
				endpoint,
				(options) => {
					loopback = options.modelAccess;
				},
			);
			drivers.push(driver);
			const submission = driver.execute(submitCommand());
			void submission.catch(() => {});
			await vi.waitFor(() => expect(bridge.pendingTurnStartCount()).toBe(1));
			if (!loopback) throw new Error("missing loopback access");
			const pendingModel = modelRequest(loopback, bridge, notifiedTurnId).then(
				(response) => response.status,
				() => "closed" as const,
			);
			await bridge.emitFrame({
				method: "turn/started",
				params: {
					threadId: bridge.nativeThreadId,
					turn: { id: notifiedTurnId, status, items: [] },
				},
			});
			if (status === "inProgress") bridge.respondToHeldTurnStart();

			await expect(submission).rejects.toBeDefined();
			expect(await pendingModel).not.toBe(200);
			expect(upstreamCalls).toBe(0);
		},
	);

	it("closes a silent upstream when cancellation finds the native Turn terminal", async () => {
		const directory = await runtimeDirectory();
		let upstreamClosed: (() => void) | undefined;
		const upstreamClosedPromise = new Promise<void>((resolve) => {
			upstreamClosed = resolve;
		});
		const endpoint = await listen(
			createServer((_request, response) => {
				response.once("close", () => upstreamClosed?.());
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write('data: {"type":"response.created","response":{}}\n\n');
			}),
		);
		const bridge = new TestCodexBridge();
		let loopback: CodexModelAccess | undefined;
		const driver = await openDriverWithModelEndpoint(
			join(directory, "driver.json"),
			bridge,
			endpoint,
			(options) => {
				loopback = options.modelAccess;
			},
		);
		drivers.push(driver);
		const submitted = await driver.execute(submitCommand());
		if (!loopback) throw new Error("missing loopback access");
		const response = await modelRequest(loopback, bridge);
		bridge.setTurnStatus("interrupted");

		await expect(
			driver.execute(stopCommand(submitted.nativeSessionRef)),
		).resolves.toMatchObject({
			result: { outcome: "accepted", status: "cancelled" },
		});
		await expect(upstreamClosedPromise).resolves.toBeUndefined();
		expect(
			bridge.requests.filter(({ method }) => method === "turn/interrupt"),
		).toHaveLength(0);
		await response.body?.cancel().catch(() => {});
	});

	it("closes a recovered terminal Turn before lookup confirms cancellation", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		let upstreamCalls = 0;
		const endpoint = await listen(
			createServer((_request, response) => {
				upstreamCalls += 1;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriverWithModelEndpoint(
			path,
			firstBridge,
			endpoint,
		);
		drivers.push(firstDriver);
		const submitted = await firstDriver.execute(submitCommand());
		const command = stopCommand(submitted.nativeSessionRef);
		firstBridge.dropNextInterruptResponse();
		await expect(firstDriver.execute(command)).rejects.toMatchObject({
			code: "RUNTIME_CODEX_UNAVAILABLE",
		});
		await firstDriver.close();

		const recoveredBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		recoveredBridge.setTurnStatus("interrupted");
		recoveredBridge.holdTurnsList();
		let loopback: CodexModelAccess | undefined;
		const recoveredDriver = await openDriverWithModelEndpoint(
			path,
			recoveredBridge,
			endpoint,
			(options) => {
				loopback = options.modelAccess;
			},
		);
		drivers.push(recoveredDriver);
		if (!loopback) throw new Error("missing loopback access");
		const responsePromise = modelRequest(loopback, recoveredBridge);
		void responsePromise.catch(() => {});
		const lookup = recoveredDriver.lookupOperation(command);
		await vi.waitFor(() =>
			expect(recoveredBridge.pendingTurnsListCount()).toBe(1),
		);
		const response = await responsePromise;
		expect(response.status).toBe(409);
		expect(upstreamCalls).toBe(0);
		recoveredBridge.respondToHeldTurnsListWithStatus("interrupted");

		await expect(lookup).resolves.toMatchObject({
			state: "found",
			record: { result: { outcome: "accepted", status: "cancelled" } },
		});
		expect(upstreamCalls).toBe(0);
		expect(
			recoveredBridge.requests.filter(
				({ method }) => method === "turn/interrupt",
			),
		).toHaveLength(0);
		await response.body?.cancel().catch(() => {});
	});

	it("waits for a durable terminal Turn before confirming generation cancellation", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const runtimeHost = ingressVerifiedRuntimeHost(
			await RuntimeHost.open({
				store: await FileRuntimeStore.open(join(directory, "host.json")),
				driver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			}),
		);
		const request = submitRequest();
		const submitted = await runtimeHost.submitTurn(request);
		const cancellation = generationCancelRequest(
			request,
			submitted.hostSessionRef,
		);

		expect((await runtimeHost.cancelGeneration(cancellation)).result).toEqual({
			outcome: "accepted",
			status: "running",
		});
		expect(
			bridge.requests.filter(({ method }) => method === "turn/interrupt"),
		).toHaveLength(1);

		bridge.setTurnStatus("interrupted");
		expect(
			(
				await runtimeHost.cancelGeneration({
					...cancellation,
					requestId: "request-codex-generation-cancel-retry",
					deliveryFence: 2,
				})
			).result,
		).toEqual({ outcome: "accepted", status: "cancelled" });
		expect(
			bridge.requests.filter(({ method }) => method === "turn/interrupt"),
		).toHaveLength(1);
	});

	it("fails closed while keeping a generation barrier active for an invalid cancellation retry", async () => {
		const directory = await runtimeDirectory();
		const hostPath = join(directory, "host.json");
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const runtimeHost = ingressVerifiedRuntimeHost(
			await RuntimeHost.open({
				store: await FileRuntimeStore.open(hostPath),
				driver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			}),
		);
		const request = submitRequest();
		const submitted = await runtimeHost.submitTurn(request);
		const cancellation = generationCancelRequest(
			request,
			submitted.hostSessionRef,
		);

		expect((await runtimeHost.cancelGeneration(cancellation)).result).toEqual({
			outcome: "accepted",
			status: "running",
		});
		bridge.holdTurnsList();
		const retry = runtimeHost.cancelGeneration({
			...cancellation,
			requestId: "request-codex-generation-cancel-retry-failure",
			deliveryFence: 2,
		});
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(1));
		bridge.respondToHeldTurnsList("error");

		await expect(retry).rejects.toMatchObject({
			code: "RUNTIME_DRIVER_INVALID",
		});
		const state = JSON.parse(await readFile(hostPath, "utf8")) as {
			sessions: Record<string, { generationBarrier?: { state: string } }>;
		};
		expect(
			state.sessions[submitted.hostSessionRef]?.generationBarrier?.state,
		).toBe("active");
		expect(
			bridge.requests.filter(({ method }) => method === "turn/interrupt"),
		).toHaveLength(1);
	});

	it("recovers the actual completion after an interrupted stop response without replaying it", async () => {
		const directory = await runtimeDirectory();
		const hostPath = join(directory, "host.json");
		const driverPath = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		firstBridge.completeOnInterrupt("completed");
		firstBridge.dropNextInterruptResponse();
		const firstDriver = await openDriver(driverPath, firstBridge);
		drivers.push(firstDriver);
		const firstHost = ingressVerifiedRuntimeHost(
			await RuntimeHost.open({
				store: await FileRuntimeStore.open(hostPath),
				driver: firstDriver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			}),
		);
		const request = submitRequest();
		const submitted = await firstHost.submitTurn(request);
		const stop = stopRequest(request, submitted.hostSessionRef);

		expect((await firstHost.stop(stop)).result).toEqual({
			outcome: "unknown",
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			message: "Runtime command acceptance could not be confirmed",
		});
		expect(
			firstBridge.requests.filter(({ method }) => method === "turn/interrupt"),
		).toHaveLength(1);

		const recoveredBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		const recoveredDriver = await openDriver(driverPath, recoveredBridge);
		drivers.push(recoveredDriver);
		const recoveredHost = ingressVerifiedRuntimeHost(
			await RuntimeHost.open({
				store: await FileRuntimeStore.open(hostPath),
				driver: recoveredDriver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			}),
		);
		recoveredBridge.setTurnStatus("completed");

		expect(
			(
				await recoveredHost.stop({
					...stop,
					requestId: "request-codex-stop-retry",
					deliveryFence: 2,
				})
			).result,
		).toEqual({ outcome: "accepted", status: "completed" });
		expect(
			recoveredBridge.requests.filter(
				({ method }) => method === "turn/interrupt",
			),
		).toHaveLength(0);
	});

	it("coalesces concurrent stop resolution from execution and lookup", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.completeOnInterrupt("completed");
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const submitted = await driver.execute(submitCommand());
		const command = stopCommand(submitted.nativeSessionRef);

		bridge.holdTurnsList();
		const execution = driver.execute(command);
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(1));
		const lookup = driver.lookupOperation(command);
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(2));

		bridge.respondToHeldTurnsListWithStatus("inProgress", 0);
		await vi.waitFor(() =>
			expect(
				bridge.requests.filter(({ method }) => method === "turn/interrupt"),
			).toHaveLength(1),
		);
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(2));

		bridge.respondToHeldTurnsListWithStatus("completed", 0);
		await expect(lookup).resolves.toMatchObject({
			state: "found",
			record: { result: { outcome: "accepted", status: "completed" } },
		});
		bridge.respondToHeldTurnsListWithStatus("completed");
		await expect(execution).resolves.toMatchObject({
			result: { outcome: "accepted", status: "completed" },
		});
	});

	it("accepts the scalar features.plugins session flag origin", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();

		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);

		expect(bridge.isClosed()).toBe(false);
	});

	it.each([
		[
			"MCP server",
			configReadResult({
				config: { mcp_servers: { inherited: { opaque: "private" } } },
				origins: {
					"mcp_servers.inherited": {
						name: { type: "system" },
						version: "1",
					},
				},
			}),
		],
		[
			"plugin",
			configReadResult({
				config: { plugins: { inherited: { opaque: "private" } } },
				origins: {
					"plugins.inherited": {
						name: { type: "enterpriseManaged" },
						version: "1",
					},
				},
			}),
		],
		[
			"plugin marketplace",
			configReadResult({
				config: { marketplaces: { inherited: { opaque: "private" } } },
			}),
		],
		[
			"plugin feature",
			configReadResult({ config: { features: { plugins: true } } }),
		],
		[
			"model override",
			configReadResult({ config: { model: "unapproved-model" } }),
		],
		[
			"non-session origin",
			configReadResult({
				origins: {
					model: { name: { type: "mdm" }, version: "1" },
				},
			}),
		],
	] as const)(
		"fails closed for an inherited %s configuration without persisting it",
		async (_name, configuration) => {
			const directory = await runtimeDirectory();
			const path = join(directory, "driver.json");
			const bridge = new TestCodexBridge();
			bridge.setConfigReadResult(configuration);

			const error = await openDriver(path, bridge).catch(
				(value: unknown) => value,
			);
			expect(error).toMatchObject({
				code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
				message: "Codex Runtime configuration is unavailable",
			});
			expect(JSON.stringify(error)).not.toContain("private");
			expect(bridge.requests).toEqual([
				{
					method: "initialize",
					params: {
						clientInfo: { name: "agent-infra-runtime", version: "1" },
						capabilities: { experimentalApi: true },
					},
				},
				{ method: "config/read", params: { includeLayers: false } },
			]);
			expect(await readFile(path, "utf8")).not.toContain("private");
			expect(bridge.isClosed()).toBe(true);
		},
	);

	it.each(["model", "model_reasoning_effort", "features.plugins"] as const)(
		"fails closed when the required %s configuration origin is absent",
		async (originKey) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			const configuration = configReadResult();
			delete configuration.origins[originKey];
			bridge.setConfigReadResult(configuration);

			await expect(
				openDriver(join(directory, "driver.json"), bridge),
			).rejects.toMatchObject({
				code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
			});
			expect(bridge.isClosed()).toBe(true);
		},
	);

	it.each(["model", "model_reasoning_effort", "features.plugins"] as const)(
		"fails closed when the required %s configuration origin is not a session flag",
		async (originKey) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			bridge.setConfigReadResult(
				configReadResult({
					origins: {
						[originKey]: { name: { type: "system" }, version: "1" },
					},
				}),
			);

			await expect(
				openDriver(join(directory, "driver.json"), bridge),
			).rejects.toMatchObject({
				code: "RUNTIME_CODEX_CONFIGURATION_INVALID",
			});
			expect(bridge.isClosed()).toBe(true);
		},
	);

	it.each([
		["missing config", { origins: {} }, "RUNTIME_CODEX_PROTOCOL_INVALID"],
		[
			"unexpected layers",
			{ ...configReadResult(), layers: [] },
			"RUNTIME_CODEX_PROTOCOL_INVALID",
		],
		[
			"malformed origin",
			configReadResult({
				origins: { model: { name: "invalid", version: "1" } },
			}),
			"RUNTIME_CODEX_PROTOCOL_INVALID",
		],
	] as const)(
		"fails closed for a pinned config/read response with %s",
		async (_name, configuration, code) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			bridge.setConfigReadResult(configuration);

			await expect(
				openDriver(join(directory, "driver.json"), bridge),
			).rejects.toMatchObject({ code });
			expect(bridge.isClosed()).toBe(true);
		},
	);

	it("resumes the persisted Codex Session without starting a replacement", async () => {
		const directory = await runtimeDirectory();
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(
			join(directory, "driver.json"),
			firstBridge,
		);
		drivers.push(firstDriver);
		const command = submitCommand();
		const firstResult = await firstDriver.execute(command);
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		resumedBridge.setTurnStatus("completed");
		const resumedDriver = await openDriver(
			join(directory, "driver.json"),
			resumedBridge,
		);
		drivers.push(resumedDriver);

		expect(
			await resumedDriver.getStatus(
				firstResult.nativeSessionRef,
				command.executionId,
			),
		).toBe("completed");
		expect(resumedBridge.requests.map(({ method }) => method)).toEqual([
			"initialize",
			"config/read",
			"thread/resume",
			"thread/turns/list",
		]);
		expect(resumedBridge.requests[2]?.params).toEqual({
			threadId: firstBridge.nativeThreadId,
			excludeTurns: true,
		});
		expect(resumedBridge.requests[3]?.params).toEqual({
			threadId: firstBridge.nativeThreadId,
			itemsView: "notLoaded",
			limit: 100,
		});
		resumedBridge.continueAfterPersistedTurn();
		expect(
			(
				await resumedDriver.execute(
					submitCommand({
						operationId: "execution-codex-after-completion",
						executionId: "execution-codex-after-completion",
						turnId: "turn-codex-after-completion",
						nativeSessionRef: firstResult.nativeSessionRef,
					}),
				)
			).result,
		).toEqual({ outcome: "accepted", status: "running" });
	});

	it("fails closed before recovering a running Turn under a different configuration revision", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		let firstUpstreamCalls = 0;
		const firstEndpoint = await listen(
			createServer((_request, response) => {
				firstUpstreamCalls += 1;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		let replacementUpstreamCalls = 0;
		const replacementEndpoint = await listen(
			createServer((_request, response) => {
				replacementUpstreamCalls += 1;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriverWithModelEndpoint(
			path,
			firstBridge,
			firstEndpoint,
			undefined,
			"configuration-a",
			"synthetic-credential-a",
		);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstDriver.close();

		const recoveredBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		const recoveredDriver = await openDriverWithModelEndpoint(
			path,
			recoveredBridge,
			replacementEndpoint,
			undefined,
			"configuration-b",
			"synthetic-credential-b",
		);
		drivers.push(recoveredDriver);
		const beforeRecovery = recoveredBridge.requests.length;

		await expect(
			recoveredDriver.getStatus(accepted.nativeSessionRef, command.executionId),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		await expect(
			recoveredDriver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		await expect(
			recoveredDriver.execute(stopCommand(accepted.nativeSessionRef)),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		await expect(
			recoveredDriver.execute(
				submitCommand({
					operationId: "execution-codex-new-config",
					executionId: "execution-codex-new-config",
					turnId: "turn-codex-new-config",
					nativeSessionRef: accepted.nativeSessionRef,
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		expect(recoveredBridge.requests.slice(beforeRecovery)).toEqual([]);
		expect(replacementUpstreamCalls).toBe(0);
		await recoveredDriver.close();

		const independentBridge = new TestCodexBridge(
			"codex-native-thread-new-configuration",
			"codex-native-turn-new-configuration",
		);
		let loopback: CodexModelAccess | undefined;
		const independentDriver = await openDriverWithModelEndpoint(
			path,
			independentBridge,
			replacementEndpoint,
			(options) => {
				loopback = options.modelAccess;
			},
			"configuration-b",
			"synthetic-credential-b",
		);
		drivers.push(independentDriver);
		const independent = await independentDriver.execute(
			submitCommand({
				operationId: "execution-codex-independent",
				executionId: "execution-codex-independent",
				turnId: "turn-codex-independent",
				conversationId: "conversation-codex-independent",
			}),
		);
		expect(independent.result).toEqual({
			outcome: "accepted",
			status: "running",
		});
		if (!loopback) throw new Error("missing loopback access");
		expect(await modelRequest(loopback, independentBridge)).toMatchObject({
			status: 200,
		});
		expect(firstUpstreamCalls).toBe(0);
		expect(replacementUpstreamCalls).toBe(1);
	});

	it.each([
		"missing-config",
		"changed-config",
		"missing-model",
		"unconfigured-model",
	] as const)(
		"does not replay cached running acceptance with %s",
		async (mutation) => {
			const directory = await runtimeDirectory();
			const path = join(directory, "driver.json");
			const firstBridge = new TestCodexBridge();
			const first = await openDriver(
				path,
				firstBridge,
				undefined,
				"configuration-a",
			);
			drivers.push(first);
			const command = submitCommand();
			await first.execute(command);
			await first.close();
			const state = JSON.parse(
				await readFile(path, "utf8"),
			) as StoredCodexDriverState;
			const operation = Object.values(state.operations)[0];
			if (!operation) throw new Error("missing operation");
			if (mutation === "missing-config") delete operation.configVersion;
			if (mutation === "missing-model") delete operation.internalModel;
			if (mutation === "unconfigured-model")
				operation.internalModel = "unconfigured-model";
			await writeFile(path, `${JSON.stringify(state)}\n`);
			const beforeContents = await readFile(path, "utf8");
			const bridge = new TestCodexBridge(firstBridge.nativeThreadId);
			const recovered = await openDriver(
				path,
				bridge,
				undefined,
				mutation === "changed-config" ? "configuration-b" : "configuration-a",
			);
			drivers.push(recovered);
			const before = bridge.requests.length;
			expect(await recovered.lookupOperation(command)).toEqual({
				state: "unknown",
			});
			await expect(recovered.execute(command)).rejects.toMatchObject({
				code: "RUNTIME_CODEX_UNAVAILABLE",
			});
			expect(bridge.requests.slice(before)).toEqual([]);
			expect(await readFile(path, "utf8")).toBe(beforeContents);
		},
	);

	it("does not recover or rewrite a legacy running Turn without configuration provenance", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(
			path,
			firstBridge,
			undefined,
			"configuration-a",
		);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstDriver.close();
		const state = JSON.parse(
			await readFile(path, "utf8"),
		) as StoredCodexDriverState;
		const submit = Object.values(state.operations).find(
			(operation) => operation.record?.result?.outcome === "accepted",
		);
		if (!submit) throw new Error("missing submit operation");
		delete submit.configVersion;
		await writeFile(path, `${JSON.stringify(state)}\n`);
		const legacyContents = await readFile(path, "utf8");

		const recoveredBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		const recoveredDriver = await openDriver(
			path,
			recoveredBridge,
			undefined,
			"configuration-a",
		);
		drivers.push(recoveredDriver);
		const beforeRecovery = recoveredBridge.requests.length;
		await expect(
			recoveredDriver.getStatus(accepted.nativeSessionRef, command.executionId),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		expect(recoveredBridge.requests.slice(beforeRecovery)).toEqual([]);
		expect(await readFile(path, "utf8")).toBe(legacyContents);
	});

	it("keeps terminal durable data readable and starts the next Turn under the current revision", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(
			path,
			firstBridge,
			undefined,
			"configuration-a",
		);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstBridge.emitTurnCompleted("completed");
		await vi.waitFor(async () => {
			expect(
				await persistedExecutionStatus(
					path,
					accepted.nativeSessionRef,
					command.executionId,
				),
			).toBe("completed");
		});
		await firstDriver.close();

		const recoveredBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		recoveredBridge.setTurnStatus("completed");
		recoveredBridge.continueAfterPersistedTurn();
		const recoveredDriver = await openDriver(
			path,
			recoveredBridge,
			undefined,
			"configuration-b",
		);
		drivers.push(recoveredDriver);
		const beforeRead = recoveredBridge.requests.length;
		expect((await recoveredDriver.execute(command)).result).toEqual({
			outcome: "accepted",
			status: "completed",
		});
		expect(await recoveredDriver.lookupOperation(command)).toMatchObject({
			state: "found",
			record: { result: { outcome: "accepted", status: "completed" } },
		});
		expect(
			await recoveredDriver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			),
		).toBe("completed");
		expect(
			await recoveredDriver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "completed",
					payload: { status: "completed" },
				}),
			]),
		);
		expect(recoveredBridge.requests.slice(beforeRead)).toEqual([]);

		const next = await recoveredDriver.execute(
			submitCommand({
				operationId: "execution-codex-next-config",
				executionId: "execution-codex-next-config",
				turnId: "turn-codex-next-config",
				nativeSessionRef: accepted.nativeSessionRef,
			}),
		);
		expect(next.result).toEqual({ outcome: "accepted", status: "running" });
		const persisted = JSON.parse(
			await readFile(path, "utf8"),
		) as StoredCodexDriverState;
		expect(
			Object.values(persisted.operations)
				.filter((operation) => operation.record?.result?.outcome === "accepted")
				.map((operation) => operation.configVersion),
		).toEqual(["configuration-a", "configuration-b"]);
	});

	it("persists a turn-start notification that races the Turn binding and replays it once", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const submitted = driver.execute(command);

		await vi.waitFor(() => {
			expect(bridge.pendingTurnStartCount()).toBe(1);
		});
		const notification = bridge.emitNotification();
		bridge.respondToHeldTurnStart();
		const accepted = await submitted;
		await notification;

		const events = await driver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		expect(events).toEqual([
			expect.objectContaining({
				executionId: command.executionId,
				type: "status",
				payload: { status: "running" },
			}),
		]);
		expect(JSON.stringify(events)).not.toContain(bridge.nativeThreadId);
		expect(JSON.stringify(events)).not.toContain(bridge.nativeTurnId);
	});

	it("binds a terminal notification that races the Turn response as terminal", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const submitted = driver.execute(command);

		await vi.waitFor(() => {
			expect(bridge.pendingTurnStartCount()).toBe(1);
		});
		const notification = bridge.emitTurnCompleted("completed");
		bridge.respondToHeldTurnStart();
		const accepted = await submitted;
		await notification;

		expect(accepted.result).toEqual({
			outcome: "accepted",
			status: "completed",
		});
		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("completed");
		expect(
			await driver.replayEvents(accepted.nativeSessionRef, command.executionId),
		).toEqual([
			expect.objectContaining({
				type: "completed",
				payload: { status: "completed" },
			}),
		]);
	});

	it("preserves started and delta order when a terminal start response races them", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const submitted = driver.execute(command);

		await vi.waitFor(() => {
			expect(bridge.pendingTurnStartCount()).toBe(1);
		});
		await bridge.emitNotification();
		await bridge.emitAgentMessageDelta("before-terminal-response");
		bridge.respondToHeldTurnStart("completed");
		const accepted = await submitted;

		expect(accepted.result).toEqual({
			outcome: "accepted",
			status: "completed",
		});
		expect(
			await driver.replayEvents(accepted.nativeSessionRef, command.executionId),
		).toEqual([
			expect.objectContaining({
				type: "status",
				payload: { status: "running" },
			}),
			expect.objectContaining({
				type: "text",
				payload: { delta: "before-terminal-response" },
			}),
			expect.objectContaining({
				type: "completed",
				payload: { status: "completed" },
			}),
		]);
	});

	it("accepts the pinned v2 event recovery wire shapes", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const bridge = new TestCodexBridge();
		const driver = await openDriver(path, bridge, (options) => {
			expect(options.provenance).toEqual(CODEX_APP_SERVER_V2_PROVENANCE);
		});
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		await bridge.emitFrame(pinnedV2EventRecoveryFrames.threadStarted);
		await bridge.emitFrame(pinnedV2EventRecoveryFrames.agentMessageDelta);
		await bridge.emitFrame(pinnedV2EventRecoveryFrames.turnCompleted);
		const events = await vi.waitFor(async () => {
			const replayed = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(replayed).toHaveLength(3);
			return replayed;
		});
		expect(events.map((event) => event.type)).toEqual([
			"status",
			"text",
			"completed",
		]);
	});

	it("restores the pinned v2 thread-items-list response", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge();
		resumedBridge.setItemsListPages([
			structuredClone(pinnedV2EventRecoveryFrames.threadItemsListResponse),
		]);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);
		const events = await resumedDriver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		expect(events).toEqual([
			expect.objectContaining({
				type: "status",
				payload: { status: "running" },
			}),
			expect.objectContaining({
				type: "text",
				payload: { delta: "schema-history" },
			}),
		]);
		expect(
			resumedBridge.requests.find(
				({ method }) => method === "thread/items/list",
			),
		).toEqual({
			method: "thread/items/list",
			params: pinnedV2EventRecoveryFrames.threadItemsListRequest,
		});
	});

	it("keeps equal native delta occurrences distinct with stable local cursors", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		await bridge.emitAgentMessageDelta("same-delta");
		await vi.waitFor(async () => {
			expect(
				(
					await driver.replayEvents(
						accepted.nativeSessionRef,
						command.executionId,
					)
				).filter((event) => event.type === "text"),
			).toHaveLength(1);
		});
		await bridge.emitAgentMessageDelta("same-delta");
		const textEvents = await vi.waitFor(async () => {
			const events = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const text = events.filter((event) => event.type === "text");
			expect(text).toHaveLength(2);
			return text;
		});

		expect(textEvents).toEqual([
			expect.objectContaining({ payload: { delta: "same-delta" } }),
			expect.objectContaining({ payload: { delta: "same-delta" } }),
		]);
		expect(textEvents[0]?.cursor).not.toBe(textEvents[1]?.cursor);
		expect(textEvents[0]?.adapterEventKey).not.toBe(
			textEvents[1]?.adapterEventKey,
		);
		expect(JSON.stringify(textEvents)).not.toContain(
			"codex-native-item-private",
		);
	});

	it("streams existing and later persisted journal events once", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const abort = new AbortController();
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
			undefined,
			abort.signal,
		);
		const iterator = stream[Symbol.asyncIterator]();

		expect(await iterator.next()).toMatchObject({
			done: false,
			value: {
				executionId: command.executionId,
				type: "status",
				payload: { status: "running" },
			},
		});
		const next = iterator.next();
		await bridge.emitAgentMessageDelta("later-delta");
		expect(await next).toMatchObject({
			done: false,
			value: {
				executionId: command.executionId,
				type: "text",
				payload: { delta: "later-delta" },
			},
		});
		abort.abort();
		expect(await iterator.next()).toEqual({ done: true, value: undefined });
	});

	it("wakes a live stream when polling persists a terminal status", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const abort = new AbortController();
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
			undefined,
			abort.signal,
		);
		const iterator = stream[Symbol.asyncIterator]();

		try {
			await iterator.next();
			const terminal = iterator.next();
			bridge.setTurnStatus("completed");
			expect(
				await driver.getStatus(accepted.nativeSessionRef, command.executionId),
			).toBe("completed");
			expect(
				await Promise.race([
					terminal,
					new Promise((resolve) => {
						setTimeout(() => resolve("timed out"), 100);
					}),
				]),
			).toMatchObject({
				done: false,
				value: { type: "completed", payload: { status: "completed" } },
			});
		} finally {
			abort.abort();
			await iterator.next();
		}
	});

	it("ends a live stream after its terminal event", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const iterator = stream[Symbol.asyncIterator]();

		await iterator.next();
		const terminal = iterator.next();
		await bridge.emitTurnCompleted("completed");
		expect(await terminal).toMatchObject({
			done: false,
			value: { type: "completed", payload: { status: "completed" } },
		});
		expect(
			await Promise.race([
				iterator.next(),
				new Promise((resolve) => {
					setTimeout(() => resolve("timed out"), 100);
				}),
			]),
		).toEqual({ done: true, value: undefined });
	});

	it("ends a recovery stream from its terminal cursor", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		await bridge.emitTurnCompleted("completed");
		const terminal = await vi.waitFor(async () => {
			const events = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const completed = events.find((event) => event.type === "completed");
			expect(completed).toBeDefined();
			return completed;
		});
		if (!terminal) throw new Error("expected a terminal event");
		const abort = new AbortController();
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
			terminal.cursor,
			abort.signal,
		);
		const iterator = stream[Symbol.asyncIterator]();

		try {
			expect(
				await Promise.race([
					iterator.next(),
					new Promise((resolve) => {
						setTimeout(() => resolve("timed out"), 100);
					}),
				]),
			).toEqual({ done: true, value: undefined });
		} finally {
			abort.abort();
			await iterator.next();
		}
	});

	it("fails closed when a delta follows a terminal event", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const iterator = stream[Symbol.asyncIterator]();

		await iterator.next();
		const terminal = iterator.next();
		await bridge.emitTurnCompleted("completed");
		expect(await terminal).toMatchObject({
			done: false,
			value: { type: "completed", payload: { status: "completed" } },
		});
		await bridge.emitAgentMessageDelta("late-delta");
		await vi.waitFor(() => expect(bridge.isClosed()).toBe(true));
		await expect(
			driver.execute(
				submitCommand({
					operationId: "execution-codex-after-terminal",
					executionId: "execution-codex-after-terminal",
					turnId: "turn-codex-after-terminal",
					nativeSessionRef: accepted.nativeSessionRef,
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
	});

	it("fails closed when a terminal started notification follows a terminal event", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		await bridge.emitTurnCompleted("completed");
		await vi.waitFor(async () => {
			const events = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(events.filter((event) => event.type === "completed")).toHaveLength(
				1,
			);
		});

		await bridge.emitNotification("completed");
		await vi.waitFor(() => expect(bridge.isClosed()).toBe(true));
		await expect(
			driver.execute(
				submitCommand({
					operationId: "execution-codex-after-terminal-started",
					executionId: "execution-codex-after-terminal-started",
					turnId: "turn-codex-after-terminal-started",
					nativeSessionRef: accepted.nativeSessionRef,
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
	});

	it("fails closed for a terminal started notification", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const accepted = await driver.execute(submitCommand());

		await bridge.emitNotification("completed");
		await vi.waitFor(() => expect(bridge.isClosed()).toBe(true));
		await expect(
			driver.execute(
				submitCommand({
					conversationId: "conversation-codex-after-terminal-start",
					operationId: "execution-codex-after-terminal-start",
					executionId: "execution-codex-after-terminal-start",
					turnId: "turn-codex-after-terminal-start",
					nativeSessionRef: accepted.nativeSessionRef,
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_PROTOCOL_INVALID" });
	});

	it("replays a terminal event persisted after subscription setup", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);

		await bridge.emitTurnCompleted("completed");
		await vi.waitFor(async () => {
			const events = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(events.filter((event) => event.type === "completed")).toHaveLength(
				1,
			);
		});
		const iterator = stream[Symbol.asyncIterator]();
		expect(await iterator.next()).toMatchObject({
			done: false,
			value: { type: "status", payload: { status: "running" } },
		});
		expect(await iterator.next()).toMatchObject({
			done: false,
			value: { type: "completed", payload: { status: "completed" } },
		});
	});

	it("replays a terminal event that races the initial live replay", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const replay = driver.replayEvents.bind(driver);
		let replays = 0;
		vi.spyOn(driver, "replayEvents").mockImplementation(async (...args) => {
			const events = await replay(...args);
			replays += 1;
			if (replays === 1) {
				await bridge.emitTurnCompleted("completed");
				await vi.waitFor(async () => {
					const persisted = await replay(...args);
					expect(
						persisted.filter((event) => event.type === "completed"),
					).toHaveLength(1);
				});
			}
			return events;
		});
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const iterator = stream[Symbol.asyncIterator]();

		expect(await iterator.next()).toMatchObject({
			done: false,
			value: { type: "status", payload: { status: "running" } },
		});
		expect(await iterator.next()).toMatchObject({
			done: false,
			value: { type: "completed", payload: { status: "completed" } },
		});
	});

	it("does not yield replayed events after stream abort", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const replay = driver.replayEvents.bind(driver);
		let replays = 0;
		let releaseReplay: (() => void) | undefined;
		vi.spyOn(driver, "replayEvents").mockImplementation(async (...args) => {
			replays += 1;
			if (replays === 2) {
				await new Promise<void>((resolve) => {
					releaseReplay = resolve;
				});
			}
			return replay(...args);
		});
		const abort = new AbortController();
		const stream = await driver.subscribeEvents(
			accepted.nativeSessionRef,
			command.executionId,
			undefined,
			abort.signal,
		);
		const iterator = stream[Symbol.asyncIterator]();

		expect(await iterator.next()).toMatchObject({
			done: false,
			value: { type: "status", payload: { status: "running" } },
		});
		const next = iterator.next();
		await bridge.emitAgentMessageDelta("after-abort");
		await vi.waitFor(() => expect(releaseReplay).toBeTypeOf("function"));
		await vi.waitFor(async () => {
			const events = await replay(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(events.filter((event) => event.type === "text")).toHaveLength(1);
		});
		abort.abort();
		releaseReplay?.();
		expect(await next).toEqual({ done: true, value: undefined });
	});

	it("persists a terminal Turn notification and replays it once", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		await bridge.emitTurnCompleted("completed");
		const events = await vi.waitFor(async () => {
			const replayed = await driver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(
				replayed.filter((event) => event.type === "completed"),
			).toHaveLength(1);
			return replayed;
		});
		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("completed");
		expect(events.at(-1)).toMatchObject({
			type: "completed",
			payload: { status: "completed" },
		});
		expect(JSON.stringify(events)).not.toContain(bridge.nativeThreadId);
		expect(JSON.stringify(events)).not.toContain(bridge.nativeTurnId);
	});

	it("recovers persisted Turn status and item history after Driver restart", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		resumedBridge.setTurnStatus("completed");
		resumedBridge.setItemsListPages([
			{
				data: [
					{
						turnId: firstBridge.nativeTurnId,
						item: {
							id: "codex-native-item-private",
							type: "agentMessage",
							text: "persisted answer",
						},
					},
				],
			},
		]);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);

		const events = await resumedDriver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		expect(events.map((event) => event.cursor)).toEqual([
			"codex-cursor-1",
			"codex-cursor-2",
			"codex-cursor-3",
		]);
		expect(events.map((event) => event.adapterEventKey)).toEqual([
			"codex-event-1",
			"codex-event-2",
			"codex-event-3",
		]);

		expect(events).toEqual([
			expect.objectContaining({
				type: "status",
				payload: { status: "running" },
			}),
			expect.objectContaining({
				type: "text",
				payload: { delta: "persisted answer" },
			}),
			expect.objectContaining({
				type: "completed",
				payload: { status: "completed" },
			}),
		]);
		expect(
			await resumedDriver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			),
		).toBe("completed");
		expect(resumedBridge.requests.map(({ method }) => method)).toEqual([
			"initialize",
			"config/read",
			"thread/resume",
			"thread/turns/list",
			"thread/items/list",
		]);
		expect(
			resumedBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
		expect(JSON.stringify(events)).not.toContain(firstBridge.nativeThreadId);
		expect(JSON.stringify(events)).not.toContain(firstBridge.nativeTurnId);
		expect(JSON.stringify(events)).not.toContain("codex-native-item-private");
	});

	it("uses a terminal notification persisted while resuming before recovering history", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		resumedBridge.completeOnThreadResume("completed");
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);

		const events = await resumedDriver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		expect(events.at(-1)).toMatchObject({
			type: "completed",
			payload: { status: "completed" },
		});
		expect(
			resumedBridge.requests.filter(
				({ method }) => method === "thread/turns/list",
			),
		).toHaveLength(0);
		expect(
			resumedBridge.requests.filter(
				({ method }) => method === "thread/items/list",
			),
		).toHaveLength(1);
		expect(
			resumedBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
	});

	it("fails closed with a redacted error when persisted item recovery is malformed", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		resumedBridge.setItemsListPages([
			{
				data: [
					{
						turnId: firstBridge.nativeTurnId,
						item: {
							id: "codex-native-item-private",
							type: "agentMessage",
						},
					},
				],
			},
		]);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);

		const failure = await resumedDriver
			.replayEvents(accepted.nativeSessionRef, command.executionId)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(failure).toMatchObject({
			code: "RUNTIME_CODEX_PROTOCOL_INVALID",
			message: "Codex Runtime returned an invalid response",
		});
		expect(JSON.stringify(failure)).not.toContain(firstBridge.nativeThreadId);
		expect(JSON.stringify(failure)).not.toContain(firstBridge.nativeTurnId);
		expect(JSON.stringify(failure)).not.toContain("codex-native-item-private");
	});

	it("keeps the original local cursor when recovery sees an already journaled item", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstBridge.emitAgentMessageDelta("already-persisted");
		const original = await vi.waitFor(async () => {
			const events = await firstDriver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const event = events.find((candidate) => candidate.type === "text");
			if (!event) throw new Error("expected journaled text event");
			return event;
		});
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		resumedBridge.setItemsListPages([
			{
				data: [
					{
						turnId: firstBridge.nativeTurnId,
						item: {
							id: "codex-native-item-private",
							type: "agentMessage",
							text: "already-persisted",
						},
					},
				],
			},
		]);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);

		const recovered = (
			await resumedDriver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			)
		).find((candidate) => candidate.type === "text");
		expect(recovered).toMatchObject({
			cursor: original.cursor,
			adapterEventKey: original.adapterEventKey,
			payload: { delta: "already-persisted" },
		});
	});

	it("rejects new recovered text after a persisted terminal event without rewriting history", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstBridge.emitTurnCompleted("completed");
		await vi.waitFor(async () => {
			const events = await firstDriver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			);
			expect(events.at(-1)?.type).toBe("completed");
		});
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(
			firstBridge.nativeThreadId,
			firstBridge.nativeTurnId,
		);
		resumedBridge.setTurnStatus("completed");
		resumedBridge.setItemsListPages([
			{
				data: [
					{
						turnId: firstBridge.nativeTurnId,
						item: {
							id: "codex-native-item-private",
							type: "agentMessage",
							text: "recovered-after-terminal",
						},
					},
				],
			},
		]);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);

		const before = await readFile(path, "utf8");
		await expect(
			resumedDriver.replayEvents(
				accepted.nativeSessionRef,
				command.executionId,
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_PROTOCOL_INVALID" });
		expect(await readFile(path, "utf8")).toBe(before);
	});

	it("fails closed for duplicate durable journal identities", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await vi.waitFor(async () => {
			expect(
				await firstDriver.replayEvents(
					accepted.nativeSessionRef,
					command.executionId,
				),
			).toHaveLength(1);
		});
		await firstDriver.close();
		const state = JSON.parse(await readFile(path, "utf8")) as {
			sessions: Record<
				string,
				{ journals?: Record<string, { events: unknown[] }> }
			>;
		};
		const journal = Object.values(state.sessions)[0]?.journals?.[
			firstBridge.nativeTurnId
		];
		if (!journal?.events[0]) throw new Error("expected durable journal event");
		journal.events.push(structuredClone(journal.events[0]));
		await writeFile(path, JSON.stringify(state));
		const resumedBridge = new TestCodexBridge();

		await expect(openDriver(path, resumedBridge)).rejects.toMatchObject({
			code: "RUNTIME_CODEX_STATE_INVALID",
			message: "Codex Runtime session state is unavailable",
		});
		expect(resumedBridge.requests).toEqual([]);
	});

	it("fails closed for inconsistent durable terminal journals", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const accepted = await firstDriver.execute(submitCommand());
		await firstBridge.emitTurnCompleted("completed");
		await vi.waitFor(async () => {
			const events = await firstDriver.replayEvents(
				accepted.nativeSessionRef,
				"execution-codex",
			);
			expect(events.at(-1)?.type).toBe("completed");
		});
		await firstDriver.close();
		const state = JSON.parse(
			await readFile(path, "utf8"),
		) as StoredCodexDriverState;

		for (const corrupt of [
			(journal: StoredEventJournal) => {
				const completed = journal.events.find(
					(event) => event.type === "completed",
				);
				if (!completed) throw new Error("expected completed event");
				journal.events.push({
					...completed,
					cursor: "cursor-duplicate-terminal",
					adapterEventKey: "adapter-event-duplicate-terminal",
				});
			},
			(journal: StoredEventJournal) => {
				journal.events.push({
					cursor: "cursor-after-terminal",
					adapterEventKey: "adapter-event-after-terminal",
					occurredAt: "2026-09-04T00:00:00.000Z",
					nativeItemId: "item-after-terminal",
					type: "text",
					payload: { delta: "late" },
				});
			},
			(journal: StoredEventJournal) => {
				const completed = journal.events.find(
					(event) => event.type === "completed",
				);
				if (!completed) throw new Error("expected completed event");
				completed.payload = { status: "failed" };
			},
			(journal: StoredEventJournal) => {
				journal.events.pop();
			},
		]) {
			const candidate = structuredClone(state);
			const session = Object.values(candidate.sessions)[0];
			const journal = session?.journals?.[firstBridge.nativeTurnId];
			if (!session || !journal) throw new Error("expected durable journal");
			corrupt(journal);
			session.eventSequence = journal.events.length;
			await writeFile(path, JSON.stringify(candidate));
			const resumedBridge = new TestCodexBridge();

			await expect(openDriver(path, resumedBridge)).rejects.toMatchObject({
				code: "RUNTIME_CODEX_STATE_INVALID",
				message: "Codex Runtime session state is unavailable",
			});
			expect(resumedBridge.requests).toEqual([]);
		}
	});

	it("coalesces concurrent persisted Session resumes", async () => {
		const directory = await runtimeDirectory();
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(
			join(directory, "driver.json"),
			firstBridge,
		);
		drivers.push(firstDriver);
		const command = submitCommand();
		const firstResult = await firstDriver.execute(command);
		await firstDriver.close();

		const resumedBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		const resumedDriver = await openDriver(
			join(directory, "driver.json"),
			resumedBridge,
		);
		drivers.push(resumedDriver);

		await expect(
			Promise.all([
				resumedDriver.getStatus(
					firstResult.nativeSessionRef,
					command.executionId,
				),
				resumedDriver.getStatus(
					firstResult.nativeSessionRef,
					command.executionId,
				),
			]),
		).resolves.toEqual(["running", "running"]);
		expect(
			resumedBridge.requests.filter(({ method }) => method === "thread/resume"),
		).toHaveLength(1);
	});

	it("keeps duplicate and busy submit outcomes from starting another native Turn", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		expect(await driver.execute(command)).toEqual(accepted);
		const busy = await driver.execute(
			submitCommand({
				operationId: "execution-codex-next",
				executionId: "execution-codex-next",
				turnId: "turn-codex-next",
				nativeSessionRef: accepted.nativeSessionRef,
			}),
		);

		expect(busy.result).toEqual({ outcome: "busy" });
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("coalesces concurrent retries for one operation", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();

		const [first, duplicate] = await Promise.all([
			driver.execute(command),
			driver.execute(command),
		]);

		expect(duplicate).toEqual(first);
		expect(first.result).toEqual({ outcome: "accepted", status: "running" });
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("does not start a second native Turn for concurrent idle-Session submits", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const first = driver.execute(submitCommand());
		const second = driver.execute(
			submitCommand({
				operationId: "execution-codex-concurrent",
				executionId: "execution-codex-concurrent",
				turnId: "turn-codex-concurrent",
			}),
		);
		const [firstResult, secondResult] = await Promise.allSettled([
			first,
			second,
		]);

		expect(firstResult).toMatchObject({
			status: "fulfilled",
			value: { result: { outcome: "accepted", status: "running" } },
		});
		expect(secondResult).toMatchObject({
			status: "rejected",
			reason: { code: "RUNTIME_CODEX_UNAVAILABLE" },
		});
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("rejects a submit whose operation and Execution identities differ", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);

		await expect(
			driver.execute(
				submitCommand({ operationId: "operation-codex-not-an-execution" }),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_STATE_INVALID" });
		expect(
			bridge.requests.filter(({ method }) => method === "thread/start"),
		).toHaveLength(0);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
	});

	it("persists a prototype-like Execution identity across Driver restart", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand({
			operationId: "__proto__",
			executionId: "__proto__",
			turnId: "turn-codex-prototype",
		});
		const first = await firstDriver.execute(command);
		await firstDriver.close();
		const resumedBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		const resumedDriver = await openDriver(path, resumedBridge);
		drivers.push(resumedDriver);

		expect(
			await resumedDriver.getStatus(
				first.nativeSessionRef,
				command.executionId,
			),
		).toBe("running");
		expect(resumedBridge.requests.map(({ method }) => method)).toEqual([
			"initialize",
			"config/read",
			"thread/resume",
			"thread/turns/list",
		]);
	});

	it("fails closed for inherited Session and Execution identifiers", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const accepted = await driver.execute(submitCommand());

		await expect(
			driver.getStatus(accepted.nativeSessionRef, "constructor"),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		await expect(
			driver.getStatus("constructor", "execution-codex"),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
	});

	it("rejects a duplicate native thread response across Sessions", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		await driver.execute(submitCommand());

		await expect(
			driver.execute(
				submitCommand({
					conversationId: "conversation-codex-other",
					operationId: "execution-codex-other",
					executionId: "execution-codex-other",
					turnId: "turn-codex-other",
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_PROTOCOL_INVALID" });
		expect(
			bridge.requests.filter(({ method }) => method === "thread/start"),
		).toHaveLength(2);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("rejects a duplicate native Turn response in one Session", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const first = await driver.execute(submitCommand());
		bridge.setTurnStatus("completed");
		await driver.getStatus(first.nativeSessionRef, "execution-codex");
		bridge.duplicateNextTurnResponse();

		await expect(
			driver.execute(
				submitCommand({
					operationId: "execution-codex-duplicate-turn",
					executionId: "execution-codex-duplicate-turn",
					turnId: "turn-codex-duplicate-turn",
					nativeSessionRef: first.nativeSessionRef,
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_PROTOCOL_INVALID" });
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(2);
	});

	it("reuses an active Session for a ref-less submit retry", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		await driver.execute(submitCommand());

		expect(
			(
				await driver.execute(
					submitCommand({
						operationId: "execution-codex-ref-less-retry",
						executionId: "execution-codex-ref-less-retry",
						turnId: "turn-codex-ref-less-retry",
					}),
				)
			).result,
		).toEqual({ outcome: "busy" });
		expect(
			bridge.requests.filter(({ method }) => method === "thread/start"),
		).toHaveLength(1);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("fails closed for a ref-less submit with multiple matching Sessions", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		await writeFile(
			path,
			JSON.stringify({
				schemaVersion: 1,
				sessions: {
					"opaque-session-one": {
						nativeSessionRef: "opaque-session-one",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						threadId: "codex-native-thread-one",
						executions: {},
					},
					"opaque-session-two": {
						nativeSessionRef: "opaque-session-two",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						threadId: "codex-native-thread-two",
						executions: {},
					},
				},
				operations: {},
			}),
		);
		const bridge = new TestCodexBridge();
		const driver = await openDriver(path, bridge);
		drivers.push(driver);

		await expect(driver.execute(submitCommand())).rejects.toMatchObject({
			code: "RUNTIME_CODEX_STATE_INVALID",
		});
		expect(
			bridge.requests.filter(({ method }) => method === "thread/start"),
		).toHaveLength(0);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
	});

	it.each([
		["a different configuration revision", false, "configuration-b"],
		["missing legacy configuration provenance", true, "configuration-a"],
	] as const)(
		"keeps an unconfirmed native Turn unknown under %s without retrying it",
		async (_name, removeConfigVersion, recoveredConfigVersion) => {
			const directory = await runtimeDirectory();
			const path = join(directory, "driver.json");
			const command = submitCommand();
			const interruptedBridge = new TestCodexBridge(
				"codex-native-thread-private",
				"codex-native-turn-private",
				true,
			);
			const interruptedDriver = await openDriver(
				path,
				interruptedBridge,
				undefined,
				"configuration-a",
			);
			drivers.push(interruptedDriver);

			await expect(interruptedDriver.execute(command)).rejects.toMatchObject({
				code: "RUNTIME_CODEX_UNAVAILABLE",
			});
			expect(
				interruptedBridge.requests.filter(
					({ method }) => method === "turn/start",
				),
			).toHaveLength(1);
			if (removeConfigVersion) {
				const state = JSON.parse(
					await readFile(path, "utf8"),
				) as StoredCodexDriverState;
				const prepared = Object.values(state.operations).find(
					(operation) => operation.state === "prepared",
				);
				if (!prepared) throw new Error("missing prepared submit operation");
				delete prepared.configVersion;
				await writeFile(path, `${JSON.stringify(state)}\n`);
			}

			const recoveredBridge = new TestCodexBridge();
			const recoveredDriver = await openDriver(
				path,
				recoveredBridge,
				undefined,
				recoveredConfigVersion,
			);
			drivers.push(recoveredDriver);
			const beforeRecovery = recoveredBridge.requests.length;

			expect(await recoveredDriver.lookupOperation(command)).toEqual({
				state: "unknown",
			});
			const unknown = await recoveredDriver.execute(command);
			expect(unknown.result).toEqual({
				outcome: "unknown",
				code: "RUNTIME_ACCEPTANCE_UNKNOWN",
				message: "Runtime command acceptance could not be confirmed",
			});
			await expect(
				recoveredDriver.execute(
					submitCommand({
						operationId: "execution-codex-after-unknown",
						executionId: "execution-codex-after-unknown",
						turnId: "turn-codex-after-unknown",
						nativeSessionRef: unknown.nativeSessionRef,
					}),
				),
			).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
			await expect(
				recoveredDriver.execute(
					submitCommand({
						operationId: "execution-codex-replacement-after-unknown",
						executionId: "execution-codex-replacement-after-unknown",
						turnId: "turn-codex-replacement-after-unknown",
					}),
				),
			).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
			expect(
				recoveredBridge.requests.filter(
					({ method }) => method === "turn/start",
				),
			).toHaveLength(0);
			expect(
				recoveredBridge.requests.filter(
					({ method }) => method === "thread/start",
				),
			).toHaveLength(0);
			expect(recoveredBridge.requests.slice(beforeRecovery)).toEqual([]);
		},
	);

	it.each([
		[
			"removed model option",
			driverOptions("unused").modelOptions.filter(
				(option) => option.modelOptionId !== "model-option-alternate",
			),
		],
		[
			"removed reasoning level",
			driverOptions("unused").modelOptions.map((option) =>
				option.modelOptionId === "model-option-alternate"
					? { ...option, reasoningLevels: ["high"] }
					: option,
			),
		],
	] as const)(
		"keeps an uncertain V2 operation unknown after its %s",
		async (_name, modelOptions) => {
			const directory = await runtimeDirectory();
			const path = join(directory, "driver.json");
			const command = submitCommandV2({
				selection: {
					schemaVersion: 1,
					modelOptionId: "model-option-alternate",
					reasoningLevel: "low",
				},
			});
			const failedBridge = new TestCodexBridge(
				"codex-native-thread-private",
				"codex-native-turn-private",
				true,
			);
			const failedDriver = await openDriver(
				path,
				failedBridge,
				undefined,
				"configuration-a",
			);
			drivers.push(failedDriver);
			await expect(failedDriver.execute(command)).rejects.toMatchObject({
				code: "RUNTIME_CODEX_UNAVAILABLE",
			});
			const durableBeforeRecovery = await readFile(path, "utf8");
			const durableState = JSON.parse(
				durableBeforeRecovery,
			) as StoredCodexDriverState;
			const [preparedOperationKey, preparedOperation] =
				Object.entries(durableState.operations)[0] ?? [];
			if (!preparedOperationKey || !preparedOperation?.nativeSessionRef) {
				throw new Error("missing prepared submit operation");
			}
			expect(
				durableState.sessions[preparedOperation.nativeSessionRef]
					?.acceptanceUncertainOperationKey,
			).toBe(preparedOperationKey);

			const recoveredBridge = new TestCodexBridge();
			const recoveredDriver = await openCodexRuntimeDriverForTest(
				{
					...driverOptions(path, "configuration-b"),
					modelOptions,
				},
				async () => recoveredBridge,
			);
			drivers.push(recoveredDriver);
			const beforeRecovery = recoveredBridge.requests.length;

			expect(await recoveredDriver.lookupOperation(command)).toEqual({
				state: "unknown",
			});
			expect((await recoveredDriver.execute(command)).result).toMatchObject({
				outcome: "unknown",
				code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			});
			await expect(
				recoveredDriver.execute(
					submitCommandV2({
						operationId: "execution-codex-after-v2-unknown",
						executionId: "execution-codex-after-v2-unknown",
						turnId: "turn-codex-after-v2-unknown",
						nativeSessionRef: preparedOperation.nativeSessionRef,
						selection: {
							schemaVersion: 1,
							modelOptionId: "model-option-primary",
							reasoningLevel: "high",
						},
					}),
				),
			).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
			expect(recoveredBridge.requests.slice(beforeRecovery)).toEqual([]);
			expect(await readFile(path, "utf8")).toBe(durableBeforeRecovery);
		},
	);

	it("keeps a command unknown when its native Session start response is lost", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const failedBridge = new TestCodexBridge();
		failedBridge.dropNextThreadStartResponse();
		const failedDriver = await openDriver(path, failedBridge);
		drivers.push(failedDriver);
		const command = submitCommand();

		await expect(failedDriver.execute(command)).rejects.toMatchObject({
			code: "RUNTIME_CODEX_UNAVAILABLE",
		});
		expect(
			failedBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);

		const recoveredBridge = new TestCodexBridge();
		const recoveredDriver = await openDriver(path, recoveredBridge);
		drivers.push(recoveredDriver);

		expect(await recoveredDriver.lookupOperation(command)).toEqual({
			state: "unknown",
		});
		const unknown = await recoveredDriver.execute(command);

		expect(unknown.result).toEqual({
			outcome: "unknown",
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			message: "Runtime command acceptance could not be confirmed",
		});
		expect(
			recoveredBridge.requests.filter(
				({ method }) => method === "thread/start",
			),
		).toHaveLength(0);
		expect(
			recoveredBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
	});

	it("retries a command after its persisted Session resume fails before Turn start", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const first = await firstDriver.execute(submitCommand());
		firstBridge.setTurnStatus("completed");
		await firstDriver.getStatus(first.nativeSessionRef, "execution-codex");
		await firstDriver.close();
		const command = submitCommand({
			operationId: "execution-codex-after-resume-failure",
			executionId: "execution-codex-after-resume-failure",
			turnId: "turn-codex-after-resume-failure",
			nativeSessionRef: first.nativeSessionRef,
		});
		const failedBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		failedBridge.dropNextThreadResumeResponse();
		const failedDriver = await openDriver(path, failedBridge);
		drivers.push(failedDriver);

		await expect(failedDriver.execute(command)).rejects.toMatchObject({
			code: "RUNTIME_CODEX_UNAVAILABLE",
		});
		expect(
			failedBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);

		const recoveredBridge = new TestCodexBridge(firstBridge.nativeThreadId);
		recoveredBridge.continueAfterPersistedTurn();
		const recoveredDriver = await openDriver(path, recoveredBridge);
		drivers.push(recoveredDriver);

		expect((await recoveredDriver.execute(command)).result).toEqual({
			outcome: "accepted",
			status: "running",
		});
		expect(
			recoveredBridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("persists the alternate model before Turn start and restores only that route after restart", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const upstreamModels: string[] = [];
		const endpoint = await listen(
			createServer(async (request, response) => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				upstreamModels.push(JSON.parse(Buffer.concat(chunks).toString()).model);
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		let bridge = new TestCodexBridge();
		bridge.holdTurnStart();
		let loopback: CodexModelAccess | undefined;
		let driver = await openDriverWithModelEndpoint(
			path,
			bridge,
			endpoint,
			(options) => {
				loopback = options.modelAccess;
			},
		);
		drivers.push(driver);
		const command = submitCommandV2({
			selection: {
				schemaVersion: 1,
				modelOptionId: "model-option-alternate",
				reasoningLevel: "low",
			},
		});
		const alternate = internalModel("model-option-alternate", "gpt-5.2-codex");
		const nativeSend = bridge.send.bind(bridge);
		const persistedBeforeNative: string[] = [];
		vi.spyOn(bridge, "send").mockImplementation(async (frame) => {
			if (frame.method === "thread/start" || frame.method === "turn/start") {
				const state = JSON.parse(
					await readFile(path, "utf8"),
				) as StoredCodexDriverState;
				expect(Object.values(state.operations)).toContainEqual(
					expect.objectContaining({
						state: "prepared",
						internalModel: alternate,
					}),
				);
				persistedBeforeNative.push(frame.method);
			}
			await nativeSend(frame);
		});
		const submitted = driver.execute(command);
		await vi.waitFor(() => expect(bridge.pendingTurnStartCount()).toBe(1));
		const stored = JSON.parse(
			await readFile(path, "utf8"),
		) as StoredCodexDriverState;
		expect(Object.values(stored.operations)).toContainEqual(
			expect.objectContaining({ state: "prepared", internalModel: alternate }),
		);
		await bridge.emitNotification();
		bridge.respondToHeldTurnStart();
		const accepted = await submitted;
		expect(persistedBeforeNative).toEqual(["thread/start", "turn/start"]);
		for (const restart of [false, true]) {
			if (restart) {
				await driver.close();
				bridge = new TestCodexBridge(
					bridge.nativeThreadId,
					bridge.nativeTurnId,
				);
				driver = await openDriverWithModelEndpoint(
					path,
					bridge,
					endpoint,
					(options) => {
						loopback = options.modelAccess;
					},
				);
				drivers.push(driver);
				expect(
					await driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("running");
			}
			if (!loopback) throw new Error("missing model access");
			const before = upstreamModels.length;
			const rejected = await modelRequest(loopback, bridge);
			expect(rejected.status).toBe(400);
			await rejected.text();
			expect(upstreamModels).toHaveLength(before);
			const allowed = await modelRequest(
				loopback,
				bridge,
				bridge.nativeTurnId,
				alternate,
			);
			expect(allowed.status).toBe(200);
			await allowed.text();
			expect(upstreamModels.slice(before)).toEqual(["gpt-5.2-codex"]);
		}
	});

	it.each(["running", "completed"] as const)(
		"keeps legacy %s records without a model binding fail closed or terminal-readable",
		async (status) => {
			const directory = await runtimeDirectory();
			const path = join(directory, "driver.json");
			let upstreamCalls = 0;
			const endpoint = await listen(
				createServer((_request, response) => {
					upstreamCalls += 1;
					response.end();
				}),
			);
			const bridge = new TestCodexBridge();
			const driver = await openDriverWithModelEndpoint(path, bridge, endpoint);
			drivers.push(driver);
			const command = submitCommand();
			const accepted = await driver.execute(command);
			if (status === "completed") {
				bridge.setTurnStatus("completed");
				expect(
					await driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed");
			}
			await driver.close();
			const stored = JSON.parse(
				await readFile(path, "utf8"),
			) as StoredCodexDriverState;
			for (const operation of Object.values(stored.operations))
				delete operation.internalModel;
			await writeFile(path, JSON.stringify(stored));
			const recoveredBridge = new TestCodexBridge(
				bridge.nativeThreadId,
				bridge.nativeTurnId,
			);
			const recovered = await openDriverWithModelEndpoint(
				path,
				recoveredBridge,
				endpoint,
			);
			drivers.push(recovered);
			const nativeRequests = recoveredBridge.requests.length;
			if (status === "running") {
				await expect(
					recovered.getStatus(accepted.nativeSessionRef, command.executionId),
				).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
				await expect(
					recovered.replayEvents(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
			} else {
				expect(
					await recovered.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed");
				expect((await recovered.execute(command)).result).toEqual({
					outcome: "accepted",
					status: "completed",
				});
			}
			expect(recoveredBridge.requests.slice(nativeRequests)).toEqual([]);
			expect(upstreamCalls).toBe(0);
		},
	);

	it.each([false, true])(
		"keeps running status polling authorized after restart=%s",
		async (restart) => {
			const directory = await runtimeDirectory();
			let upstreamCalls = 0;
			const endpoint = await listen(
				createServer((_request, response) => {
					upstreamCalls += 1;
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(completedEvent());
				}),
			);
			let bridge = new TestCodexBridge();
			let loopback: CodexModelAccess | undefined;
			let driver = await openDriverWithModelEndpoint(
				join(directory, "driver.json"),
				bridge,
				endpoint,
				(options) => {
					loopback = options.modelAccess;
				},
			);
			drivers.push(driver);
			const accepted = await driver.execute(submitCommand());
			if (restart) {
				await driver.close();
				bridge = new TestCodexBridge(
					bridge.nativeThreadId,
					bridge.nativeTurnId,
				);
				driver = await openDriverWithModelEndpoint(
					join(directory, "driver.json"),
					bridge,
					endpoint,
					(options) => {
						loopback = options.modelAccess;
					},
				);
				drivers.push(driver);
			}
			expect(
				await driver.getStatus(accepted.nativeSessionRef, "execution-codex"),
			).toBe("running");
			expect(
				await driver.getStatus(accepted.nativeSessionRef, "execution-codex"),
			).toBe("running");
			if (!loopback) throw new Error();
			const response = await modelRequest(loopback, bridge);
			expect(response.status).toBe(200);
			await response.text();
			expect(upstreamCalls).toBe(1);
		},
	);

	it.each(["replay", "subscribe"] as const)(
		"restores model admission when %s is the first operation after restart",
		async (entry) => {
			const directory = await runtimeDirectory();
			let upstreamCalls = 0;
			const endpoint = await listen(
				createServer((_request, response) => {
					upstreamCalls += 1;
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(completedEvent());
				}),
			);
			let bridge = new TestCodexBridge();
			let loopback: CodexModelAccess | undefined;
			let driver = await openDriverWithModelEndpoint(
				join(directory, "driver.json"),
				bridge,
				endpoint,
				(options) => {
					loopback = options.modelAccess;
				},
			);
			drivers.push(driver);
			const accepted = await driver.execute(submitCommand());
			await driver.close();
			bridge = new TestCodexBridge(bridge.nativeThreadId, bridge.nativeTurnId);
			driver = await openDriverWithModelEndpoint(
				join(directory, "driver.json"),
				bridge,
				endpoint,
				(options) => {
					loopback = options.modelAccess;
				},
			);
			drivers.push(driver);
			const abort = new AbortController();
			if (entry === "replay") {
				await driver.replayEvents(accepted.nativeSessionRef, "execution-codex");
			} else {
				await driver.subscribeEvents(
					accepted.nativeSessionRef,
					"execution-codex",
					undefined,
					abort.signal,
				);
				abort.abort();
			}
			if (!loopback) throw new Error();
			const response = await modelRequest(loopback, bridge);
			expect(response.status).toBe(200);
			await response.text();
			expect(upstreamCalls).toBe(1);
		},
	);

	it.each([false, true])(
		"does not readmit a resolved stop while native is running, restart=%s",
		async (restart) => {
			const directory = await runtimeDirectory();
			const path = join(directory, "driver.json");
			let upstreamCalls = 0;
			const endpoint = await listen(
				createServer((_request, response) => {
					upstreamCalls += 1;
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(completedEvent());
				}),
			);
			let bridge = new TestCodexBridge();
			let loopback: CodexModelAccess | undefined;
			const capture = (options: CodexAppServerBridgeOptions) => {
				loopback = options.modelAccess;
			};
			let driver = await openDriverWithModelEndpoint(
				path,
				bridge,
				endpoint,
				capture,
			);
			drivers.push(driver);
			const accepted = await driver.execute(submitCommand());
			await expect(
				driver.execute(stopCommand(accepted.nativeSessionRef)),
			).resolves.toMatchObject({
				result: { outcome: "accepted", status: "running" },
			});
			if (restart) {
				await driver.close();
				bridge = new TestCodexBridge(
					bridge.nativeThreadId,
					bridge.nativeTurnId,
				);
				driver = await openDriverWithModelEndpoint(
					path,
					bridge,
					endpoint,
					capture,
				);
				drivers.push(driver);
			}
			expect(
				await driver.getStatus(accepted.nativeSessionRef, "execution-codex"),
			).toBe("running");
			if (!loopback) throw new Error();
			expect((await modelRequest(loopback, bridge)).status).toBe(409);
			expect(upstreamCalls).toBe(0);
		},
	);

	it("cannot restore model access across a prepared stop and held status reads", async () => {
		const directory = await runtimeDirectory();
		let upstreamCalls = 0;
		const endpoint = await listen(
			createServer((_request, response) => {
				upstreamCalls += 1;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const bridge = new TestCodexBridge();
		bridge.completeOnInterrupt("interrupted");
		let loopback: CodexModelAccess | undefined;
		const driver = await openDriverWithModelEndpoint(
			join(directory, "driver.json"),
			bridge,
			endpoint,
			(options) => {
				loopback = options.modelAccess;
			},
		);
		drivers.push(driver);
		const accepted = await driver.execute(submitCommand());
		bridge.holdTurnsList();
		const first = driver
			.getStatus(accepted.nativeSessionRef, "execution-codex")
			.catch((error: unknown) => error);
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(1));
		const stopping = driver.execute(stopCommand(accepted.nativeSessionRef));
		void stopping.catch(() => {});
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(2));
		const fresh = driver
			.getStatus(accepted.nativeSessionRef, "execution-codex")
			.catch((error: unknown) => error);
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(3));
		bridge.respondToHeldTurnsListWithStatus("inProgress", 2);
		await fresh;
		bridge.respondToHeldTurnsListWithStatus("inProgress", 0);
		await first;
		if (!loopback) throw new Error();
		expect((await modelRequest(loopback, bridge)).status).toBe(409);
		expect(upstreamCalls).toBe(0);
		bridge.respondToHeldTurnsListWithStatus("inProgress");
		await vi.waitFor(() => expect(bridge.pendingTurnsListCount()).toBe(1));
		bridge.respondToHeldTurnsListWithStatus("interrupted");
		await expect(stopping).resolves.toMatchObject({
			result: { outcome: "accepted", status: "cancelled" },
		});
		expect(upstreamCalls).toBe(0);
	}, 10_000);

	it("fails closed for an out-of-order status that conflicts with a terminal read", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		bridge.holdTurnsList();
		const firstStatus = driver.getStatus(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const secondStatus = driver.getStatus(
			accepted.nativeSessionRef,
			command.executionId,
		);

		await vi.waitFor(() => {
			expect(bridge.pendingTurnsListCount()).toBe(2);
		});
		bridge.respondToHeldTurnsListWithStatus("completed", 1);
		expect(await secondStatus).toBe("completed");
		bridge.respondToHeldTurnsListWithStatus("inProgress");
		await expect(firstStatus).rejects.toMatchObject({
			code: "RUNTIME_CODEX_PROTOCOL_INVALID",
		});
		expect(
			(
				await driver.execute(
					submitCommand({
						operationId: "execution-codex-after-terminal",
						executionId: "execution-codex-after-terminal",
						turnId: "turn-codex-after-terminal",
						nativeSessionRef: accepted.nativeSessionRef,
					}),
				)
			).result,
		).toEqual({ outcome: "accepted", status: "running" });
	});

	it("returns a persisted terminal status without rereading native history", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		bridge.setTurnStatus("completed");
		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("completed");
		const reads = bridge.requests.filter(
			({ method }) => method === "thread/turns/list",
		).length;

		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("completed");
		expect(
			bridge.requests.filter(({ method }) => method === "thread/turns/list"),
		).toHaveLength(reads);
	});

	it("uses the validated bounded native status page", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.setTurnsListResult({
			data: [
				{
					id: bridge.nativeTurnId,
					status: "inProgress",
					items: [],
				},
			],
		});
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		expect(
			await driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).toBe("running");
		expect(
			bridge.requests.filter(({ method }) => method === "thread/turns/list"),
		).toHaveLength(1);
	});

	it.each([
		[-32_601, "list_turns is not supported yet"],
		[
			-32_600,
			"thread opaque is not materialized yet; thread/turns/list is unavailable before first user message",
		],
	] as const)(
		"retries a bounded native history read after initial paginated history reports %i",
		async (code, message) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			bridge.rejectNextTurnsList({
				code,
				message,
			});
			const driver = await openDriver(join(directory, "driver.json"), bridge);
			drivers.push(driver);
			const command = submitCommand();
			const accepted = await driver.execute(command);

			expect(
				await driver.getStatus(accepted.nativeSessionRef, command.executionId),
			).toBe("running");
			expect(
				bridge.requests.filter(({ method }) => method === "thread/turns/list"),
			).toHaveLength(2);
			expect(
				bridge.requests.filter(({ method }) => method === "thread/read"),
			).toHaveLength(0);
			expect(
				bridge.requests.filter(({ method }) => method === "turn/start"),
			).toHaveLength(1);
		},
	);

	it("fails closed for unrelated native thread/turns/list invalid requests", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.setTurnsListError({
			code: -32_600,
			message: "synthetic unrelated invalid request",
		});
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		await expect(
			driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_PROTOCOL_INVALID" });
		expect(
			bridge.requests.filter(({ method }) => method === "thread/turns/list"),
		).toHaveLength(1);
		expect(
			bridge.requests.filter(({ method }) => method === "thread/read"),
		).toHaveLength(0);
	});

	it.each([
		["a malformed page", { data: "invalid" }, "RUNTIME_CODEX_PROTOCOL_INVALID"],
		[
			"duplicate target Turns",
			{
				data: [
					{
						id: "codex-native-turn-private",
						status: "inProgress",
						items: [],
					},
					{
						id: "codex-native-turn-private",
						status: "completed",
						items: [],
					},
				],
			},
			"RUNTIME_CODEX_PROTOCOL_INVALID",
		],
		[
			"an unknown target status",
			{
				data: [
					{
						id: "codex-native-turn-private",
						status: "unknown",
						items: [],
					},
				],
			},
			"RUNTIME_CODEX_PROTOCOL_INVALID",
		],
		[
			"a malformed target Turn",
			{ data: [{ id: "codex-native-turn-private", status: "inProgress" }] },
			"RUNTIME_CODEX_PROTOCOL_INVALID",
		],
		["a missing target Turn", { data: [] }, "RUNTIME_CODEX_UNAVAILABLE"],
	] as const)(
		"fails closed for %s from the bounded native status page",
		async (_name, result, code) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			bridge.setTurnsListResult(result);
			const driver = await openDriver(join(directory, "driver.json"), bridge);
			drivers.push(driver);
			const command = submitCommand();
			const accepted = await driver.execute(command);

			await expect(
				driver.getStatus(accepted.nativeSessionRef, command.executionId),
			).rejects.toMatchObject({ code });
			expect(
				bridge.requests.filter(({ method }) => method === "turn/start"),
			).toHaveLength(1);
		},
	);

	it.each([
		[-32_601, "another native method is not supported"],
		[-32_600, "synthetic unrelated invalid request"],
	] as const)(
		"fails closed without retrying an unrelated native history error %i",
		async (code, message) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			bridge.rejectNextTurnsList({ code, message });
			const driver = await openDriver(join(directory, "driver.json"), bridge);
			drivers.push(driver);
			const command = submitCommand();
			const accepted = await driver.execute(command);

			await expect(
				driver.getStatus(accepted.nativeSessionRef, command.executionId),
			).rejects.toMatchObject({ code: "RUNTIME_CODEX_PROTOCOL_INVALID" });
			expect(
				bridge.requests.filter(({ method }) => method === "thread/turns/list"),
			).toHaveLength(1);
			expect(
				bridge.requests.filter(({ method }) => method === "turn/start"),
			).toHaveLength(1);
		},
	);

	it("fails closed when the exact native history error remains after turn/started", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.rejectNextTurnsList({
			code: -32601,
			message: "list_turns is not supported yet",
		});
		bridge.setTurnsListError({
			code: -32601,
			message: "list_turns is not supported yet",
		});
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		await expect(
			driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_PROTOCOL_INVALID" });
		expect(
			bridge.requests.filter(({ method }) => method === "thread/turns/list"),
		).toHaveLength(2);
		expect(
			bridge.requests.filter(({ method }) => method === "thread/read"),
		).toHaveLength(0);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
	});

	it("returns a matching persisted terminal notification when the second native history read races it", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		bridge.holdTurnsList();
		const path = join(directory, "driver.json");
		const driver = await openDriver(path, bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		const status = driver.getStatus(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const exactHistoryError = {
			code: -32_601,
			message: "list_turns is not supported yet",
		};

		await vi.waitFor(() => {
			expect(bridge.pendingTurnsListCount()).toBe(1);
		});
		bridge.respondToHeldTurnsListWithError(exactHistoryError);
		await vi.waitFor(() => {
			expect(bridge.pendingTurnsListCount()).toBe(1);
		});
		await bridge.emitTurnCompleted("completed");
		await vi.waitFor(async () => {
			expect(
				await persistedExecutionStatus(
					path,
					accepted.nativeSessionRef,
					command.executionId,
				),
			).toBe("completed");
		});
		bridge.respondToHeldTurnsListWithError(exactHistoryError);

		expect(await status).toBe("completed");
		expect(
			bridge.requests.filter(({ method }) => method === "thread/turns/list"),
		).toHaveLength(2);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(1);
		expect(
			bridge.requests.filter(({ method }) => method === "thread/read"),
		).toHaveLength(0);
	});

	it("recovers matching persisted terminal events when the second native history read races them", async () => {
		const directory = await runtimeDirectory();
		const path = join(directory, "driver.json");
		const firstBridge = new TestCodexBridge();
		const firstDriver = await openDriver(path, firstBridge);
		drivers.push(firstDriver);
		const command = submitCommand();
		const accepted = await firstDriver.execute(command);
		await firstDriver.close();

		const bridge = new TestCodexBridge(firstBridge.nativeThreadId);
		bridge.holdTurnsList();
		const driver = await openDriver(path, bridge);
		drivers.push(driver);
		const replay = driver.replayEvents(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const exactHistoryError = {
			code: -32_601,
			message: "list_turns is not supported yet",
		};

		await vi.waitFor(() => {
			expect(bridge.pendingTurnsListCount()).toBe(1);
		});
		bridge.respondToHeldTurnsListWithError(exactHistoryError);
		await bridge.emitNotification();
		await vi.waitFor(() => {
			expect(bridge.pendingTurnsListCount()).toBe(1);
		});
		await bridge.emitTurnCompleted("completed");
		await vi.waitFor(async () => {
			expect(
				await persistedExecutionStatus(
					path,
					accepted.nativeSessionRef,
					command.executionId,
				),
			).toBe("completed");
		});
		bridge.respondToHeldTurnsListWithError(exactHistoryError);

		expect(await replay).toContainEqual(
			expect.objectContaining({
				executionId: command.executionId,
				type: "completed",
				payload: { status: "completed" },
			}),
		);
		expect(
			bridge.requests.filter(({ method }) => method === "thread/turns/list"),
		).toHaveLength(2);
		expect(
			bridge.requests.filter(({ method }) => method === "turn/start"),
		).toHaveLength(0);
		expect(
			bridge.requests.filter(({ method }) => method === "thread/read"),
		).toHaveLength(0);
	});

	it.each([
		[
			"a wrong Thread",
			"wrong-native-thread-private",
			"codex-native-turn-private",
		],
		[
			"a wrong Turn",
			"codex-native-thread-private",
			"wrong-native-turn-private",
		],
	] as const)(
		"fails closed when the second native history read follows %s terminal notification",
		async (_name, threadId, nativeTurnId) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			bridge.holdTurnsList();
			const driver = await openDriver(join(directory, "driver.json"), bridge);
			drivers.push(driver);
			const command = submitCommand();
			const accepted = await driver.execute(command);
			const status = driver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const exactHistoryError = {
				code: -32_601,
				message: "list_turns is not supported yet",
			};

			await vi.waitFor(() => {
				expect(bridge.pendingTurnsListCount()).toBe(1);
			});
			bridge.respondToHeldTurnsListWithError(exactHistoryError);
			await vi.waitFor(() => {
				expect(bridge.pendingTurnsListCount()).toBe(1);
			});
			await bridge.emitFrame({
				method: "turn/completed",
				params: {
					threadId,
					turn: { id: nativeTurnId, status: "completed", items: [] },
				},
			});
			bridge.respondToHeldTurnsListWithError(exactHistoryError);

			await expect(status).rejects.toMatchObject({
				code: "RUNTIME_CODEX_PROTOCOL_INVALID",
			});
			expect(
				bridge.requests.filter(({ method }) => method === "thread/turns/list"),
			).toHaveLength(2);
			expect(
				bridge.requests.filter(({ method }) => method === "thread/read"),
			).toHaveLength(0);
		},
	);

	it.each(["malformed", "unrelated error"] as const)(
		"fails closed when the second native history read is %s after a terminal notification",
		async (response) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			bridge.holdTurnsList();
			const path = join(directory, "driver.json");
			const driver = await openDriver(path, bridge);
			drivers.push(driver);
			const command = submitCommand();
			const accepted = await driver.execute(command);
			const status = driver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const exactHistoryError = {
				code: -32_601,
				message: "list_turns is not supported yet",
			};

			await vi.waitFor(() => {
				expect(bridge.pendingTurnsListCount()).toBe(1);
			});
			bridge.respondToHeldTurnsListWithError(exactHistoryError);
			await vi.waitFor(() => {
				expect(bridge.pendingTurnsListCount()).toBe(1);
			});
			await bridge.emitTurnCompleted("completed");
			await vi.waitFor(async () => {
				expect(
					await persistedExecutionStatus(
						path,
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed");
			});
			if (response === "malformed") {
				bridge.respondToHeldTurnsListWithInvalidData();
			} else {
				bridge.respondToHeldTurnsListWithError({
					code: -32_600,
					message: "synthetic unrelated invalid request",
				});
			}

			await expect(status).rejects.toMatchObject({
				code: "RUNTIME_CODEX_PROTOCOL_INVALID",
			});
			expect(
				bridge.requests.filter(({ method }) => method === "thread/turns/list"),
			).toHaveLength(2);
			expect(
				bridge.requests.filter(({ method }) => method === "thread/read"),
			).toHaveLength(0);
		},
	);

	it("keeps polling after a persisted app-server notification", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);

		await bridge.emitNotification();
		await vi.waitFor(async () => {
			expect(
				await driver.getStatus(accepted.nativeSessionRef, command.executionId),
			).toBe("running");
		});
	});

	it.each([
		["dynamic delegated Tool", "item/tool/call"],
		["MCP elicitation", "mcpServer/elicitation/request"],
	] as const)(
		"contains a native %s request without calling a provider or exposing its parameters",
		async (_name, method) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			const driver = await openDriver(join(directory, "driver.json"), bridge);
			drivers.push(driver);

			bridge.emitServerRequest(method, {
				connectionCredential: "connection-credential-private",
			});
			await vi.waitFor(() => {
				expect(bridge.responses).toContainEqual({
					id: "native-tool-request-private",
					error: {
						code: -32_001,
						message: "Platform delegated tools are unavailable",
					},
				});
			});

			expect(bridge.isClosed()).toBe(false);
			expect(
				bridge.requests.map(({ method: requestMethod }) => requestMethod),
			).toEqual(["initialize", "config/read"]);
			expect(JSON.stringify(bridge.responses)).not.toContain(
				"connection-credential-private",
			);
			expect(
				await readFile(join(directory, "driver.json"), "utf8"),
			).not.toContain("connection-credential-private");
			expect(await driver.getCapabilities()).toMatchObject({
				connection: false,
			});
		},
	);

	it.each([
		[
			"schema version",
			{
				schemaVersion: 2,
				sessions: {},
				operations: {},
			},
		],
		[
			"Session shape",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session": {
						nativeSessionRef: "opaque-session",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						threadId: "codex-native-thread-private",
						executions: [],
					},
				},
				operations: {},
			},
		],
		[
			"execution shape",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session": {
						nativeSessionRef: "opaque-session",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						threadId: "codex-native-thread-private",
						activeExecutionId: "execution-codex",
						executions: {
							"execution-codex": {
								executionId: "execution-codex",
								turnId: "turn-codex",
								nativeTurnId: "codex-native-turn-private",
								status: "idle",
							},
						},
					},
				},
				operations: {},
			},
		],
		[
			"unbacked active execution",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session": {
						nativeSessionRef: "opaque-session",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						threadId: "codex-native-thread-private",
						activeExecutionId: "execution-codex",
						executions: {
							"execution-codex": {
								executionId: "execution-codex",
								turnId: "turn-codex",
								nativeTurnId: "codex-native-turn-private",
								status: "running",
							},
						},
					},
				},
				operations: {},
			},
		],
		[
			"execution without a native thread",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session": {
						nativeSessionRef: "opaque-session",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						executions: {
							"execution-codex": {
								executionId: "execution-codex",
								turnId: "turn-codex",
								nativeTurnId: "codex-native-turn-private",
								status: "completed",
							},
						},
					},
				},
				operations: {
					'["agent-codex","conversation-codex",1,"submit-turn","execution-codex"]':
						{
							state: "resolved",
							nativeSessionRef: "opaque-session",
							record: {
								schemaVersion: 1,
								agentId: "agent-codex",
								conversationId: "conversation-codex",
								sessionGeneration: 1,
								kind: "submit-turn",
								operationId: "execution-codex",
								nativeSessionRef: "opaque-session",
								result: { outcome: "accepted", status: "completed" },
							},
						},
				},
			},
		],
		[
			"duplicate native thread",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session-one": {
						nativeSessionRef: "opaque-session-one",
						agentId: "agent-codex-one",
						conversationId: "conversation-codex-one",
						sessionGeneration: 1,
						threadId: "codex-native-thread-duplicate",
						executions: {},
					},
					"opaque-session-two": {
						nativeSessionRef: "opaque-session-two",
						agentId: "agent-codex-two",
						conversationId: "conversation-codex-two",
						sessionGeneration: 1,
						threadId: "codex-native-thread-duplicate",
						executions: {},
					},
				},
				operations: {},
			},
		],
		[
			"duplicate native Turn",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session": {
						nativeSessionRef: "opaque-session",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						threadId: "codex-native-thread-private",
						activeExecutionId: "execution-codex-running",
						executions: {
							"execution-codex-completed": {
								executionId: "execution-codex-completed",
								turnId: "turn-codex-completed",
								nativeTurnId: "codex-native-turn-duplicate",
								status: "completed",
							},
							"execution-codex-running": {
								executionId: "execution-codex-running",
								turnId: "turn-codex-running",
								nativeTurnId: "codex-native-turn-duplicate",
								status: "running",
							},
						},
					},
				},
				operations: {
					'["agent-codex","conversation-codex",1,"submit-turn","execution-codex-completed"]':
						{
							state: "resolved",
							nativeSessionRef: "opaque-session",
							record: {
								schemaVersion: 1,
								agentId: "agent-codex",
								conversationId: "conversation-codex",
								sessionGeneration: 1,
								kind: "submit-turn",
								operationId: "execution-codex-completed",
								nativeSessionRef: "opaque-session",
								result: { outcome: "accepted", status: "completed" },
							},
						},
					'["agent-codex","conversation-codex",1,"submit-turn","execution-codex-running"]':
						{
							state: "resolved",
							nativeSessionRef: "opaque-session",
							record: {
								schemaVersion: 1,
								agentId: "agent-codex",
								conversationId: "conversation-codex",
								sessionGeneration: 1,
								kind: "submit-turn",
								operationId: "execution-codex-running",
								nativeSessionRef: "opaque-session",
								result: { outcome: "accepted", status: "running" },
							},
						},
				},
			},
		],
		[
			"unbound prepared operation key",
			{
				schemaVersion: 1,
				sessions: {
					"opaque-session": {
						nativeSessionRef: "opaque-session",
						agentId: "agent-codex",
						conversationId: "conversation-codex",
						sessionGeneration: 1,
						executions: {},
					},
				},
				operations: {
					'["agent-other","conversation-other",1,"submit-turn","operation-other"]':
						{
							state: "prepared",
							nativeSessionRef: "opaque-session",
						},
				},
			},
		],
	] as const)(
		"fails closed without replacing corrupted durable %s",
		async (_name, state) => {
			const directory = await runtimeDirectory();
			const path = join(directory, "driver.json");
			const contents = JSON.stringify(state);
			await writeFile(path, contents);
			const bridge = new TestCodexBridge();

			await expect(openDriver(path, bridge)).rejects.toMatchObject({
				code: "RUNTIME_CODEX_STATE_INVALID",
			});
			expect(bridge.requests).toEqual([]);
			expect(await readFile(path, "utf8")).toBe(contents);
		},
	);

	it.each(["error", "missing-result"] as const)(
		"fails all pending requests for a malformed thread/turns/list %s response",
		async (kind) => {
			const directory = await runtimeDirectory();
			const bridge = new TestCodexBridge();
			const driver = await openDriver(join(directory, "driver.json"), bridge);
			drivers.push(driver);
			const command = submitCommand();
			const accepted = await driver.execute(command);
			bridge.holdTurnsList();
			const first = driver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const second = driver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			);

			await vi.waitFor(() => {
				expect(bridge.pendingTurnsListCount()).toBe(2);
			});
			bridge.respondToHeldTurnsList(kind);
			await expect(first).rejects.toMatchObject({
				code: "RUNTIME_CODEX_PROTOCOL_INVALID",
			});
			await expect(second).rejects.toMatchObject({
				code: "RUNTIME_CODEX_PROTOCOL_INVALID",
			});
		},
	);

	it("fails all pending requests for a structurally invalid thread/turns/list result", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		bridge.holdTurnsList();
		const first = driver.getStatus(
			accepted.nativeSessionRef,
			command.executionId,
		);
		const second = driver.getStatus(
			accepted.nativeSessionRef,
			command.executionId,
		);

		await vi.waitFor(() => {
			expect(bridge.pendingTurnsListCount()).toBe(2);
		});
		bridge.respondToHeldTurnsListWithInvalidData();
		await expect(first).rejects.toMatchObject({
			code: "RUNTIME_CODEX_PROTOCOL_INVALID",
		});
		await expect(second).rejects.toMatchObject({
			code: "RUNTIME_CODEX_PROTOCOL_INVALID",
		});
	});

	it("fails all pending requests when a thread/turns/list response times out", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		bridge.holdTurnsList();
		vi.useFakeTimers();
		const failures: unknown[] = [];
		void driver
			.getStatus(accepted.nativeSessionRef, command.executionId)
			.catch((error: unknown) => failures.push(error));
		void driver
			.getStatus(accepted.nativeSessionRef, command.executionId)
			.catch((error: unknown) => failures.push(error));

		await vi.advanceTimersByTimeAsync(30_000);

		expect(failures).toHaveLength(2);
		for (const failure of failures) {
			expect(failure).toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
		}
		expect(bridge.isClosed()).toBe(true);
	});

	it("does not leave an unhandled rejection when a request send times out", async () => {
		const directory = await runtimeDirectory();
		const bridge = new TestCodexBridge();
		const driver = await openDriver(join(directory, "driver.json"), bridge);
		drivers.push(driver);
		const command = submitCommand();
		const accepted = await driver.execute(command);
		bridge.holdTurnsListRequestSend();
		vi.useFakeTimers();
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const status = driver.getStatus(
				accepted.nativeSessionRef,
				command.executionId,
			);
			const outcome = status.then(
				() => undefined,
				(error: unknown) => error,
			);
			await vi.advanceTimersByTimeAsync(30_000);

			expect(await outcome).toMatchObject({
				code: "RUNTIME_CODEX_UNAVAILABLE",
			});
			await Promise.resolve();
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
