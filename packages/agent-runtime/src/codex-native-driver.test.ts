import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	type FileHandle,
	mkdtemp,
	open,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	RuntimeDriverCommandV1,
	RuntimeOperationFactV2,
} from "@agent-infra/contracts/runtime";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCallbackCorpusBytes } from "../../../deploy/runtime/vendor/codex/callback-corpus.mjs";
import {
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
	codexConversationKey,
	runCodexConnectionRecovery,
} from "./codex-app-server-bridge.js";
import { codexCallbackSchema } from "./codex-callback-schema.generated.js";
import type {
	CodexConnectionBootstrapRequest,
	CodexConnectionBootstrapResponse,
	CodexConnectionEvidence,
	CodexConnectionEvidenceUpdateRequest,
	CodexConnectionEvidenceUpdateResponse,
	CodexConnectionOperationRequest,
	CodexConnectionOperationResponse,
	CodexConnectionOrigin,
	CodexConnectionRecoveryRequest,
} from "./codex-connection-client.js";
import { isCodexConnectionClientConfiguration } from "./codex-connection-client.js";
import type {
	CodexNativeAttemptIdentityV1,
	CodexNativeCallbackRequestV1,
	CodexNativeCallbackResponseV1,
	CodexNativeSourceRequestV1,
	CodexNativeSourceV1,
} from "./codex-native-callback.js";
import {
	CodexRuntimeDriver,
	type CodexRuntimeDriverOptions,
} from "./codex-runtime-driver.js";
import type { RuntimeOriginalEvidenceReadContext } from "./driver.js";
import { DurableJsonFile } from "./durable-json.js";
import { RuntimeHostError } from "./errors.js";

type SubmitCommand = Extract<RuntimeDriverCommandV1, { kind: "submit-turn" }>;
type Authorize = NonNullable<
	CodexRuntimeDriverOptions["authorizeExternalAction"]
>;
type Permit = Extract<CodexNativeCallbackResponseV1, { decision: "permit" }>;
type Intent = Extract<CodexNativeCallbackRequestV1, { phase: "intent" }>;
type Started = Extract<CodexNativeCallbackRequestV1, { phase: "started" }>;

interface NativeState {
	threadId: string;
	turnId: string;
	turnStarts: number;
	status: "inProgress" | "completed";
	sources: Map<string, { turnId: string; status: "inProgress" | "completed" }>;
}

// Exercise production openWithBridge binding: each Conversation has its own
// transport and nativeCallback closure, including after a Driver restart.
class ScriptedTransport {
	readonly methods: string[] = [];
	readonly requests: { method: string; params: unknown }[] = [];
	readonly terminations: unknown[] = [];
	background: { itemId: string; processId: string }[] = [];
	readonly backgroundByThread = new Map<
		string,
		{ itemId: string; processId: string }[]
	>();
	private readonly queued: {
		frame: CodexAppServerFrame;
		consumed?: () => void;
	}[] = [];
	private readonly lifetime = new AbortController();
	private wake?: () => void;
	private closed = false;

	constructor(
		readonly options: CodexAppServerBridgeOptions,
		readonly native: NativeState,
		private readonly hooks: {
			beforeThreadStart?: (bridge: ScriptedTransport) => Promise<void>;
			configuration?: (value: Record<string, unknown>) => void;
		} = {},
	) {}

	async send(frame: CodexAppServerFrame) {
		if (typeof frame.id !== "number" || typeof frame.method !== "string")
			throw new Error("Unexpected scripted native request");
		this.methods.push(frame.method);
		this.requests.push({ method: frame.method, params: frame.params });
		const params = frame.params as { threadId?: string };
		const reply = (result: unknown) => this.push({ id: frame.id, result });
		switch (frame.method) {
			case "initialize":
				reply({});
				return;
			case "config/read": {
				const origin = { name: { type: "sessionFlags" }, version: "1" };
				const provider = this.options.modelAccess
					? {
							name: "Agent Infra Active Model",
							base_url: this.options.modelAccess.endpoint,
							env_key: "AGENT_INFRA_CODEX_MODEL_CREDENTIAL",
							wire_api: "responses",
							requires_openai_auth: false,
							supports_websockets: false,
							request_max_retries: 0,
							stream_max_retries: 0,
						}
					: undefined;
				const configuration = {
					config: {
						model: this.options.model,
						model_reasoning_effort: this.options.reasoningEffort,
						mcp_servers: this.options.connectionProfile
							? {
									connection: {
										url: this.options.connectionProfile.resource,
										environment_id: "local",
										enabled: true,
										tool_timeout_sec: null,
									},
								}
							: {},
						plugins: {},
						marketplaces: {},
						features: { plugins: false },
						...(provider
							? {
									model_provider: "agent_infra",
									model_providers: {
										agent_infra: {
											...provider,
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
										},
									},
								}
							: {}),
					},
					origins: {
						model: origin,
						model_reasoning_effort: origin,
						"features.plugins": origin,
						...(this.options.connectionProfile
							? { "mcp_servers.connection.url": origin }
							: {}),
						...(provider
							? {
									model_provider: origin,
									...Object.fromEntries(
										Object.keys(provider).map((key) => [
											`model_providers.agent_infra.${key}`,
											origin,
										]),
									),
								}
							: {}),
					},
				};
				this.hooks.configuration?.(configuration.config);
				reply(configuration);
				return;
			}
			case "model/list":
				reply({
					data: [
						{
							model: "gpt-5.3-codex",
							supportedReasoningEfforts: [{ reasoningEffort: "high" }],
						},
					],
					nextCursor: null,
				});
				return;
			case "thread/start":
			case "thread/resume":
				await this.hooks.beforeThreadStart?.(this);
				reply({ thread: { id: this.native.threadId } });
				return;
			case "turn/start":
				this.native.turnStarts += 1;
				this.native.turnId = `native-turn-${this.native.turnStarts}`;
				this.native.status = "inProgress";
				reply({ turn: { id: this.native.turnId, status: this.native.status } });
				this.push({
					method: "turn/started",
					params: {
						threadId: this.native.threadId,
						turn: { id: this.native.turnId, status: "inProgress", items: [] },
					},
				});
				return;
			case "thread/turns/list": {
				const source =
					params.threadId === this.native.threadId
						? this.native
						: this.native.sources.get(params.threadId ?? "");
				if (!source) throw new Error("Query for an unknown native source");
				reply({
					data: [{ id: source.turnId, status: source.status, items: [] }],
					nextCursor: null,
				});
				return;
			}
			case "thread/items/list":
				reply({ data: [], nextCursor: null });
				return;
			case "turn/interrupt":
				reply({});
				return;
			case "thread/backgroundTerminals/list":
				reply({
					data:
						params.threadId === this.native.threadId
							? this.background
							: (this.backgroundByThread.get(params.threadId ?? "") ?? []),
					nextCursor: null,
				});
				return;
			case "thread/backgroundTerminals/terminate":
				this.terminations.push(frame.params);
				reply({ terminated: true });
				return;
		}
		throw new Error(`Unexpected scripted native method: ${frame.method}`);
	}

	async *frames(): AsyncIterable<CodexAppServerFrame> {
		while (!this.closed) {
			const next = this.queued.shift();
			if (!next) {
				await new Promise<void>((resolve) => {
					this.wake = resolve;
				});
				continue;
			}
			try {
				yield next.frame;
			} finally {
				next.consumed?.();
			}
		}
	}

	async close() {
		this.closed = true;
		this.lifetime.abort();
		this.wake?.();
	}

	async callback(
		request: CodexNativeCallbackRequestV1,
	): Promise<CodexNativeCallbackResponseV1> {
		if (!this.options.nativeCallback)
			throw new Error("Missing native callback");
		const response = await this.options.nativeCallback(
			request,
			this.lifetime.signal,
		);
		if (response.schemaVersion !== 1)
			throw new Error("Unexpected callback version");
		return response;
	}

	async connectionCallback(
		request: CodexConnectionOperationRequest,
	): Promise<CodexConnectionOperationResponse>;
	async connectionCallback(
		request: CodexConnectionEvidenceUpdateRequest,
	): Promise<CodexConnectionEvidenceUpdateResponse>;
	async connectionCallback(
		request:
			| CodexConnectionOperationRequest
			| CodexConnectionEvidenceUpdateRequest,
	) {
		if (!this.options.nativeCallback)
			throw new Error("Missing native callback");
		const response = await this.options.nativeCallback(
			request,
			this.lifetime.signal,
		);
		if (response.schemaVersion !== 2)
			throw new Error("Unexpected callback version");
		return response;
	}

	bootstrap(request: CodexConnectionBootstrapRequest) {
		if (!this.options.nativeConnectionBootstrap)
			throw new Error("Missing Connection bootstrap");
		return this.options.nativeConnectionBootstrap(
			request,
			this.lifetime.signal,
		);
	}

	registerSource(source: CodexNativeSourceV1) {
		this.native.sources.set(source.threadId, {
			turnId: source.turnId,
			status: "inProgress",
		});
	}

	completeSource(source: CodexNativeSourceV1) {
		const current = this.native.sources.get(source.threadId);
		if (!current || current.turnId !== source.turnId)
			throw new Error("Completion for an unknown native source");
		current.status = "completed";
	}

	completeInferenceTurn() {
		this.native.status = "completed";
		return new Promise<void>((resolve) => {
			this.push(
				{
					method: "turn/completed",
					params: {
						threadId: this.native.threadId,
						turn: { id: this.native.turnId, status: "completed", items: [] },
					},
				},
				resolve,
			);
		});
	}

	private push(frame: CodexAppServerFrame, consumed?: () => void) {
		this.queued.push({ frame, ...(consumed ? { consumed } : {}) });
		const wake = this.wake;
		this.wake = undefined;
		wake?.();
	}
}

class BoundDriver extends CodexRuntimeDriver {
	override launchConnectionRecovery(
		options: Parameters<typeof runCodexConnectionRecovery>[0],
	) {
		return super.launchConnectionRecovery(options);
	}
	static openBound(
		options: CodexRuntimeDriverOptions,
		factory: (
			options: CodexAppServerBridgeOptions,
		) => Promise<ScriptedTransport>,
	) {
		return BoundDriver.openWithBridge(options, factory);
	}
}

interface Journal {
	events: (
		| { type: "operation"; payload: RuntimeOperationFactV2 }
		| { type: "status" | "completed"; payload: { status: string } }
	)[];
	externalActionsBlocked?: true;
	nativeToolAttempts?: Record<
		string,
		{
			identity: CodexNativeAttemptIdentityV1;
			connectionOrigin?: CodexConnectionOrigin;
			connectionRequest?: CodexConnectionOperationRequest["connectionRequest"];
			connectionEvidence?: CodexConnectionEvidence;
			connectionEvidenceUpdates?: { requestId: string; fingerprint: string }[];
			intentFingerprint: string;
			permitId?: string;
		}
	>;
	nativeSources?: Record<
		string,
		{ source?: { threadId: string; turnId: string } }
	>;
}
interface SavedState {
	sessions: Record<
		string,
		{
			activeExecutionId?: string;
			executions: Record<string, { status: string }>;
			journals: Record<string, Journal>;
		}
	>;
}

const directories: string[] = [];
const drivers: CodexRuntimeDriver[] = [];
const servers: Server[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(drivers.splice(0).map((driver) => driver.close()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

function command(label = "alpha"): SubmitCommand {
	return {
		schemaVersion: 1,
		kind: "submit-turn",
		operationId: `execution-${label}`,
		agentId: "agent-synthetic",
		conversationId: `conversation-${label}`,
		executionId: `execution-${label}`,
		turnId: `turn-${label}`,
		sessionGeneration: 1,
		input: { text: "synthetic native callback input", attachments: [] },
	};
}

async function setup(
	authorize: Authorize = async () => {},
	endpoint?: string,
	connectionClient?: CodexRuntimeDriverOptions["connectionClient"],
	hooks: ConstructorParameters<typeof ScriptedTransport>[2] = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "codex-native-driver-"));
	directories.push(directory);
	const path = join(directory, "driver.json");
	const natives = new Map<string, NativeState>();
	const bridges = new Map<string, ScriptedTransport>();
	const options: CodexRuntimeDriverOptions = {
		path,
		configVersion: "synthetic-config",
		defaultModelOptionId: "synthetic-model",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "synthetic-model",
				model: "gpt-5.3-codex",
				reasoningLevels: ["high"],
				...(endpoint
					? { endpoint, credential: "synthetic-source-model-credential" }
					: {}),
			},
		],
		authorizeExternalAction: authorize,
		...(connectionClient ? { connectionClient } : {}),
	};
	const reopen = async () => {
		const driver = await BoundDriver.openBound(options, async (options) => {
			let native = natives.get(options.conversationKey);
			if (!native) {
				native = {
					threadId: `native-thread-${options.conversationKey}`,
					turnId: "native-turn-1",
					turnStarts: 0,
					status: "inProgress",
					sources: new Map(),
				};
				natives.set(options.conversationKey, native);
			}
			const bridge = new ScriptedTransport(options, native, hooks);
			bridges.set(options.conversationKey, bridge);
			return bridge;
		});
		drivers.push(driver);
		return driver;
	};
	const driver = await reopen();
	const saved = async (): Promise<SavedState> =>
		JSON.parse(await readFile(path, "utf8"));
	const bridgeFor = (input: SubmitCommand) => {
		const bridge = bridges.get(codexConversationKey(input));
		if (!bridge) throw new Error("Missing original Conversation transport");
		return bridge;
	};
	const start = async (label = "alpha") => {
		const input = command(label);
		const record = await driver.execute(input);
		expect(record.result).toMatchObject({
			outcome: "accepted",
			status: "running",
		});
		return {
			command: input,
			nativeSessionRef: record.nativeSessionRef,
			bridge: bridgeFor(input),
		};
	};
	return { directory, path, driver, saved, bridgeFor, start, reopen, bridges };
}

type Execution = Awaited<
	ReturnType<Awaited<ReturnType<typeof setup>>["start"]>
>;

function intent(
	bridge: ScriptedTransport,
	identity: Partial<CodexNativeAttemptIdentityV1> = {},
): Intent {
	return {
		schemaVersion: 1,
		requestId: randomUUID(),
		phase: "intent",
		occurredAt: Date.now(),
		identity: {
			sessionId: bridge.native.threadId,
			turnId: bridge.native.turnId,
			callId: randomUUID(),
			attemptRef: randomUUID(),
			toolName: "exec_command",
			...identity,
		},
	};
}

async function permit(bridge: ScriptedTransport, request = intent(bridge)) {
	const response = await bridge.callback(request);
	if (response.decision !== "permit")
		throw new Error("Expected permitted fixture attempt");
	expect(response.sourceOwner).toEqual({
		rootThreadId: bridge.native.threadId,
		rootTurnId: bridge.native.turnId,
	});
	return { request, response };
}

function started(request: Intent, response: Permit): Started {
	return {
		...request,
		requestId: randomUUID(),
		phase: "started",
		permitId: response.permitId,
		occurredAt: Date.now(),
	};
}

function completed(
	request: Started,
): Extract<CodexNativeCallbackRequestV1, { phase: "outcome" }> {
	return {
		...request,
		requestId: randomUUID(),
		phase: "outcome",
		outcome: "completed",
		occurredAt: request.occurredAt + 1,
	};
}

function journal(state: SavedState, execution: Execution) {
	const value =
		state.sessions[execution.nativeSessionRef]?.journals[
			execution.bridge.native.turnId
		];
	if (!value) throw new Error("Missing original native journal");
	return value;
}

function facts(state: SavedState, execution: Execution) {
	return journal(state, execution).events.flatMap((event) =>
		event.type === "operation" ? [event.payload] : [],
	);
}

type SourceReserve = Extract<
	CodexNativeSourceRequestV1,
	{ phase: "source-reserve" }
>;
type SourceBind = Extract<CodexNativeSourceRequestV1, { phase: "source-bind" }>;

function reserveSource(
	parent: Awaited<ReturnType<typeof permit>>,
	childThreadId = "native-child-thread",
	submissionId = "native-child-submission",
): SourceReserve {
	return {
		schemaVersion: 1,
		requestId: randomUUID(),
		phase: "source-reserve",
		occurredAt: Date.now(),
		reservation: {
			reservationId: randomUUID(),
			parent: parent.request.identity,
			parentPermitId: parent.response.permitId,
			childThreadId,
			submissionId,
		},
	};
}

function bindSource(reserve: SourceReserve): SourceBind {
	return {
		...reserve,
		requestId: randomUUID(),
		phase: "source-bind",
		delivery: "started",
		source: {
			threadId: reserve.reservation.childThreadId,
			turnId: reserve.reservation.submissionId,
		},
	};
}

function terminalSource(
	bind: SourceBind,
	nativeStatus: "completed" | "failed" | "cancelled" = "completed",
): Extract<CodexNativeSourceRequestV1, { phase: "source-terminal" }> {
	return {
		schemaVersion: 1,
		requestId: randomUUID(),
		phase: "source-terminal",
		occurredAt: Date.now(),
		reservation: bind.reservation,
		source: bind.source,
		nativeStatus,
	};
}

async function sourceAck(
	bridge: ScriptedTransport,
	request: CodexNativeSourceRequestV1,
) {
	const response = await bridge.callback(request);
	expect(response).toEqual({
		schemaVersion: 1,
		requestId: request.requestId,
		phase: request.phase,
		request,
		decision: "ack",
		...(request.phase === "source-reserve" || request.phase === "source-bind"
			? {
					sourceOwner: {
						rootThreadId: bridge.native.threadId,
						rootTurnId: bridge.native.turnId,
					},
				}
			: {}),
	});
	return response;
}

async function startChild(execution: Execution) {
	const parent = await permit(
		execution.bridge,
		intent(execution.bridge, { toolName: "spawn_agent" }),
	);
	const parentStarted = started(parent.request, parent.response);
	await execution.bridge.callback(parentStarted);
	const reserve = reserveSource(parent);
	await sourceAck(execution.bridge, reserve);
	const bind = bindSource(reserve);
	execution.bridge.registerSource(bind.source);
	await sourceAck(execution.bridge, bind);
	return { parent, parentStarted, reserve, bind };
}

function stopCommand(execution: Execution): RuntimeDriverCommandV1 {
	return {
		schemaVersion: 1,
		kind: "stop",
		operationId: `stop-${execution.command.executionId}`,
		agentId: execution.command.agentId,
		conversationId: execution.command.conversationId,
		sessionGeneration: execution.command.sessionGeneration,
		executionId: execution.command.executionId,
		turnId: execution.command.turnId,
		nativeSessionRef: execution.nativeSessionRef,
	};
}

async function sourceModelEndpoint() {
	const calls: string[] = [];
	const server = createServer((request, response) => {
		calls.push(request.url ?? "");
		request.resume();
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(
			`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: "synthetic-source-response", status: "completed" },
			})}\n\n`,
		);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing model endpoint");
	return { calls, endpoint: `http://127.0.0.1:${address.port}/v1` };
}

async function sourceModelRequest(
	credentialOwner: ScriptedTransport,
	source: CodexNativeSourceV1,
) {
	const access = credentialOwner.options.modelAccess;
	if (!access) throw new Error("Missing native model access");
	const response = await fetch(`${access.endpoint}/responses`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${access.credential}`,
			"x-client-request-id": source.threadId,
			"x-codex-turn-metadata": JSON.stringify({
				thread_id: source.threadId,
				turn_id: source.turnId,
			}),
		},
		body: JSON.stringify({
			model: credentialOwner.options.model,
			stream: true,
		}),
	});
	await response.text();
	return response.status;
}

async function holdDirectorySync(directory: string) {
	const handle = await open(directory, "r");
	const prototype = Object.getPrototypeOf(handle) as FileHandle;
	await handle.close();
	const sync = prototype.sync;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let held = false;
	const mocked = vi.spyOn(prototype, "sync").mockImplementation(async function (
		this: FileHandle,
	) {
		if (!held && (await this.stat()).isDirectory()) {
			held = true;
			entered.resolve();
			await release.promise;
		}
		return sync.call(this);
	});
	return {
		entered: entered.promise,
		release: release.resolve,
		restore: () => mocked.mockRestore(),
	};
}

describe("Codex native Driver callbacks with production Conversation binding", () => {
	it("durably saves intent before invoking Host authorization or returning a permit", async () => {
		const entered = Promise.withResolvers<Parameters<Authorize>[0]>();
		const authorized = Promise.withResolvers<void>();
		const authorize = vi.fn<Authorize>(async (action) => {
			entered.resolve(action);
			await authorized.promise;
		});
		const env = await setup(authorize);
		const execution = await env.start();
		const request = intent(execution.bridge);
		const sync = await holdDirectorySync(env.directory);
		const response = execution.bridge.callback(request);
		let replied = false;
		void response.then(() => {
			replied = true;
		});
		try {
			await sync.entered;
			expect(authorize).not.toHaveBeenCalled();
			expect(replied).toBe(false);
			sync.release();
			const action = await entered.promise;
			const savedFacts = facts(await env.saved(), execution);
			expect(savedFacts).toMatchObject([
				{
					kind: "tool",
					phase: "intent",
					operationRef: action.operationRef,
					attemptRef: action.attemptRef,
				},
			]);
			expect(action).toMatchObject({
				nativeSessionRef: execution.nativeSessionRef,
				executionId: execution.command.executionId,
				runtimeOperationId: execution.command.operationId,
			});
			expect(replied).toBe(false);
			await expect(
				env.driver.getStatus(
					execution.nativeSessionRef,
					execution.command.executionId,
				),
			).resolves.toBe("running");
			authorized.resolve();
			await expect(response).resolves.toMatchObject({
				decision: "permit",
				requestId: request.requestId,
				identity: request.identity,
			});
		} finally {
			sync.release();
			authorized.resolve();
			await response.catch(() => {});
			sync.restore();
		}
	});

	it("withholds outcome ACK until the result and receipt are durable", async () => {
		const env = await setup();
		const execution = await env.start();
		const allowed = await permit(execution.bridge);
		const begin = started(allowed.request, allowed.response);
		await execution.bridge.callback(begin);
		const result = completed(begin);
		const sync = await holdDirectorySync(env.directory);
		const ack = execution.bridge.callback(result);
		let replied = false;
		void ack.then(() => {
			replied = true;
		});
		try {
			await sync.entered;
			expect(replied).toBe(false);
			sync.release();
			await expect(ack).resolves.toMatchObject({
				decision: "ack",
				requestId: result.requestId,
			});
			expect(
				facts(await env.saved(), execution).map((fact) => fact.phase),
			).toEqual(["intent", "started", "completed"]);
		} finally {
			sync.release();
			await ack.catch(() => {});
			sync.restore();
		}
	});

	it.each(["denied", "unavailable"] as const)(
		"persists authorization %s and replays that denial without reauthorizing",
		async (failure) => {
			const authorize = vi.fn<Authorize>(async () => {
				throw failure === "denied"
					? new RuntimeHostError(
							"RUNTIME_GRANT_INVALID",
							"synthetic private denial detail",
							403,
						)
					: new Error("synthetic private dependency detail");
			});
			const env = await setup(authorize);
			const execution = await env.start();
			const request = intent(execution.bridge);
			const response = await execution.bridge.callback(request);
			expect(response).toMatchObject({
				decision: "deny",
				reason: `authorization_${failure}`,
			});
			const saved = await env.saved();
			expect(facts(saved, execution).map((fact) => fact.phase)).toEqual([
				"intent",
				"failed",
			]);
			expect(facts(saved, execution).at(-1)?.failureCode).toBe(
				`authorization_${failure}`,
			);
			expect(journal(saved, execution).externalActionsBlocked).toBe(true);
			await expect(execution.bridge.callback(request)).resolves.toEqual(
				response,
			);
			expect(authorize).toHaveBeenCalledTimes(1);
			await expect(
				execution.bridge.callback(intent(execution.bridge)),
			).rejects.toThrow();
			expect(await readFile(env.path, "utf8")).not.toContain(
				"synthetic private",
			);
		},
	);

	it("rejects foreign Conversation identities, foreign or missing parents, and foreign permits without appending facts", async () => {
		const authorize = vi.fn<Authorize>(async () => {});
		const env = await setup(authorize);
		const alpha = await env.start("alpha");
		const beta = await env.start("beta");
		const parent = await permit(alpha.bridge);
		const own = await permit(beta.bridge);
		const before = await readFile(env.path, "utf8");
		await expect(beta.bridge.callback(intent(alpha.bridge))).rejects.toThrow();
		await expect(
			alpha.bridge.callback(
				intent(alpha.bridge, {
					parentAttemptRef: parent.request.identity.attemptRef,
				}),
			),
		).rejects.toThrow();
		for (const parentAttemptRef of [
			parent.request.identity.attemptRef,
			randomUUID(),
		]) {
			await expect(
				beta.bridge.callback(intent(beta.bridge, { parentAttemptRef })),
			).rejects.toThrow();
		}
		await expect(
			beta.bridge.callback({
				...started(own.request, own.response),
				permitId: parent.response.permitId,
			}),
		).rejects.toThrow();
		await expect(
			alpha.bridge.callback({
				...started(parent.request, parent.response),
				identity: { ...parent.request.identity, toolName: "apply_patch" },
			}),
		).rejects.toThrow();
		expect(await readFile(env.path, "utf8")).toBe(before);
		expect(authorize).toHaveBeenCalledTimes(2);
	});

	it("maps a nonempty stdin attempt to its original exec parent while keeping its own operation", async () => {
		const env = await setup();
		const execution = await env.start();
		const parent = await permit(execution.bridge);
		await execution.bridge.callback(started(parent.request, parent.response));
		await permit(
			execution.bridge,
			intent(execution.bridge, {
				toolName: "write_stdin",
				parentAttemptRef: parent.request.identity.attemptRef,
			}),
		);
		const saved = facts(await env.saved(), execution);
		const child = saved.at(-1);
		expect(child).toMatchObject({
			phase: "intent",
			parentOperationRef: saved[0]?.operationRef,
			toolId: "codex:write_stdin",
		});
		expect(child?.operationRef).not.toBe(saved[0]?.operationRef);
		expect(child?.attemptRef).not.toBe(saved[0]?.attemptRef);
	});

	it("retains one operation and separate attempts across a native tool retry", async () => {
		const env = await setup();
		const execution = await env.start();
		const callId = "same-native-logical-call";
		const first = await permit(
			execution.bridge,
			intent(execution.bridge, { callId }),
		);
		const begin = started(first.request, first.response);
		await execution.bridge.callback(begin);
		await execution.bridge.callback({
			...completed(begin),
			outcome: "failed",
			reason: "execution_failed",
		});
		const second = await permit(
			execution.bridge,
			intent(execution.bridge, { callId }),
		);
		await expect(execution.bridge.callback(second.request)).resolves.toEqual(
			second.response,
		);
		const retry = started(second.request, second.response);
		const startedAck = await execution.bridge.callback(retry);
		await expect(execution.bridge.callback(retry)).resolves.toEqual(startedAck);
		const result = completed(retry);
		const outcomeAck = await execution.bridge.callback(result);
		await expect(execution.bridge.callback(result)).resolves.toEqual(
			outcomeAck,
		);
		const events = await env.driver.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		const operations = events.flatMap((event) =>
			event.type === "operation" ? [event.payload] : [],
		);
		expect(operations.map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"failed",
			"intent",
			"started",
			"completed",
		]);
		expect(new Set(operations.map((fact) => fact.operationRef)).size).toBe(1);
		expect(new Set(operations.map((fact) => fact.attemptRef)).size).toBe(2);
		expect(second.response.permitId).not.toBe(first.response.permitId);
		await env.driver.close();
		const reopened = await env.reopen();
		expect(
			await reopened.replayEvents(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).toEqual(events);
	});

	it("retains the original native operation when its next attempt starts after restart", async () => {
		const env = await setup();
		const execution = await env.start();
		const first = await permit(execution.bridge);
		const begin = started(first.request, first.response);
		await execution.bridge.callback(begin);
		const failed = { ...completed(begin), outcome: "failed" as const };
		const firstAck = await execution.bridge.callback(failed);
		const original = await env.driver.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		await env.driver.close();
		const reopened = await env.reopen();
		await reopened.getStatus(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		const bridge = env.bridgeFor(execution.command);
		await expect(bridge.callback(failed)).resolves.toEqual(firstAck);
		const second = await permit(
			bridge,
			intent(bridge, { callId: first.request.identity.callId }),
		);
		const retry = started(second.request, second.response);
		await bridge.callback(retry);
		await bridge.callback(completed(retry));
		const events = await reopened.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		expect(events.slice(0, original.length)).toEqual(original);
		const operations = events.flatMap((event) =>
			event.type === "operation" ? [event.payload] : [],
		);
		expect(operations.at(-1)).toMatchObject({
			operationRef: operations[0]?.operationRef,
			phase: "completed",
		});
		expect(operations.at(-1)?.attemptRef).not.toBe(operations[0]?.attemptRef);
		expect(bridge.methods).not.toContain("turn/start");
		expect(bridge.native.turnStarts).toBe(1);
	});

	it("keeps different native calls, tools, Conversations and Turns on distinct operations", async () => {
		const env = await setup();
		const alpha = await env.start();
		const beta = await env.start("beta");
		const callId = "reused-call-id";
		const references: string[] = [];
		for (const [execution, identity] of [
			[alpha, { callId }],
			[alpha, { callId: "another-call" }],
			[alpha, { callId, toolName: "apply_patch" }],
			[beta, { callId }],
		] as const) {
			const allowed = await permit(
				execution.bridge,
				intent(execution.bridge, identity),
			);
			const begin = started(allowed.request, allowed.response);
			await execution.bridge.callback(begin);
			await execution.bridge.callback(completed(begin));
			const events = await env.driver.replayEvents(
				execution.nativeSessionRef,
				execution.command.executionId,
			);
			const last = events.at(-1);
			assert(last?.type === "operation");
			references.push(last.payload.operationRef);
		}
		await alpha.bridge.completeInferenceTurn();
		expect(
			await env.driver.getStatus(
				alpha.nativeSessionRef,
				alpha.command.executionId,
			),
		).toBe("completed");
		const nextCommand: SubmitCommand = {
			...alpha.command,
			nativeSessionRef: alpha.nativeSessionRef,
			operationId: "execution-next",
			executionId: "execution-next",
			turnId: "turn-next",
		};
		await env.driver.execute(nextCommand);
		await permit(alpha.bridge, intent(alpha.bridge, { callId }));
		const nextEvents = await env.driver.replayEvents(
			alpha.nativeSessionRef,
			nextCommand.executionId,
		);
		const next = nextEvents.at(-1);
		assert(next?.type === "operation");
		references.push(next.payload.operationRef);
		expect(new Set(references).size).toBe(5);
	});

	it("keeps the same call under different native sources and parent attempts distinct", async () => {
		const env = await setup();
		const execution = await env.start();
		const child = await startChild(execution);
		const callId = "same-call-in-each-source";
		const root = await permit(
			execution.bridge,
			intent(execution.bridge, { callId }),
		);
		const begin = started(root.request, root.response);
		await execution.bridge.callback(begin);
		await execution.bridge.callback(completed(begin));
		await permit(
			execution.bridge,
			intent(execution.bridge, {
				callId,
				sessionId: child.bind.source.threadId,
				turnId: child.bind.source.turnId,
			}),
		);
		await permit(
			execution.bridge,
			intent(execution.bridge, {
				callId,
				parentAttemptRef: child.parent.request.identity.attemptRef,
			}),
		);
		const events = await env.driver.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		const operations = events.flatMap((event) =>
			event.type === "operation" && event.payload.phase === "intent"
				? [event.payload]
				: [],
		);
		expect(new Set(operations.map((fact) => fact.operationRef)).size).toBe(4);
	});

	it.each(["intent", "started", "unknown"] as const)(
		"does not admit a native retry while the original attempt is %s",
		async (phase) => {
			const authorize = vi.fn<Authorize>(async () => {});
			const env = await setup(authorize);
			const execution = await env.start();
			const first = await permit(execution.bridge);
			const begin = started(first.request, first.response);
			if (phase !== "intent") await execution.bridge.callback(begin);
			if (phase === "unknown")
				await execution.bridge.callback({
					...completed(begin),
					outcome: "unknown",
					reason: "result_unconfirmed",
				});
			const before = await env.driver.replayEvents(
				execution.nativeSessionRef,
				execution.command.executionId,
			);
			await expect(
				execution.bridge.callback(
					intent(execution.bridge, { callId: first.request.identity.callId }),
				),
			).rejects.toThrow();
			await expect(
				execution.bridge.callback(
					intent(execution.bridge, {
						callId: "different-call",
						attemptRef: first.request.identity.attemptRef,
					}),
				),
			).rejects.toThrow();
			expect(
				await env.driver.replayEvents(
					execution.nativeSessionRef,
					execution.command.executionId,
				),
			).toEqual(before);
			expect(authorize).toHaveBeenCalledTimes(1);
		},
	);

	it("recovers only the unfinished retry as unknown and blocks another attempt", async () => {
		const env = await setup();
		const execution = await env.start();
		const first = await permit(execution.bridge);
		const begin = started(first.request, first.response);
		await execution.bridge.callback(begin);
		await execution.bridge.callback({ ...completed(begin), outcome: "failed" });
		const retry = await permit(
			execution.bridge,
			intent(execution.bridge, { callId: first.request.identity.callId }),
		);
		await execution.bridge.callback(started(retry.request, retry.response));
		const before = await env.driver.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		const originalRetry = before.at(-1);
		assert(originalRetry?.type === "operation");
		await env.driver.close();
		const reopened = await env.reopen();
		const after = await reopened.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.slice(before.length)).toEqual([
			expect.objectContaining({
				type: "operation",
				payload: expect.objectContaining({
					operationRef: originalRetry.payload.operationRef,
					attemptRef: originalRetry.payload.attemptRef,
					phase: "unknown",
				}),
			}),
		]);
		await reopened.getStatus(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		const bridge = env.bridgeFor(execution.command);
		await expect(
			bridge.callback(
				intent(bridge, { callId: first.request.identity.callId }),
			),
		).rejects.toThrow();
		expect(bridge.methods).not.toContain("turn/start");
	});

	it("preserves legacy split operation references and refuses to guess the next retry binding", async () => {
		const env = await setup();
		const execution = await env.start();
		const first = await permit(execution.bridge);
		const second = await permit(execution.bridge);
		for (const allowed of [first, second]) {
			const begin = started(allowed.request, allowed.response);
			await execution.bridge.callback(begin);
			await execution.bridge.callback({
				...completed(begin),
				outcome: "failed",
			});
		}
		const original = await env.driver.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		await env.driver.close();
		const legacy = await env.saved();
		const originalAttempt = journal(legacy, execution).nativeToolAttempts?.[
			second.request.identity.attemptRef
		];
		assert(originalAttempt);
		// Model the pre-fix journal: one native call was assigned two references.
		originalAttempt.identity = {
			...originalAttempt.identity,
			callId: first.request.identity.callId,
		};
		await writeFile(env.path, JSON.stringify(legacy));
		const reopened = await env.reopen();
		expect(
			await reopened.replayEvents(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).toEqual(original);
		await reopened.getStatus(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		const bridge = env.bridgeFor(execution.command);
		const before = await readFile(env.path, "utf8");
		await expect(
			bridge.callback(
				intent(bridge, { callId: first.request.identity.callId }),
			),
		).rejects.toThrow();
		expect(await readFile(env.path, "utf8")).toBe(before);
	});

	it.each(["callId", "toolName", "parentAttemptRef"] as const)(
		"rejects persisted shared operation references whose %s binding changed",
		async (field) => {
			const env = await setup();
			const execution = await env.start();
			const callId = "one-logical-call";
			let lastAttemptRef: string | undefined;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const allowed = await permit(
					execution.bridge,
					intent(execution.bridge, { callId }),
				);
				lastAttemptRef = allowed.request.identity.attemptRef;
				const begin = started(allowed.request, allowed.response);
				await execution.bridge.callback(begin);
				await execution.bridge.callback({
					...completed(begin),
					outcome: "failed",
				});
			}
			await env.driver.close();
			const state = await env.saved();
			assert(lastAttemptRef);
			const attempt = journal(state, execution).nativeToolAttempts?.[
				lastAttemptRef
			];
			assert(attempt);
			attempt.identity = { ...attempt.identity, [field]: "different-binding" };
			await writeFile(env.path, JSON.stringify(state));
			await expect(env.reopen()).rejects.toThrow();
		},
	);

	it("reauthorizes a retry and records revocation against only the new attempt", async () => {
		const authorize = vi.fn<Authorize>(async () => {});
		const env = await setup(authorize);
		const execution = await env.start();
		const first = await permit(execution.bridge);
		const begin = started(first.request, first.response);
		await execution.bridge.callback(begin);
		await execution.bridge.callback({
			...completed(begin),
			outcome: "failed",
			reason: "execution_failed",
		});
		authorize.mockRejectedValueOnce(
			new RuntimeHostError(
				"RUNTIME_GRANT_INVALID",
				"synthetic revocation",
				403,
			),
		);
		await expect(
			execution.bridge.callback(
				intent(execution.bridge, { callId: first.request.identity.callId }),
			),
		).resolves.toMatchObject({
			decision: "deny",
			reason: "authorization_denied",
		});
		const events = await env.driver.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		const failures = events.flatMap((event) =>
			event.type === "operation" && event.payload.phase === "failed"
				? [event.payload]
				: [],
		);
		expect(failures.map((fact) => fact.failureCode)).toEqual([
			"operation_failed",
			"authorization_denied",
		]);
		expect(failures[1]?.operationRef).toBe(failures[0]?.operationRef);
		expect(failures[1]?.attemptRef).not.toBe(failures[0]?.attemptRef);
		expect(authorize).toHaveBeenCalledTimes(2);
	});

	it("replays matching started/outcome receipts and rejects changed contents or reused phase IDs", async () => {
		const env = await setup();
		const execution = await env.start();
		const allowed = await permit(execution.bridge);
		const begin = started(allowed.request, allowed.response);
		const ackStarted = await execution.bridge.callback(begin);
		await expect(execution.bridge.callback(begin)).resolves.toEqual(ackStarted);
		await expect(
			execution.bridge.callback({ ...begin, occurredAt: begin.occurredAt + 1 }),
		).rejects.toThrow();
		await expect(execution.bridge.callback(allowed.request)).rejects.toThrow();
		await expect(
			execution.bridge.callback({
				...completed(begin),
				requestId: begin.requestId,
			}),
		).rejects.toThrow();
		const result = completed(begin);
		const ackResult = await execution.bridge.callback(result);
		await expect(execution.bridge.callback(result)).resolves.toEqual(ackResult);
		await expect(
			execution.bridge.callback({
				...result,
				phase: "outcome",
				outcome: "failed",
				reason: "execution_failed",
			}),
		).rejects.toThrow();
		expect(
			facts(await env.saved(), execution).map((fact) => fact.phase),
		).toEqual(["intent", "started", "completed"]);
	});

	it("revalidates an unused permit without extending it and never replays a consumed permit", async () => {
		const authorize = vi.fn<Authorize>(async () => {});
		const env = await setup(authorize);
		const execution = await env.start();
		const allowed = await permit(execution.bridge);
		await expect(execution.bridge.callback(allowed.request)).resolves.toEqual(
			allowed.response,
		);
		expect(authorize).toHaveBeenCalledTimes(2);
		const before = await readFile(env.path, "utf8");
		authorize.mockRejectedValueOnce(
			new RuntimeHostError(
				"RUNTIME_GRANT_INVALID",
				"synthetic revoked authority",
				403,
			),
		);
		await expect(execution.bridge.callback(allowed.request)).rejects.toThrow();
		expect(await readFile(env.path, "utf8")).toBe(before);
		const begin = started(allowed.request, allowed.response);
		await execution.bridge.callback(begin);
		await expect(execution.bridge.callback(allowed.request)).rejects.toThrow();
	});

	it("finishes shutdown while Host authorization is stuck and ignores its late result after reopening", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const returned = Promise.withResolvers<void>();
		const env = await setup(async () => {
			entered.resolve();
			await release.promise;
			returned.resolve();
		});
		const execution = await env.start();
		const waiting = execution.bridge.callback(intent(execution.bridge));
		const rejected = expect(waiting).rejects.toThrow();
		try {
			await entered.promise;
			await env.driver.close();
			await rejected;
			await env.reopen();
			const before = await readFile(env.path, "utf8");
			const writes = vi.spyOn(DurableJsonFile.prototype, "update");
			release.resolve();
			await returned.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(writes).not.toHaveBeenCalled();
			expect(await readFile(env.path, "utf8")).toBe(before);
			writes.mockRestore();
		} finally {
			release.resolve();
			await waiting.catch(() => {});
		}
	});

	it.each(["intent", "started"] as const)(
		"recovers an unconfirmed %s as the original unknown attempt without resubmitting",
		async (phase) => {
			const authorize = vi.fn<Authorize>(async () => {});
			const env = await setup(authorize);
			const execution = await env.start();
			const allowed = await permit(execution.bridge);
			if (phase === "started")
				await execution.bridge.callback(
					started(allowed.request, allowed.response),
				);
			const original = facts(await env.saved(), execution)[0];
			await env.driver.close();
			const reopened = await env.reopen();
			const recovered = await env.saved();
			expect(facts(recovered, execution).at(-1)).toMatchObject({
				...original,
				phase: "unknown",
				failureCode: "recovery_unconfirmed",
			});
			expect(journal(recovered, execution).externalActionsBlocked).toBe(true);
			await reopened.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			);
			const bridge = env.bridgeFor(execution.command);
			expect(bridge.methods).toContain("thread/resume");
			expect(bridge.methods).not.toContain("thread/start");
			expect(bridge.methods).not.toContain("turn/start");
			expect(bridge.native.turnStarts).toBe(1);
			await expect(bridge.callback(allowed.request)).rejects.toThrow();
			await expect(bridge.callback(intent(bridge))).rejects.toThrow();
			expect(authorize).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps a background execution occupied after inference completes until the original outcome is saved", async () => {
		const env = await setup();
		const execution = await env.start();
		const allowed = await permit(execution.bridge);
		const begin = started(allowed.request, allowed.response);
		await execution.bridge.callback(begin);
		await execution.bridge.completeInferenceTurn();
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("running");
		const pending = await env.saved();
		expect(
			pending.sessions[execution.nativeSessionRef]?.activeExecutionId,
		).toBe(execution.command.executionId);
		expect(
			journal(pending, execution).events.some(
				(event) => event.type === "completed",
			),
		).toBe(false);
		await expect(
			execution.bridge.callback(intent(execution.bridge)),
		).rejects.toThrow();
		const result = completed(begin);
		await execution.bridge.callback(result);
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("completed");
		const saved = await env.saved();
		expect(
			saved.sessions[execution.nativeSessionRef]?.activeExecutionId,
		).toBeUndefined();
		expect(journal(saved, execution).events.at(-1)).toMatchObject({
			type: "completed",
			payload: { status: "completed" },
		});
		expect(facts(saved, execution).at(-1)?.phase).toBe("completed");
		await expect(execution.bridge.callback(result)).resolves.toMatchObject({
			decision: "ack",
		});
	});

	it("retains occupancy when a background outcome is unknown after inference completes", async () => {
		const env = await setup();
		const execution = await env.start();
		const allowed = await permit(execution.bridge);
		const begin = started(allowed.request, allowed.response);
		await execution.bridge.callback(begin);
		await execution.bridge.completeInferenceTurn();
		await expect(
			execution.bridge.callback({
				...completed(begin),
				outcome: "unknown",
				reason: "result_unconfirmed",
			}),
		).resolves.toMatchObject({ decision: "ack" });
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("running");
		execution.bridge.background = [
			{ itemId: allowed.request.identity.callId, processId: "unknown-process" },
			{ itemId: "foreign-execution-call", processId: "foreign-process" },
		];
		await env.driver.execute({
			schemaVersion: 1,
			kind: "stop",
			operationId: "stop-unknown-synthetic",
			agentId: execution.command.agentId,
			conversationId: execution.command.conversationId,
			sessionGeneration: execution.command.sessionGeneration,
			executionId: execution.command.executionId,
			turnId: execution.command.turnId,
			nativeSessionRef: execution.nativeSessionRef,
		});
		expect(execution.bridge.terminations).toEqual([
			{
				threadId: execution.bridge.native.threadId,
				processId: "unknown-process",
			},
		]);
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("running");
		const saved = await env.saved();
		expect(facts(saved, execution).at(-1)?.phase).toBe("unknown");
		expect(saved.sessions[execution.nativeSessionRef]?.activeExecutionId).toBe(
			execution.command.executionId,
		);
		expect(
			journal(saved, execution).events.some(
				(event) => event.type === "completed",
			),
		).toBe(false);
	});

	it("accepts the original first known outcome after restart without starting another attempt or Turn", async () => {
		const authorize = vi.fn<Authorize>(async () => {});
		const env = await setup(authorize);
		const execution = await env.start();
		const allowed = await permit(execution.bridge);
		const begin = started(allowed.request, allowed.response);
		await execution.bridge.callback(begin);
		await execution.bridge.completeInferenceTurn();
		const original = facts(await env.saved(), execution).at(-1);
		expect(original?.phase).toBe("started");
		await env.driver.close();
		const reopened = await env.reopen();
		expect(facts(await env.saved(), execution).at(-1)).toMatchObject({
			operationRef: original?.operationRef,
			attemptRef: original?.attemptRef,
			phase: "unknown",
			failureCode: "recovery_unconfirmed",
		});
		await expect(
			reopened.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("running");
		const bridge = env.bridgeFor(execution.command);
		// This injects an original receipt to test Driver recovery. It does not
		// establish that a real native process can redeliver it across restart.
		const result = completed(begin);
		await expect(bridge.callback(result)).resolves.toMatchObject({
			decision: "ack",
			requestId: result.requestId,
			identity: begin.identity,
		});
		const saved = await env.saved();
		const savedFacts = facts(saved, execution);
		expect(savedFacts.at(-1)).toMatchObject({
			operationRef: original?.operationRef,
			attemptRef: original?.attemptRef,
			phase: "completed",
		});
		expect(savedFacts.at(-1)).not.toHaveProperty("failureCode");
		expect(savedFacts.filter((fact) => fact.phase === "intent")).toHaveLength(
			1,
		);
		expect(savedFacts.every((fact) => fact.kind === "tool")).toBe(true);
		expect(journal(saved, execution).events.at(-1)).toMatchObject({
			type: "completed",
			payload: { status: "completed" },
		});
		expect(
			saved.sessions[execution.nativeSessionRef]?.activeExecutionId,
		).toBeUndefined();
		await expect(
			reopened.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("completed");
		expect(bridge.methods).not.toContain("thread/start");
		expect(bridge.methods).not.toContain("turn/start");
		expect(bridge.native.turnStarts).toBe(1);
		expect(authorize).toHaveBeenCalledTimes(1);
	});

	it("stops only this Execution's background process and retains occupancy after the terminate ACK", async () => {
		const env = await setup();
		const execution = await env.start();
		const other = await env.start("other");
		const allowed = await permit(execution.bridge);
		const begin = started(allowed.request, allowed.response);
		await execution.bridge.callback(begin);
		await execution.bridge.completeInferenceTurn();
		execution.bridge.background = [
			{ itemId: "foreign-execution-call", processId: "foreign-process" },
			{ itemId: allowed.request.identity.callId, processId: "owned-process" },
		];
		const stop: RuntimeDriverCommandV1 = {
			schemaVersion: 1,
			kind: "stop",
			operationId: "stop-synthetic",
			agentId: execution.command.agentId,
			conversationId: execution.command.conversationId,
			sessionGeneration: execution.command.sessionGeneration,
			executionId: execution.command.executionId,
			turnId: execution.command.turnId,
			nativeSessionRef: execution.nativeSessionRef,
		};
		await env.driver.execute(stop);
		expect(execution.bridge.terminations).toEqual([
			{
				threadId: execution.bridge.native.threadId,
				processId: "owned-process",
			},
		]);
		expect(execution.bridge.methods).not.toContain("turn/interrupt");
		expect(other.bridge.terminations).toEqual([]);
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("running");
		expect(
			journal(await env.saved(), execution).events.some(
				(event) => event.type === "completed",
			),
		).toBe(false);
		await execution.bridge.callback(completed(begin));
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("completed");
	});
});

// These callbacks represent trusted native source receipts on the original FD.
// They exercise Driver ownership and aggregation, not real Codex queue delivery.
describe("Codex native source lifecycle", () => {
	it("rejects a recovered gate-rejected receipt whose source Turn is not its original submission", async () => {
		const env = await setup();
		const execution = await env.start();
		const parent = await permit(
			execution.bridge,
			intent(execution.bridge, { toolName: "spawn_agent" }),
		);
		const begin = started(parent.request, parent.response);
		await execution.bridge.callback(begin);
		const reserve = reserveSource(parent);
		await sourceAck(execution.bridge, reserve);
		await sourceAck(execution.bridge, {
			...reserve,
			requestId: randomUUID(),
			phase: "source-not-started",
			stage: "gate_rejected",
			reason: "binding_denied",
			source: bindSource(reserve).source,
		});
		await execution.bridge.callback(completed(begin));
		await execution.bridge.completeInferenceTurn();
		await env.driver.close();
		const corrupted = await env.saved();
		const source = journal(corrupted, execution).nativeSources?.[
			reserve.reservation.reservationId
		]?.source;
		if (!source) throw new Error("Missing original rejected source");
		source.turnId = "foreign-native-submission";
		await writeFile(env.path, `${JSON.stringify(corrupted)}\n`);
		await expect(env.reopen().then(() => "accepted")).rejects.toThrow();
	});

	it.each(["source-reserve", "source-bind"] as const)(
		"keeps the committed %s decision when an identical concurrent request receives a late Host denial",
		async (phase) => {
			let binding = false;
			let bindingChecks = 0;
			const entered = Promise.withResolvers<void>();
			const delayed = Promise.withResolvers<void>();
			const env = await setup(async () => {
				if (binding && ++bindingChecks === 1) {
					entered.resolve();
					await delayed.promise;
				}
			});
			const execution = await env.start();
			const parent = await permit(
				execution.bridge,
				intent(execution.bridge, { toolName: "spawn_agent" }),
			);
			await execution.bridge.callback(started(parent.request, parent.response));
			const reserve = reserveSource(parent);
			if (phase === "source-bind") await sourceAck(execution.bridge, reserve);
			const request = phase === "source-bind" ? bindSource(reserve) : reserve;
			if (request.phase === "source-bind")
				execution.bridge.registerSource(request.source);
			binding = true;
			const original = execution.bridge.callback(request);
			void original.catch(() => {});
			try {
				await entered.promise;
				const concurrent = execution.bridge.callback(request);
				void concurrent.catch(() => {});
				// A coalescing handler may keep both requests pending. Otherwise the
				// second guard is allowed and its committed ACK must remain authoritative.
				const settled = await Promise.race([
					concurrent.then((response) => ({ response })),
					new Promise<{ response?: undefined }>((resolve) =>
						setTimeout(() => resolve({}), 40),
					),
				]);
				delayed.reject(
					new RuntimeHostError(
						"RUNTIME_GRANT_INVALID",
						"synthetic late denial",
						403,
					),
				);
				const expected = settled.response ?? (await concurrent);
				await expect(original).resolves.toEqual(expected);
				await expect(execution.bridge.callback(request)).resolves.toEqual(
					expected,
				);
			} finally {
				delayed.resolve();
				await original.catch(() => {});
			}
		},
	);

	it("rejects a conflicting pending bind instead of overwriting the receipt that already received ACK", async () => {
		let binding = false;
		let bindingChecks = 0;
		const entered = Promise.withResolvers<void>();
		const delayed = Promise.withResolvers<void>();
		const env = await setup(async () => {
			if (binding && ++bindingChecks === 1) {
				entered.resolve();
				await delayed.promise;
			}
		});
		const execution = await env.start();
		const parent = await permit(
			execution.bridge,
			intent(execution.bridge, { toolName: "spawn_agent" }),
		);
		await execution.bridge.callback(started(parent.request, parent.response));
		const reserve = reserveSource(parent);
		await sourceAck(execution.bridge, reserve);
		const originalRequest = bindSource(reserve);
		execution.bridge.registerSource(originalRequest.source);
		binding = true;
		const first = execution.bridge.callback(originalRequest);
		void first.catch(() => {});
		try {
			await entered.promise;
			const conflictingRequest = {
				...originalRequest,
				requestId: randomUUID(),
			};
			const second = execution.bridge.callback(conflictingRequest);
			void second.catch(() => {});
			delayed.resolve();
			const results = await Promise.allSettled([first, second]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				results.filter((result) => result.status === "rejected"),
			).toHaveLength(1);
			const winner =
				results[0]?.status === "fulfilled"
					? originalRequest
					: conflictingRequest;
			const accepted = results.find((result) => result.status === "fulfilled");
			if (accepted?.status !== "fulfilled")
				throw new Error("Missing committed bind");
			await expect(execution.bridge.callback(winner)).resolves.toEqual(
				accepted.value,
			);
		} finally {
			delayed.resolve();
			await first.catch(() => {});
		}
	});

	it("commits only one terminal receipt when conflicting native outcomes arrive concurrently", async () => {
		const env = await setup();
		const execution = await env.start();
		const child = await startChild(execution);
		execution.bridge.completeSource(child.bind.source);
		const completed = terminalSource(child.bind, "completed");
		const cancelled = terminalSource(child.bind, "cancelled");
		const results = await Promise.allSettled([
			execution.bridge.callback(completed),
			execution.bridge.callback(cancelled),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		const winner = results[0]?.status === "fulfilled" ? completed : cancelled;
		const accepted = results.find((result) => result.status === "fulfilled");
		if (accepted?.status !== "fulfilled")
			throw new Error("Missing terminal receipt");
		await expect(execution.bridge.callback(winner)).resolves.toEqual(
			accepted.value,
		);
	});

	it("requires the parent started receipt before binding and records the rejected gate after stop", async () => {
		const env = await setup();
		const execution = await env.start();
		const parent = await permit(
			execution.bridge,
			intent(execution.bridge, { toolName: "spawn_agent" }),
		);
		const reserve = reserveSource(parent);
		await sourceAck(execution.bridge, reserve);
		const bind = bindSource(reserve);
		execution.bridge.registerSource(bind.source);
		await expect(execution.bridge.callback(bind)).rejects.toThrow();
		const begin = started(parent.request, parent.response);
		await execution.bridge.callback(begin);
		await env.driver.execute(stopCommand(execution));
		const denied = await execution.bridge.callback(bind);
		expect(denied).toEqual({
			schemaVersion: 1,
			requestId: bind.requestId,
			phase: "source-bind",
			request: bind,
			decision: "deny",
			reason: "authorization_unavailable",
		});
		const notStarted: CodexNativeSourceRequestV1 = {
			...reserve,
			requestId: randomUUID(),
			phase: "source-not-started",
			stage: "gate_rejected",
			reason: "binding_denied",
			source: bind.source,
		};
		await sourceAck(execution.bridge, notStarted);
		await execution.bridge.callback(completed(begin));
		await execution.bridge.completeInferenceTurn();
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("completed");
	});

	it("retains started parent lineage after its dispatch permit naturally expires", async () => {
		const env = await setup();
		const execution = await env.start();
		const parent = await permit(
			execution.bridge,
			intent(execution.bridge, { toolName: "spawn_agent" }),
		);
		await execution.bridge.callback(started(parent.request, parent.response));
		const now = vi
			.spyOn(Date, "now")
			.mockReturnValue(parent.response.expiresAt + 1);
		try {
			const reserve = reserveSource(parent);
			await sourceAck(execution.bridge, reserve);
			const bind = bindSource(reserve);
			execution.bridge.registerSource(bind.source);
			await sourceAck(execution.bridge, bind);
		} finally {
			now.mockRestore();
		}
	});

	it("keeps child actions on the original Execution after root inference has completed", async () => {
		const authorize = vi.fn<Authorize>(async () => {});
		const env = await setup(authorize);
		const execution = await env.start();
		const other = await env.start("other");
		const child = await startChild(execution);
		await execution.bridge.callback(completed(child.parentStarted));
		await execution.bridge.completeInferenceTurn();
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("running");
		await expect(
			execution.bridge.callback(intent(execution.bridge)),
		).rejects.toThrow();

		const childAction = await permit(
			execution.bridge,
			intent(execution.bridge, {
				sessionId: child.bind.source.threadId,
				turnId: child.bind.source.turnId,
			}),
		);
		expect(authorize.mock.calls.at(-1)?.[0]).toMatchObject({
			nativeSessionRef: execution.nativeSessionRef,
			executionId: execution.command.executionId,
			runtimeOperationId: execution.command.operationId,
			kind: "tool",
		});
		const begin = started(childAction.request, childAction.response);
		await execution.bridge.callback(begin);
		await execution.bridge.callback(completed(begin));
		const beforeTerminal = await env.driver.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		expect(beforeTerminal.some((event) => event.type === "completed")).toBe(
			false,
		);
		expect(
			beforeTerminal
				.filter((event) => event.type === "operation")
				.map((event) => event.payload.phase),
		).toEqual([
			"intent",
			"started",
			"completed",
			"intent",
			"started",
			"completed",
		]);
		expect(
			(
				await env.driver.replayEvents(
					other.nativeSessionRef,
					other.command.executionId,
				)
			).filter((event) => event.type === "operation"),
		).toEqual([]);
		execution.bridge.completeSource(child.bind.source);
		await sourceAck(execution.bridge, terminalSource(child.bind));
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("completed");
	});

	it("holds a reserved submission after its parent and root finish and records not-started even after stop", async () => {
		const env = await setup();
		const execution = await env.start();
		const parent = await permit(
			execution.bridge,
			intent(execution.bridge, { toolName: "spawn_agent" }),
		);
		const begin = started(parent.request, parent.response);
		await execution.bridge.callback(begin);
		const reserve = reserveSource(parent);
		await sourceAck(execution.bridge, reserve);
		await execution.bridge.callback(completed(begin));
		await execution.bridge.completeInferenceTurn();
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("running");
		await env.driver.execute(stopCommand(execution));
		expect(
			execution.bridge.requests.filter(
				(request) => request.method === "turn/interrupt",
			),
		).toEqual([]);
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("running");
		const receipt: CodexNativeSourceRequestV1 = {
			...reserve,
			requestId: randomUUID(),
			phase: "source-not-started",
			stage: "not_queued",
			reason: "cancelled_before_start",
		};
		const response = await sourceAck(execution.bridge, receipt);
		const saved = await readFile(env.path, "utf8");
		await expect(execution.bridge.callback(receipt)).resolves.toEqual(response);
		expect(await readFile(env.path, "utf8")).toBe(saved);
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("completed");
	});

	it("acknowledges already delivered steering after stop without changing the source origin or reopening actions", async () => {
		const env = await setup();
		const execution = await env.start();
		const child = await startChild(execution);
		await execution.bridge.callback(completed(child.parentStarted));
		const sender = await permit(
			execution.bridge,
			intent(execution.bridge, { toolName: "send_input" }),
		);
		const senderStarted = started(sender.request, sender.response);
		await execution.bridge.callback(senderStarted);
		const reserve = reserveSource(
			sender,
			child.bind.source.threadId,
			"native-steering-submission",
		);
		await sourceAck(execution.bridge, reserve);
		await env.driver.execute(stopCommand(execution));
		const steered: SourceBind = {
			...bindSource(reserve),
			source: child.bind.source,
			delivery: "steered",
		};
		const ack = await sourceAck(execution.bridge, steered);
		const saved = await readFile(env.path, "utf8");
		await expect(execution.bridge.callback(steered)).resolves.toEqual(ack);
		expect(await readFile(env.path, "utf8")).toBe(saved);
		await expect(
			execution.bridge.callback(
				intent(execution.bridge, {
					sessionId: child.bind.source.threadId,
					turnId: child.bind.source.turnId,
				}),
			),
		).rejects.toThrow();
		await expect(
			execution.bridge.callback(terminalSource(steered, "cancelled")),
		).rejects.toThrow();
		await execution.bridge.callback(completed(senderStarted));
		await execution.bridge.completeInferenceTurn();
		execution.bridge.completeSource(child.bind.source);
		await sourceAck(execution.bridge, terminalSource(child.bind, "cancelled"));
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.not.toBe("running");
	});

	it("rejects foreign Conversation receipts, wrong parent permits and conflicting source bindings", async () => {
		const env = await setup();
		const execution = await env.start();
		const other = await env.start("other");
		const parent = await permit(
			execution.bridge,
			intent(execution.bridge, { toolName: "spawn_agent" }),
		);
		await execution.bridge.callback(started(parent.request, parent.response));
		const reserve = reserveSource(parent);
		const untouched = await readFile(env.path, "utf8");
		await expect(other.bridge.callback(reserve)).rejects.toThrow();
		await expect(
			execution.bridge.callback({
				...reserve,
				reservation: { ...reserve.reservation, parentPermitId: randomUUID() },
			}),
		).rejects.toThrow();
		await expect(
			execution.bridge.callback({
				...reserve,
				reservation: {
					...reserve.reservation,
					parent: { ...reserve.reservation.parent, callId: "foreign-call" },
				},
			}),
		).rejects.toThrow();
		expect(await readFile(env.path, "utf8")).toBe(untouched);
		await sourceAck(execution.bridge, reserve);
		const bind = bindSource(reserve);
		for (const source of [
			{ ...bind.source, threadId: "foreign-thread" },
			{ ...bind.source, turnId: "foreign-submission" },
		]) {
			await expect(
				execution.bridge.callback({ ...bind, source }),
			).rejects.toThrow();
		}
		execution.bridge.registerSource(bind.source);
		await sourceAck(execution.bridge, bind);
		const duplicate = reserveSource(parent);
		await expect(execution.bridge.callback(duplicate)).rejects.toThrow();
		const changedReceipt = { ...bind, delivery: "steered" as const };
		await expect(execution.bridge.callback(changedReceipt)).rejects.toThrow();
	});

	it("rechecks matching reserve receipts without adding new facts", async () => {
		const authorize = vi.fn<Authorize>(async () => {});
		const env = await setup(authorize);
		const execution = await env.start();
		const child = await startChild(execution);
		const calls = authorize.mock.calls.length;
		const beforeReplay = await readFile(env.path, "utf8");
		await sourceAck(execution.bridge, child.reserve);
		await sourceAck(execution.bridge, child.bind);
		expect(await readFile(env.path, "utf8")).toBe(beforeReplay);
		expect(authorize).toHaveBeenCalledTimes(calls + 1);
		await execution.bridge.callback(completed(child.parentStarted));
		await execution.bridge.completeInferenceTurn();
		execution.bridge.completeSource(child.bind.source);
		const terminal = terminalSource(child.bind);
		const ack = await sourceAck(execution.bridge, terminal);
		const saved = await readFile(env.path, "utf8");
		await expect(execution.bridge.callback(terminal)).resolves.toEqual(ack);
		expect(await readFile(env.path, "utf8")).toBe(saved);
		const events = await env.driver.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		expect(events.filter((event) => event.type === "completed")).toHaveLength(
			1,
		);
		expect(
			events
				.filter((event) => event.type === "operation")
				.map((event) => event.payload.phase),
		).toEqual(["intent", "started", "completed"]);
	});

	it("targets only the original child Turn and child background call while ACKs retain occupancy", async () => {
		const env = await setup();
		const execution = await env.start();
		const other = await env.start("other");
		const child = await startChild(execution);
		await execution.bridge.callback(completed(child.parentStarted));
		const worker = await permit(
			execution.bridge,
			intent(execution.bridge, {
				sessionId: child.bind.source.threadId,
				turnId: child.bind.source.turnId,
			}),
		);
		const begin = started(worker.request, worker.response);
		await execution.bridge.callback(begin);
		execution.bridge.background = [
			{
				itemId: worker.request.identity.callId,
				processId: "wrong-root-process",
			},
		];
		execution.bridge.backgroundByThread.set(child.bind.source.threadId, [
			{
				itemId: worker.request.identity.callId,
				processId: "owned-child-process",
			},
			{ itemId: "foreign-child-call", processId: "foreign-child-process" },
		]);
		await execution.bridge.completeInferenceTurn();
		await env.driver.execute(stopCommand(execution));
		expect(
			execution.bridge.requests
				.filter((request) => request.method === "turn/interrupt")
				.map((request) => request.params),
		).toEqual([
			{
				threadId: child.bind.source.threadId,
				turnId: child.bind.source.turnId,
			},
		]);
		expect(execution.bridge.terminations).toEqual([
			{
				threadId: child.bind.source.threadId,
				processId: "owned-child-process",
			},
		]);
		expect(
			other.bridge.requests.some(
				(request) => request.method === "turn/interrupt",
			),
		).toBe(false);
		expect(other.bridge.terminations).toEqual([]);
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("running");
		execution.bridge.completeSource(child.bind.source);
		await sourceAck(execution.bridge, terminalSource(child.bind, "cancelled"));
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("running");
		await execution.bridge.callback(completed(begin));
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.not.toBe("running");
	});

	it.each(["reserved", "bound"] as const)(
		"restores an unresolved %s source without respawning or inferring completion from a query",
		async (stage) => {
			const env = await setup();
			const execution = await env.start();
			const parent = await permit(
				execution.bridge,
				intent(execution.bridge, { toolName: "spawn_agent" }),
			);
			const begin = started(parent.request, parent.response);
			await execution.bridge.callback(begin);
			const reserve = reserveSource(parent);
			await sourceAck(execution.bridge, reserve);
			const bind = bindSource(reserve);
			if (stage === "bound") {
				execution.bridge.registerSource(bind.source);
				await sourceAck(execution.bridge, bind);
			}
			await execution.bridge.callback(completed(begin));
			await execution.bridge.completeInferenceTurn();
			await env.driver.close();
			const recovered = await env.reopen();
			await expect(
				recovered.getStatus(
					execution.nativeSessionRef,
					execution.command.executionId,
				),
			).resolves.toBe("running");
			const bridge = env.bridgeFor(execution.command);
			expect(bridge.methods).not.toContain("thread/start");
			expect(bridge.methods).not.toContain("turn/start");
			expect(bridge.native.turnStarts).toBe(1);
			await expect(bridge.callback(intent(bridge))).rejects.toThrow();
			if (stage === "bound") {
				await expect(
					bridge.callback(
						intent(bridge, {
							sessionId: bind.source.threadId,
							turnId: bind.source.turnId,
						}),
					),
				).rejects.toThrow();
			}
			const events = await recovered.replayEvents(
				execution.nativeSessionRef,
				execution.command.executionId,
			);
			expect(events.some((event) => event.type === "completed")).toBe(false);
		},
	);
});

describe("Codex native source HTTP model requests", () => {
	it("records child HTTP model work under the original parent after root completion and rejects foreign tokens and terminal sources", async () => {
		const upstream = await sourceModelEndpoint();
		const authorize = vi.fn<Authorize>(async () => {});
		const env = await setup(authorize, upstream.endpoint);
		const execution = await env.start();
		const other = await env.start("other");
		const child = await startChild(execution);
		await expect(
			sourceModelRequest(other.bridge, child.bind.source),
		).resolves.toBe(403);
		expect(upstream.calls).toEqual([]);
		await execution.bridge.callback(completed(child.parentStarted));
		await execution.bridge.completeInferenceTurn();
		await expect(
			sourceModelRequest(execution.bridge, child.bind.source),
		).resolves.toBe(200);
		expect(upstream.calls).toEqual(["/v1/responses"]);
		expect(authorize.mock.calls.at(-1)?.[0]).toMatchObject({
			nativeSessionRef: execution.nativeSessionRef,
			executionId: execution.command.executionId,
			runtimeOperationId: execution.command.operationId,
			kind: "model",
		});
		const events = await env.driver.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		const operations = events
			.filter((event) => event.type === "operation")
			.map((event) => event.payload);
		const parent = operations.find(
			(fact) => fact.kind === "tool" && fact.phase === "intent",
		);
		if (!parent) throw new Error("Missing parent operation fact");
		const models = operations.filter((fact) => fact.kind === "model");
		expect(models.map((fact) => fact.phase)).toEqual([
			"intent",
			"started",
			"completed",
		]);
		expect(
			models.every((fact) => fact.parentOperationRef === parent.operationRef),
		).toBe(true);
		expect(new Set(models.map((fact) => fact.operationRef)).size).toBe(1);
		expect(new Set(models.map((fact) => fact.attemptRef)).size).toBe(1);
		expect(events.some((event) => event.type === "completed")).toBe(false);
		expect(
			(
				await env.driver.replayEvents(
					other.nativeSessionRef,
					other.command.executionId,
				)
			).filter((event) => event.type === "operation"),
		).toEqual([]);
		execution.bridge.completeSource(child.bind.source);
		await sourceAck(execution.bridge, terminalSource(child.bind));
		await expect(
			sourceModelRequest(execution.bridge, child.bind.source),
		).resolves.toBe(409);
		expect(upstream.calls).toHaveLength(1);
		await expect(
			env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).resolves.toBe("completed");
	});

	it.each(["stop", "restart"] as const)(
		"keeps child HTTP model admission closed after %s even when the original bind receipt is replayed",
		async (boundary) => {
			const upstream = await sourceModelEndpoint();
			const env = await setup(async () => {}, upstream.endpoint);
			const execution = await env.start();
			const child = await startChild(execution);
			await execution.bridge.callback(completed(child.parentStarted));
			await execution.bridge.completeInferenceTurn();
			await expect(
				sourceModelRequest(execution.bridge, child.bind.source),
			).resolves.toBe(200);
			let driver = env.driver;
			let bridge = execution.bridge;
			if (boundary === "stop") {
				await driver.execute(stopCommand(execution));
			} else {
				await driver.close();
				driver = await env.reopen();
				await expect(
					driver.getStatus(
						execution.nativeSessionRef,
						execution.command.executionId,
					),
				).resolves.toBe("running");
				bridge = env.bridgeFor(execution.command);
				expect(bridge.options.modelAccess?.credential).not.toBe(
					execution.bridge.options.modelAccess?.credential,
				);
				expect(bridge.methods).not.toContain("turn/start");
				expect(bridge.native.turnStarts).toBe(1);
			}
			await expect(
				sourceModelRequest(bridge, child.bind.source),
			).resolves.not.toBe(200);
			await expect(bridge.callback(child.bind)).rejects.toThrow();
			await expect(
				sourceModelRequest(bridge, child.bind.source),
			).resolves.not.toBe(200);
			expect(upstream.calls).toHaveLength(1);
			const events = await driver.replayEvents(
				execution.nativeSessionRef,
				execution.command.executionId,
			);
			expect(events.some((event) => event.type === "completed")).toBe(false);
			expect(
				events.filter(
					(event) =>
						event.type === "operation" &&
						event.payload.kind === "model" &&
						event.payload.phase === "intent",
				),
			).toHaveLength(1);
		},
	);
});

const connectionCorpus = JSON.parse(
	readCallbackCorpusBytes().toString("utf8"),
) as {
	cases: { id: string; frame: unknown }[];
};
const connectionAjv = new Ajv2020({ strict: true, strictRequired: false });
connectionAjv.addFormat(
	"uuid",
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
connectionAjv.addSchema(codexCallbackSchema);
function connectionFrame<T>(definition: string, id: string): T {
	const value: unknown = structuredClone(
		connectionCorpus.cases.find((item) => item.id === id)?.frame,
	);
	const validate = connectionAjv.compile<T>({
		$ref: `${codexCallbackSchema.$id}#/$defs/${definition}`,
	});
	assert(validate(value), id);
	return value;
}
function connectionBootstrap(): CodexConnectionBootstrapRequest {
	return {
		...connectionFrame<CodexConnectionBootstrapRequest>(
			"connectionBootstrapRequest",
			"v2-bootstrap-request-before-native-session",
		),
		requestId: randomUUID(),
	};
}
function connectionOptions() {
	const response = connectionFrame<CodexConnectionBootstrapResponse>(
		"connectionBootstrapResponse",
		"v2-bootstrap-user-permit",
	);
	assert(response.decision === "permit");
	const { slotId: _slot, ...configuration } = response.slot;
	configuration.credential.expiresAt = Date.now() + 60_000;
	const options = {
		profile: {
			profileRef: response.request.profileRef,
			...configuration.service,
		},
		resolveOriginalClient: vi.fn<
			NonNullable<
				CodexRuntimeDriverOptions["connectionClient"]
			>["resolveOriginalClient"]
		>(async (reference) => {
			const { nativeSessionRef: _native, ...scope } = reference;
			return {
				...structuredClone(configuration),
				originalBinding: { ...configuration.originalBinding, scope },
			};
		}),
	};
	return { options, configuration };
}
type ConnectionIntent = Extract<
	CodexConnectionOperationRequest,
	{ phase: "intent" }
>;
type ConnectionStarted = Extract<
	CodexConnectionOperationRequest,
	{ phase: "started" }
>;
async function connectionIntent(execution: Execution) {
	const bootstrap = await execution.bridge.bootstrap(connectionBootstrap());
	assert(bootstrap.decision === "permit");
	const template = connectionFrame<CodexConnectionOperationRequest>(
		"connectionOperationRequest",
		"v2-connection-intent",
	);
	const request: ConnectionIntent = {
		...intent(execution.bridge, { toolName: "connection/execute_action" }),
		schemaVersion: 2,
		connectionRequest: {
			...template.connectionRequest,
			slotId: bootstrap.slot.slotId,
			operationNonce: randomUUID(),
			attemptNonce: randomUUID(),
			idempotencyKey: randomUUID(),
		},
	};
	return { request, bootstrap };
}
async function connectionStarted(
	execution: Execution,
	request: ConnectionIntent,
): Promise<ConnectionStarted> {
	const response = await execution.bridge.connectionCallback(request);
	assert(response.decision === "permit");
	const next: ConnectionStarted = {
		...request,
		requestId: randomUUID(),
		phase: "started",
		permitId: response.permitId,
		occurredAt: Date.now(),
	};
	await expect(
		execution.bridge.connectionCallback(next),
	).resolves.toMatchObject({ decision: "ack", phase: "started" });
	return next;
}
function verifiedConnectionEvidence(
	request: ConnectionStarted,
): Extract<CodexConnectionEvidence, { verification: "verified" }> {
	const frame = connectionFrame<CodexConnectionOperationRequest>(
		"connectionOperationRequest",
		"v2-connection-completed-verified",
	);
	assert(
		"connectionEvidence" in frame &&
			frame.connectionEvidence.verification === "verified",
	);
	const result = frame.connectionEvidence;
	const descriptor = request.connectionRequest;
	result.originalResponse.rpcRequestId = descriptor.rpcRequestId;
	result.originalResponse.receivedAt = Date.now();
	Object.assign(result.originalResponse.receipt, {
		operationNonce: descriptor.operationNonce,
		attemptNonce: descriptor.attemptNonce,
		requestDigest: descriptor.requestDigest,
	});
	Object.assign(result.recordQuery.record, {
		operationNonce: descriptor.operationNonce,
		attemptNonces: [descriptor.attemptNonce],
		requestDigest: descriptor.requestDigest,
	});
	result.recordQuery.queriedAt = Date.now();
	result.verifiedAt = Date.now();
	return result;
}
function connectionOutcome(
	request: ConnectionStarted,
	evidence: CodexConnectionEvidence,
): CodexConnectionOperationRequest {
	assert(
		request.connectionRequest.toolName === "execute_action" &&
			request.connectionRequest.actionSelector,
	);
	return {
		...request,
		connectionRequest: {
			...request.connectionRequest,
			toolName: "execute_action",
			actionSelector: request.connectionRequest.actionSelector,
		},
		requestId: randomUUID(),
		phase: "outcome",
		outcome: "completed",
		occurredAt: Date.now(),
		connectionEvidence: evidence,
	};
}
function connectionUpdate(
	request: ConnectionStarted,
	evidence: CodexConnectionEvidence,
): CodexConnectionEvidenceUpdateRequest {
	assert(
		request.connectionRequest.toolName === "execute_action" &&
			request.connectionRequest.actionSelector,
	);
	return {
		...request,
		connectionRequest: {
			...request.connectionRequest,
			toolName: "execute_action",
			actionSelector: request.connectionRequest.actionSelector,
		},
		requestId: randomUUID(),
		phase: "connection-evidence",
		occurredAt: Date.now(),
		connectionEvidence: evidence,
	};
}

describe("Codex Driver Connection journal and admission", () => {
	it("admits only configured capability and never resolves credentials or configures MCP during readiness", async () => {
		const { options } = connectionOptions();
		const env = await setup(undefined, undefined, options);
		expect(await env.driver.getCapabilities()).toMatchObject({
			connection: true,
		});
		expect(
			await env.driver.probeReadiness(new AbortController().signal),
		).toMatchObject({ connection: true });
		expect(options.resolveOriginalClient).not.toHaveBeenCalled();
		for (const bridge of env.bridges.values()) {
			expect(bridge.options.connectionProfile).toBeUndefined();
			expect(bridge.options.nativeConnectionBootstrap).toBeUndefined();
			expect(bridge.methods).toEqual(["initialize", "config/read"]);
		}
	});

	it.each(["profile", "resolver", "extra"])(
		"rejects malformed %s deployment input before opening native",
		async (change) => {
			const { options } = connectionOptions();
			if (change === "profile")
				options.profile.resource = "https://elsewhere.example.test/mcp";
			if (change === "resolver")
				Object.assign(options, { resolveOriginalClient: undefined });
			if (change === "extra")
				Object.assign(options, { accessToken: "FAKE-TEST-ONLY" });
			await expect(setup(undefined, undefined, options)).rejects.toThrow();
		},
	);

	it.each(["headers", "helper", "other-server", "resource", "disabled"])(
		"rejects native %s configuration before starting a Conversation",
		async (change) => {
			const { options } = connectionOptions();
			const env = await setup(undefined, undefined, options, {
				configuration: (config) => {
					const servers = config.mcp_servers as {
						connection: Record<string, unknown>;
					};
					if (change === "headers")
						servers.connection.http_headers = {
							Authorization: "FAKE-TEST-ONLY",
						};
					if (change === "helper")
						servers.connection.http_headers_helper = "untrusted-helper";
					if (change === "other-server")
						Object.assign(servers, {
							other: { url: options.profile.resource },
						});
					if (change === "resource")
						servers.connection.url = "https://elsewhere.example.test/mcp";
					if (change === "disabled") servers.connection.enabled = false;
				},
			});
			await expect(env.driver.execute(command())).rejects.toThrow();
			expect(options.resolveOriginalClient).not.toHaveBeenCalled();
			expect(env.bridgeFor(command()).methods).not.toContain("thread/start");
		},
	);

	it.each(["user", "application"] as const)(
		"bootstraps the original %s Execution before native Session creation and keeps token out of state",
		async (kind) => {
			const { options, configuration } = connectionOptions();
			configuration.originalBinding.principal = {
				kind,
				id: "platform-original-subject",
			};
			configuration.connectionIdentity.principal = {
				type: kind,
				key: "connection-original-subject",
			};
			let bootstrap: CodexConnectionBootstrapResponse | undefined;
			const env = await setup(undefined, undefined, options, {
				beforeThreadStart: async (bridge) => {
					bootstrap = await bridge.bootstrap(connectionBootstrap());
				},
			});
			const execution = await env.start();
			assert(bootstrap?.decision === "permit");
			expect(bootstrap.slot.originalBinding).toEqual({
				principal: configuration.originalBinding.principal,
				scope: {
					agentId: execution.command.agentId,
					conversationId: execution.command.conversationId,
					sessionGeneration: 1,
					executionId: execution.command.executionId,
				},
			});
			expect(options.resolveOriginalClient).toHaveBeenCalledExactlyOnceWith(
				{
					...bootstrap.slot.originalBinding.scope,
					nativeSessionRef: execution.nativeSessionRef,
				},
				expect.any(AbortSignal),
			);
			expect(await readFile(env.path, "utf8")).not.toContain(
				configuration.credential.accessToken,
			);
			expect(JSON.stringify(execution.bridge.options)).not.toContain(
				configuration.credential.accessToken,
			);
		},
	);

	it.each(["wrong-scope", "wrong-thread", "expired", "stopped-during-load"])(
		"rejects bootstrap with %s",
		async (change) => {
			const { options, configuration } = connectionOptions();
			const env = await setup(undefined, undefined, options);
			const execution = await env.start();
			const original = options.resolveOriginalClient.getMockImplementation();
			assert(original);
			options.resolveOriginalClient.mockImplementation(
				async (reference, signal) => {
					if (change === "stopped-during-load")
						await env.driver.execute(stopCommand(execution));
					return original(
						change === "wrong-scope"
							? { ...reference, executionId: "execution-other" }
							: reference,
						signal,
					);
				},
			);
			if (change === "expired")
				configuration.credential.expiresAt = Date.now() - 1;
			const request = connectionBootstrap();
			if (change === "wrong-thread")
				request.nativeSessionRef = "unknown-native-thread";
			expect(await execution.bridge.bootstrap(request)).toMatchObject({
				decision: "unavailable",
			});
			if (change === "wrong-thread")
				expect(options.resolveOriginalClient).not.toHaveBeenCalled();
		},
	);

	it("persists the exact descriptor before Host authorization and the permit durability barrier", async () => {
		const entered = Promise.withResolvers<void>();
		const authorized = Promise.withResolvers<void>();
		const authorize = vi.fn<Authorize>(async () => {
			entered.resolve();
			await authorized.promise;
		});
		const { options, configuration } = connectionOptions();
		const env = await setup(authorize, undefined, options);
		const execution = await env.start();
		const { request } = await connectionIntent(execution);
		const sync = await holdDirectorySync(env.directory);
		const response = execution.bridge.connectionCallback(request);
		let replied = false;
		void response.then(
			() => {
				replied = true;
			},
			() => {},
		);
		try {
			await sync.entered;
			expect(authorize).not.toHaveBeenCalled();
			expect(replied).toBe(false);
			sync.release();
			await entered.promise;
			const attempt = journal(await env.saved(), execution)
				.nativeToolAttempts?.[request.identity.attemptRef];
			expect(attempt?.connectionRequest).toEqual(request.connectionRequest);
			expect(attempt?.permitId).toBeUndefined();
			expect(attempt?.intentFingerprint).toMatch(/^[a-f0-9]{64}$/);
			expect(await readFile(env.path, "utf8")).not.toContain(
				configuration.credential.accessToken,
			);
			expect(replied).toBe(false);
			authorized.resolve();
			await expect(response).resolves.toMatchObject({
				schemaVersion: 2,
				connectionRequest: request.connectionRequest,
				decision: "permit",
			});
		} finally {
			sync.release();
			authorized.resolve();
			await response.catch(() => {});
			sync.restore();
		}
	});

	it("rechecks the slot after Host authorization and denies a rotated slot", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { options } = connectionOptions();
		const env = await setup(
			async () => {
				entered.resolve();
				await release.promise;
			},
			undefined,
			options,
		);
		const execution = await env.start();
		const { request } = await connectionIntent(execution);
		const response = execution.bridge.connectionCallback(request);
		await entered.promise;
		try {
			expect(
				await execution.bridge.bootstrap(connectionBootstrap()),
			).toMatchObject({ decision: "permit" });
		} finally {
			release.resolve();
		}
		await expect(response).resolves.toMatchObject({
			decision: "deny",
			reason: "authorization_unavailable",
		});
		expect(
			journal(await env.saved(), execution).nativeToolAttempts?.[
				request.identity.attemptRef
			]?.permitId,
		).toBeUndefined();
	});

	it.each([
		"list_apps",
		"list_connections",
		"search_actions",
		"get_action_guide",
		"execute_action",
	])(
		"rejects legacy V1 Connection %s without Host authorization",
		async (tool) => {
			const authorize = vi.fn<Authorize>(async () => {});
			const env = await setup(authorize);
			const execution = await env.start();
			await expect(
				execution.bridge.callback(
					intent(execution.bridge, { toolName: `connection/${tool}` }),
				),
			).rejects.toThrow();
			expect(authorize).not.toHaveBeenCalled();
			expect(facts(await env.saved(), execution)).toEqual([]);
		},
	);

	it("keeps distinct Connection operations separate when their native call ID is reused", async () => {
		const { options } = connectionOptions();
		const env = await setup(undefined, undefined, options);
		const execution = await env.start();
		for (let operation = 0; operation < 2; operation += 1) {
			const { request } = await connectionIntent(execution);
			const next: ConnectionIntent = {
				...request,
				identity: { ...request.identity, callId: "same-native-call" },
			};
			const begin = await connectionStarted(execution, next);
			await execution.bridge.connectionCallback(
				connectionOutcome(begin, {
					verification: "unverified",
					reason: "receipt_missing",
				}),
			);
		}
		const events = await env.driver.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		const operations = events.flatMap((event) =>
			event.type === "operation" ? [event.payload] : [],
		);
		expect(new Set(operations.map((fact) => fact.operationRef)).size).toBe(2);
	});

	it("binds the descriptor to the same source, attempt, nonces, and slot", async () => {
		const { options } = connectionOptions();
		const env = await setup(undefined, undefined, options);
		const execution = await env.start();
		const other = await env.start("beta");
		const { request } = await connectionIntent(execution);
		await expect(other.bridge.connectionCallback(request)).rejects.toThrow();
		await expect(
			execution.bridge.connectionCallback({
				...request,
				identity: { ...request.identity, toolName: "connection/list_apps" },
			}),
		).rejects.toThrow();
		const startedRequest = await connectionStarted(execution, request);
		await expect(
			execution.bridge.connectionCallback({
				...startedRequest,
				connectionRequest: {
					...request.connectionRequest,
					requestDigest: "f".repeat(64),
				},
			}),
		).rejects.toThrow();
		await expect(
			execution.bridge.connectionCallback({
				...request,
				requestId: randomUUID(),
				identity: {
					...request.identity,
					callId: randomUUID(),
					attemptRef: randomUUID(),
				},
			}),
		).rejects.toThrow();
		expect(
			facts(await env.saved(), execution).map((fact) => fact.phase),
		).toEqual(["intent", "started"]);
		expect(facts(await env.saved(), other)).toEqual([]);
	});

	it.each([
		"list_apps",
		"list_connections",
		"search_actions",
		"get_action_guide",
	] as const)(
		"completes %s without a fabricated Connection association",
		async (tool) => {
			const { options } = connectionOptions();
			const env = await setup(undefined, undefined, options);
			const execution = await env.start();
			const { request } = await connectionIntent(execution);
			const { actionSelector, ...descriptor } = request.connectionRequest;
			const discovery: ConnectionIntent = {
				...request,
				identity: { ...request.identity, toolName: `connection/${tool}` },
				connectionRequest: {
					...descriptor,
					toolName: tool,
					...(tool === "get_action_guide" ? { actionSelector } : {}),
				},
			};
			const start = await connectionStarted(execution, discovery);
			await execution.bridge.connectionCallback({
				...start,
				connectionRequest: { ...start.connectionRequest, toolName: tool },
				requestId: randomUUID(),
				phase: "outcome",
				outcome: "completed",
				occurredAt: Date.now(),
			});
			expect(
				facts(await env.saved(), execution).map((fact) => fact.phase),
			).toEqual(["intent", "started", "completed"]);
			for (const fact of facts(await env.saved(), execution))
				expect(fact).not.toHaveProperty("connection");
		},
	);

	it("adds verified evidence after completion without changing timing, repeating outcomes, or replaying dispatch", async () => {
		const { options } = connectionOptions();
		const env = await setup(undefined, undefined, options);
		const execution = await env.start();
		const { request } = await connectionIntent(execution);
		const start = await connectionStarted(execution, request);
		const verified = verifiedConnectionEvidence(start);
		const unverified: CodexConnectionEvidence = {
			verification: "unverified",
			reason: "record_unavailable",
			originalResponse: verified.originalResponse,
		};
		const outcome = connectionOutcome(start, unverified);
		await execution.bridge.connectionCallback(outcome);
		await execution.bridge.completeInferenceTurn();
		expect(
			await env.driver.getStatus(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).toBe("completed");
		const before = await env.saved();
		const original = facts(before, execution).at(-1);
		assert(original?.kind === "tool");
		expect(original.connection).toMatchObject({
			verification: "unverified",
			callRef: verified.originalResponse.receipt.callRef,
		});
		const update = connectionUpdate(start, verified);
		const sync = await holdDirectorySync(env.directory);
		let replied = false;
		const response = execution.bridge.connectionCallback(update);
		void response.then(
			() => {
				replied = true;
			},
			() => {},
		);
		try {
			await Promise.race([sync.entered, response]);
			expect(replied).toBe(false);
		} finally {
			sync.release();
		}
		await expect(response).resolves.toMatchObject({ decision: "ack" });
		sync.restore();
		const saved = await env.saved();
		const latest = facts(saved, execution).at(-1);
		assert(latest);
		expect(latest).toEqual({
			...original,
			connection: {
				serviceRef: options.profile.serviceRef,
				verification: "verified",
				callRef: verified.originalResponse.receipt.callRef,
			},
		});
		expect(
			journal(saved, execution).events.filter(
				(event) => event.type === "completed",
			),
		).toHaveLength(1);
		await execution.bridge.connectionCallback(update);
		await execution.bridge.connectionCallback(outcome);
		expect(await env.saved()).toEqual(saved);
		await expect(
			execution.bridge.connectionCallback(connectionUpdate(start, unverified)),
		).rejects.toThrow();
		const changed = structuredClone(verified);
		changed.originalResponse.receipt.callRef = "swapped-callref";
		await expect(
			execution.bridge.connectionCallback(connectionUpdate(start, changed)),
		).rejects.toThrow();
		await expect(
			execution.bridge.connectionCallback({
				...update,
				connectionRequest: {
					...update.connectionRequest,
					requestDigest: "f".repeat(64),
				},
			}),
		).rejects.toThrow();
		expect(execution.bridge.native.turnStarts).toBe(1);
		expect(
			execution.bridge.methods.filter((method) => method === "tools/call"),
		).toHaveLength(0);
		await env.driver.close();
		const reopened = await env.reopen();
		const events = await reopened.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		expect(
			events.filter((event) => event.type === "operation").at(-1)?.payload,
		).toMatchObject(latest);
		const streamed = [];
		for await (const event of await reopened.subscribeEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		))
			streamed.push(event);
		expect(streamed).toEqual(events);
		expect(execution.bridge.native.turnStarts).toBe(1);
	});

	it("preserves unverified facts after restart without inventing an original receipt", async () => {
		const { options } = connectionOptions();
		const env = await setup(undefined, undefined, options);
		const execution = await env.start();
		const { request } = await connectionIntent(execution);
		const start = await connectionStarted(execution, request);
		const unverified: CodexConnectionEvidence = {
			verification: "unverified",
			reason: "receipt_missing",
		};
		await execution.bridge.connectionCallback(
			connectionOutcome(start, unverified),
		);
		await expect(
			execution.bridge.connectionCallback(
				connectionUpdate(start, verifiedConnectionEvidence(start)),
			),
		).rejects.toThrow();
		await execution.bridge.completeInferenceTurn();
		const before = facts(await env.saved(), execution);
		await env.driver.close();
		const reopened = await env.reopen();
		await reopened.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		expect(facts(await env.saved(), execution)).toEqual(before);
		expect(before.at(-1)).toMatchObject({
			connection: { verification: "unverified", reason: "receipt_missing" },
		});
		expect(execution.bridge.native.turnStarts).toBe(1);
	});

	it("uses an old same-process slot only for historical evidence after the next Execution starts", async () => {
		const { options } = connectionOptions();
		const env = await setup(undefined, undefined, options);
		const first = await env.start();
		const { request } = await connectionIntent(first);
		const start = await connectionStarted(first, request);
		const verified = verifiedConnectionEvidence(start);
		await first.bridge.connectionCallback(
			connectionOutcome(start, {
				verification: "unverified",
				reason: "record_unavailable",
				originalResponse: verified.originalResponse,
			}),
		);
		await first.bridge.completeInferenceTurn();
		expect(
			await env.driver.getStatus(
				first.nativeSessionRef,
				first.command.executionId,
			),
		).toBe("completed");
		const nextCommand: SubmitCommand = {
			...first.command,
			nativeSessionRef: first.nativeSessionRef,
			operationId: "execution-next",
			executionId: "execution-next",
			turnId: "turn-next",
		};
		const record = await env.driver.execute(nextCommand);
		expect(record.result.outcome).toBe("accepted");
		const next: Execution = {
			command: nextCommand,
			nativeSessionRef: first.nativeSessionRef,
			bridge: first.bridge,
		};
		const { request: nextIntent } = await connectionIntent(next);
		await expect(
			first.bridge.connectionCallback({
				...nextIntent,
				connectionRequest: {
					...nextIntent.connectionRequest,
					slotId: request.connectionRequest.slotId,
				},
			}),
		).rejects.toThrow();
		await expect(
			first.bridge.connectionCallback(connectionUpdate(start, verified)),
		).resolves.toMatchObject({ decision: "ack" });
		expect(
			await env.driver.getStatus(
				next.nativeSessionRef,
				next.command.executionId,
			),
		).toBe("running");
		expect(first.bridge.native.turnStarts).toBe(2);
	});
});

describe("Codex Driver Connection leaf negative boundaries", () => {
	it.each(["before-intent", "during-authorization"])(
		"rejects an expired slot %s",
		async (stage) => {
			const realTime = Date.now();
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(realTime);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const authorize = vi.fn<Authorize>(async () => {
				entered.resolve();
				await release.promise;
			});
			try {
				const { options, configuration } = connectionOptions();
				const env = await setup(authorize, undefined, options);
				const execution = await env.start();
				const { request } = await connectionIntent(execution);
				if (stage === "before-intent") {
					vi.setSystemTime(configuration.credential.expiresAt + 1);
					await expect(
						execution.bridge.connectionCallback(request),
					).rejects.toThrow();
					expect(authorize).not.toHaveBeenCalled();
					expect(facts(await env.saved(), execution)).toEqual([]);
				} else {
					const response = execution.bridge.connectionCallback(request);
					await entered.promise;
					vi.setSystemTime(configuration.credential.expiresAt + 1);
					release.resolve();
					await expect(response).resolves.toMatchObject({
						decision: "deny",
						reason: "authorization_unavailable",
					});
					expect(
						journal(await env.saved(), execution).nativeToolAttempts?.[
							request.identity.attemptRef
						]?.permitId,
					).toBeUndefined();
				}
			} finally {
				release.resolve();
				vi.useRealTimers();
			}
		},
	);

	it("rejects V2 Connection dispatch when independent client input is absent", async () => {
		const authorize = vi.fn<Authorize>(async () => {});
		const env = await setup(authorize);
		const execution = await env.start();
		const template = connectionFrame<CodexConnectionOperationRequest>(
			"connectionOperationRequest",
			"v2-connection-intent",
		);
		const request: ConnectionIntent = {
			...intent(execution.bridge, { toolName: "connection/execute_action" }),
			schemaVersion: 2,
			connectionRequest: template.connectionRequest,
		};
		await expect(
			execution.bridge.connectionCallback(request),
		).rejects.toThrow();
		expect(facts(await env.saved(), execution)).toEqual([]);
		expect(authorize).not.toHaveBeenCalled();
		expect(await env.driver.getCapabilities()).toMatchObject({
			connection: false,
		});
	});

	it("binds a child Connection leaf to its registered root and refuses another leaf after child completion", async () => {
		const { options } = connectionOptions();
		const env = await setup(undefined, undefined, options);
		const execution = await env.start();
		const child = await startChild(execution);
		const { request } = await connectionIntent(execution);
		const childIntent: ConnectionIntent = {
			...request,
			identity: {
				...request.identity,
				sessionId: child.bind.source.threadId,
				turnId: child.bind.source.turnId,
			},
		};
		await expect(
			execution.bridge.connectionCallback({
				...childIntent,
				identity: { ...childIntent.identity, sessionId: "unregistered-child" },
			}),
		).rejects.toThrow();
		const start = await connectionStarted(execution, childIntent);
		await execution.bridge.connectionCallback(
			connectionOutcome(start, verifiedConnectionEvidence(start)),
		);
		const savedFacts = facts(await env.saved(), execution);
		const parent = savedFacts.find(
			(fact) => fact.kind === "tool" && fact.toolId === "codex:spawn_agent",
		);
		const leaf = savedFacts.at(-1);
		assert(parent);
		expect(leaf).toMatchObject({
			parentOperationRef: parent.operationRef,
			connection: { verification: "verified" },
		});
		execution.bridge.completeSource(child.bind.source);
		await sourceAck(execution.bridge, terminalSource(child.bind, "completed"));
		await expect(
			execution.bridge.connectionCallback({
				...childIntent,
				requestId: randomUUID(),
				identity: {
					...childIntent.identity,
					callId: randomUUID(),
					attemptRef: randomUUID(),
				},
				connectionRequest: {
					...childIntent.connectionRequest,
					operationNonce: randomUUID(),
					attemptNonce: randomUUID(),
				},
			}),
		).rejects.toThrow();
		expect(options.resolveOriginalClient).toHaveBeenCalledTimes(1);
		expect(execution.bridge.native.turnStarts).toBe(1);
	});
});

function recoveryRead(execution: Execution, origin: CodexConnectionOrigin) {
	const abort = new AbortController();
	const read: RuntimeOriginalEvidenceReadContext = {
		signal: abort.signal,
		expiresAt: Date.now() + 30_000,
		assertCurrent() {
			abort.signal.throwIfAborted();
			return structuredClone(origin.originalBinding);
		},
		async commit(write) {
			this.assertCurrent();
			return write();
		},
	};
	return {
		abort,
		read,
		reference: {
			nativeSessionRef: execution.nativeSessionRef,
			executionId: execution.command.executionId,
			recoveryRequestId: randomUUID(),
		},
	};
}

function recoveryPull(
	profileRef: string,
	previousRecoveryId?: string,
	processNonce: string = randomUUID(),
): CodexConnectionRecoveryRequest {
	return {
		schemaVersion: 2,
		phase: "connection-recovery",
		requestId: randomUUID(),
		profileRef,
		processNonce,
		...(previousRecoveryId ? { previousRecoveryId } : {}),
	};
}

async function recoveryFixture() {
	const { options, configuration } = connectionOptions();
	const resolveReadOnlyClient = vi.fn<
		NonNullable<
			NonNullable<
				CodexRuntimeDriverOptions["connectionClient"]
			>["resolveReadOnlyClient"]
		>
	>(async (_reference, read) => ({
		...structuredClone(configuration),
		originalBinding: read.assertCurrent(),
		credential: {
			...configuration.credential,
			accessToken: "synthetic-recovery-only-token",
			revision: "synthetic-recovery-revision",
		},
	}));
	const env = await setup(undefined, undefined, {
		...options,
		resolveReadOnlyClient,
	});
	const execution = await env.start();
	const { request } = await connectionIntent(execution);
	const start = await connectionStarted(execution, request);
	const verified = verifiedConnectionEvidence(start);
	await execution.bridge.connectionCallback(
		connectionOutcome(start, {
			verification: "unverified",
			reason: "record_unavailable",
			originalResponse: verified.originalResponse,
		}),
	);
	await execution.bridge.completeInferenceTurn();
	const origin = journal(await env.saved(), execution).nativeToolAttempts?.[
		request.identity.attemptRef
	]?.connectionOrigin;
	assert(origin);
	return {
		env,
		execution,
		start,
		verified,
		origin,
		resolveReadOnlyClient,
		options,
	};
}

describe("private cross-process Connection evidence recovery", () => {
	it("reopens the original journal, uses only the current read credential, commits before ACK, and replays identical bytes", async () => {
		const { env, execution, start, verified, origin, resolveReadOnlyClient } =
			await recoveryFixture();
		const before = facts(await env.saved(), execution).at(-1);
		assert(before?.kind === "tool");
		const methods = [...execution.bridge.methods];
		await env.driver.close();
		const reopened = await env.reopen();
		const context = recoveryRead(execution, origin);
		const launch = vi
			.spyOn(BoundDriver.prototype, "launchConnectionRecovery")
			.mockImplementation(async (process) => {
				const request = recoveryPull(process.profile.profileRef);
				const response = await process.recovery(request, process.signal);
				assert(response.decision === "verify");
				expect(response.original.connectionOrigin).toEqual(origin);
				expect(response.currentClient.credential.accessToken).toBe(
					"synthetic-recovery-only-token",
				);
				verified.recordQuery.credentialRevision =
					response.currentClient.credential.revision;
				verified.recordQuery.queriedAt = Date.now();
				verified.verifiedAt = Date.now();
				const update = connectionUpdate(start, verified);
				const ack = await process.evidence(update, process.signal);
				expect(ack.decision).toBe("ack");
				const recovered = facts(await env.saved(), execution).at(-1);
				expect(
					recovered?.kind === "tool" && recovered.connection?.verification,
				).toBe("verified");
				await expect(process.evidence(update, process.signal)).resolves.toEqual(
					ack,
				);
				expect(
					await process.recovery(
						recoveryPull(
							process.profile.profileRef,
							response.recoveryId,
							request.processNonce,
						),
						process.signal,
					),
				).toMatchObject({ decision: "done" });
			});
		await reopened.recoverOriginalEvidence(context.reference, context.read);
		const saved = await env.saved();
		const after = facts(saved, execution).at(-1);
		assert(after?.kind === "tool");
		const { connection: _beforeConnection, ...originalFields } = before;
		const { connection: _afterConnection, ...recoveredFields } = after;
		expect(recoveredFields).toEqual(originalFields);
		expect(
			saved.sessions[execution.nativeSessionRef]?.executions[
				execution.command.executionId
			]?.status,
		).toBe("completed");
		const replay = await reopened.replayEvents(
			execution.nativeSessionRef,
			execution.command.executionId,
		);
		await reopened.recoverOriginalEvidence(context.reference, context.read);
		expect(
			await reopened.replayEvents(
				execution.nativeSessionRef,
				execution.command.executionId,
			),
		).toEqual(replay);
		expect(launch).toHaveBeenCalledTimes(1);
		expect(resolveReadOnlyClient).toHaveBeenCalledTimes(1);
		expect(execution.bridge.methods).toEqual(methods);
		expect(JSON.stringify(saved)).not.toContain(
			"synthetic-recovery-only-token",
		);
	});

	it.each(["origin", "receipt"] as const)(
		"keeps legacy journals without original %s unverified and never requests a credential",
		async (missing) => {
			const { env, execution, origin, resolveReadOnlyClient } =
				await recoveryFixture();
			await env.driver.close();
			const saved = await env.saved();
			const attempt = Object.values(
				journal(saved, execution).nativeToolAttempts ?? {},
			)[0];
			assert(attempt?.connectionEvidence);
			if (missing === "origin") delete attempt.connectionOrigin;
			else delete attempt.connectionEvidence.originalResponse;
			await writeFile(env.path, JSON.stringify(saved));
			const reopened = await env.reopen();
			const context = recoveryRead(execution, origin);
			vi.spyOn(
				BoundDriver.prototype,
				"launchConnectionRecovery",
			).mockImplementation(async (process) => {
				expect(
					await process.recovery(
						recoveryPull(process.profile.profileRef),
						process.signal,
					),
				).toMatchObject({ decision: "done" });
			});
			await reopened.recoverOriginalEvidence(context.reference, context.read);
			expect(resolveReadOnlyClient).not.toHaveBeenCalled();
			const retained = facts(await env.saved(), execution).at(-1);
			expect(
				retained?.kind === "tool" && retained.connection?.verification,
			).toBe("unverified");
		},
	);

	it.each(["execution", "identity", "service", "expired"] as const)(
		"refuses current credential %s mismatch without altering the original outcome",
		async (mismatch) => {
			const { env, execution, origin, resolveReadOnlyClient } =
				await recoveryFixture();
			const implementation = resolveReadOnlyClient.getMockImplementation();
			assert(implementation);
			resolveReadOnlyClient.mockImplementation(async (...args) => {
				const value = await implementation(...args);
				assert(isCodexConnectionClientConfiguration(value));
				if (mismatch === "execution")
					value.originalBinding.scope.executionId = "another-execution";
				if (mismatch === "identity")
					value.connectionIdentity.actorId = "another-actor";
				if (mismatch === "service")
					value.service.serviceRef = "another-service";
				if (mismatch === "expired") value.credential.expiresAt = Date.now() - 1;
				return value;
			});
			const before = facts(await env.saved(), execution);
			const context = recoveryRead(execution, origin);
			vi.spyOn(
				BoundDriver.prototype,
				"launchConnectionRecovery",
			).mockImplementation(async (process) => {
				expect(
					await process.recovery(
						recoveryPull(process.profile.profileRef),
						process.signal,
					),
				).toMatchObject({
					decision: "unavailable",
					reason:
						mismatch === "expired" ? "credential_expired" : "binding_mismatch",
				});
			});
			await env.driver.recoverOriginalEvidence(context.reference, context.read);
			expect(facts(await env.saved(), execution)).toEqual(before);
		},
	);

	it("persists a 16-item budget across reopen and advances the original attempt ring on a new authorized pass", async () => {
		const { options, configuration } = connectionOptions();
		const env = await setup(undefined, undefined, {
			...options,
			resolveReadOnlyClient: async (_reference, read) => ({
				...configuration,
				originalBinding: read.assertCurrent(),
			}),
		});
		const execution = await env.start();
		for (let index = 0; index < 17; index++) {
			const { request } = await connectionIntent(execution);
			const start = await connectionStarted(execution, request);
			await execution.bridge.connectionCallback(
				connectionOutcome(start, {
					verification: "unverified",
					reason: "record_unavailable",
					originalResponse: verifiedConnectionEvidence(start).originalResponse,
				}),
			);
		}
		await execution.bridge.completeInferenceTurn();
		const origin = Object.values(
			journal(await env.saved(), execution).nativeToolAttempts ?? {},
		)[0]?.connectionOrigin;
		assert(origin);
		const context = recoveryRead(execution, origin);
		const passes: string[][] = [];
		const launch = vi
			.spyOn(BoundDriver.prototype, "launchConnectionRecovery")
			.mockImplementation(async (process) => {
				const selected: string[] = [];
				passes.push(selected);
				let request = recoveryPull(process.profile.profileRef);
				for (let index = 0; index < 16; index++) {
					const response = await process.recovery(request, process.signal);
					assert(response.decision === "verify");
					selected.push(response.original.identity.attemptRef);
					request = recoveryPull(
						process.profile.profileRef,
						response.recoveryId,
						request.processNonce,
					);
				}
			});
		await env.driver.recoverOriginalEvidence(context.reference, context.read);
		expect(new Set(passes[0]).size).toBe(16);
		await env.driver.close();
		const reopened = await env.reopen();
		await reopened.recoverOriginalEvidence(context.reference, context.read);
		expect(launch).toHaveBeenCalledTimes(1);
		await reopened.recoverOriginalEvidence(
			{ ...context.reference, recoveryRequestId: randomUUID() },
			context.read,
		);
		expect(new Set(passes[1]).size).toBe(16);
		expect(passes[0]).not.toContain(passes[1]?.[0]);
	});

	it("aborts and reaps recovery before generation confirmation and admits no new pass afterward", async () => {
		const { env, execution, origin, resolveReadOnlyClient } =
			await recoveryFixture();
		const context = recoveryRead(execution, origin);
		let entered = false;
		let reaped = false;
		const launch = vi
			.spyOn(BoundDriver.prototype, "launchConnectionRecovery")
			.mockImplementation(async (process) => {
				const response = await process.recovery(
					recoveryPull(process.profile.profileRef),
					process.signal,
				);
				assert(response.decision === "verify");
				entered = true;
				await new Promise<void>((resolve) =>
					process.signal.addEventListener(
						"abort",
						() => {
							reaped = true;
							resolve();
						},
						{ once: true },
					),
				);
				process.signal.throwIfAborted();
			});
		const pending = env.driver
			.recoverOriginalEvidence(context.reference, context.read)
			.catch(() => {});
		await vi.waitFor(() => expect(entered).toBe(true));
		const { input: _input, ...binding } = execution.command;
		const result = await env.driver.execute({
			...binding,
			kind: "generation-cancel",
			operationId: randomUUID(),
			nativeSessionRef: execution.nativeSessionRef,
		});
		await pending;
		expect(reaped).toBe(true);
		expect(result.result).toMatchObject({
			outcome: "accepted",
			status: "completed",
		});
		const saved = await env.saved();
		await expect(
			env.driver.recoverOriginalEvidence(
				{ ...context.reference, recoveryRequestId: randomUUID() },
				context.read,
			),
		).rejects.toThrow();
		expect(await env.saved()).toEqual(saved);
		expect(launch).toHaveBeenCalledTimes(1);
		expect(resolveReadOnlyClient).toHaveBeenCalledTimes(1);
	});
});

it("linearizes a durable evidence commit before cancellation and rejects every new metadata update after the barrier", async () => {
	const { env, execution, start, verified, origin } = await recoveryFixture();
	const context = recoveryRead(execution, origin);
	const committing =
		Promise.withResolvers<Awaited<ReturnType<typeof holdDirectorySync>>>();
	let acknowledged = false;
	vi.spyOn(
		BoundDriver.prototype,
		"launchConnectionRecovery",
	).mockImplementation(async (process) => {
		const response = await process.recovery(
			recoveryPull(process.profile.profileRef),
			process.signal,
		);
		assert(response.decision === "verify");
		verified.recordQuery.credentialRevision =
			response.currentClient.credential.revision;
		verified.recordQuery.queriedAt = Date.now();
		verified.verifiedAt = Date.now();
		const sync = await holdDirectorySync(env.directory);
		const pending = process.evidence(
			connectionUpdate(start, verified),
			process.signal,
		);
		await sync.entered;
		committing.resolve(sync);
		await pending;
		acknowledged = true;
	});
	const recovery = env.driver
		.recoverOriginalEvidence(context.reference, context.read)
		.catch(() => {});
	const sync = await committing.promise;
	const { input: _input, ...binding } = execution.command;
	let confirmed = false;
	const cancel = env.driver
		.execute({
			...binding,
			kind: "generation-cancel",
			operationId: randomUUID(),
			nativeSessionRef: execution.nativeSessionRef,
		})
		.then((value) => {
			confirmed = true;
			return value;
		});
	try {
		expect(acknowledged).toBe(false);
		expect(confirmed).toBe(false);
	} finally {
		sync.release();
	}
	await recovery;
	expect(await cancel).toMatchObject({
		result: { outcome: "accepted", status: "completed" },
	});
	sync.restore();
	expect(acknowledged).toBe(true);
	const saved = await env.saved();
	const last = facts(saved, execution).at(-1);
	expect(last?.kind === "tool" && last.connection?.verification).toBe(
		"verified",
	);
	await expect(
		execution.bridge.connectionCallback(connectionUpdate(start, verified)),
	).rejects.toThrow();
	expect(await env.saved()).toEqual(saved);
});

it.each([
	"credential-revision",
	"original-receipt",
	"attempt",
	"process",
	"previous",
	"reused-request",
	"phase-request",
] as const)(
	"rejects recovery %s substitution before committing evidence",
	async (mismatch) => {
		const { env, execution, start, verified, origin } = await recoveryFixture();
		const context = recoveryRead(execution, origin);
		const before = facts(await env.saved(), execution);
		vi.spyOn(
			BoundDriver.prototype,
			"launchConnectionRecovery",
		).mockImplementation(async (process) => {
			const request = recoveryPull(process.profile.profileRef);
			const response = await process.recovery(request, process.signal);
			assert(response.decision === "verify");
			if (
				mismatch === "process" ||
				mismatch === "previous" ||
				mismatch === "reused-request"
			) {
				const next = recoveryPull(
					process.profile.profileRef,
					response.recoveryId,
					request.processNonce,
				);
				if (mismatch === "process") next.processNonce = randomUUID();
				if (mismatch === "previous") next.previousRecoveryId = randomUUID();
				if (mismatch === "reused-request") next.requestId = request.requestId;
				await expect(process.recovery(next, process.signal)).rejects.toThrow();
			} else {
				verified.recordQuery.credentialRevision =
					mismatch === "credential-revision"
						? "another-credential"
						: response.currentClient.credential.revision;
				verified.recordQuery.queriedAt = Date.now();
				verified.verifiedAt = Date.now();
				const update = connectionUpdate(start, verified);
				if (mismatch === "original-receipt")
					update.connectionEvidence.originalResponse = {
						...verified.originalResponse,
						receipt: {
							...verified.originalResponse.receipt,
							callRef: "another-real-call",
						},
					};
				if (mismatch === "attempt") update.identity.attemptRef = randomUUID();
				if (mismatch === "phase-request") update.requestId = start.requestId;
				await expect(
					process.evidence(update, process.signal),
				).rejects.toThrow();
			}
		});
		await env.driver.recoverOriginalEvidence(context.reference, context.read);
		expect(facts(await env.saved(), execution)).toEqual(before);
	},
);

it("cancels a blocked credential resolver without waiting for it or admitting its late value", async () => {
	const { env, execution, origin, resolveReadOnlyClient } =
		await recoveryFixture();
	const context = recoveryRead(execution, origin);
	const credential = Promise.withResolvers<unknown>();
	const resolving = Promise.withResolvers<void>();
	resolveReadOnlyClient.mockImplementation(() => {
		resolving.resolve();
		return credential.promise;
	});
	vi.spyOn(
		BoundDriver.prototype,
		"launchConnectionRecovery",
	).mockImplementation(async (process) => {
		await process.recovery(
			recoveryPull(process.profile.profileRef),
			process.signal,
		);
	});
	const pending = env.driver
		.recoverOriginalEvidence(context.reference, context.read)
		.catch(() => {});
	await resolving.promise;
	const { input: _input, ...binding } = execution.command;
	const cancel = await env.driver.execute({
		...binding,
		kind: "generation-cancel",
		operationId: randomUUID(),
		nativeSessionRef: execution.nativeSessionRef,
	});
	expect(cancel.result).toMatchObject({
		outcome: "accepted",
		status: "completed",
	});
	await pending;
	const saved = await env.saved();
	credential.resolve({ credential: { accessToken: "synthetic-late-secret" } });
	await Promise.resolve();
	expect(await env.saved()).toEqual(saved);
});
