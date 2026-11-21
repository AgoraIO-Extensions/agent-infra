import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeDriverSubmitTurnCommandV2 } from "@agent-infra/contracts/runtime";
import { afterEach, expect, it } from "vitest";
import {
	CODEX_OFFICIAL_LANE_CONFIG,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import {
	type CodexDynamicConnectionClientV1,
	CodexDynamicConnectionRefusalV1,
	type CodexRuntimeDriver,
	type CodexRuntimeDriverOptions,
	codexDynamicConnectionRefusalsV1,
} from "./codex-runtime-driver.js";
import { openCodexRuntimeDriverForTest } from "./codex-runtime-driver.test-support.js";
import {
	closeStandardMcpFixtures,
	reference,
	standardMcpFixture,
	token,
} from "./standard-mcp.fixture.js";
import { standardMcpDigest } from "./standard-mcp-client.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closes.splice(0).reverse()) await close();
	await closeStandardMcpFixtures();
});

class StandardToolNativeFixture {
	readonly sent: CodexAppServerFrame[] = [];
	readonly replies: CodexAppServerFrame[] = [];
	definitions: { tools: { name: string }[] }[] = [];
	private queue: CodexAppServerFrame[] = [];
	private wake?: () => void;
	closed = false;
	status = "inProgress";
	turnId = "fixture-turn";
	options?: CodexAppServerBridgeOptions;
	push(frame: CodexAppServerFrame) {
		this.queue.push(frame);
		this.wake?.();
		this.wake = undefined;
	}
	async send(frame: CodexAppServerFrame) {
		this.sent.push(frame);
		if (!frame.method) {
			this.replies.push(frame);
			return;
		}
		let result: unknown = {};
		if (frame.method === "config/read") {
			const config: Record<string, unknown> = {
				model: this.options?.model,
				model_reasoning_effort: "high",
				mcp_servers: {},
				plugins: {},
				marketplaces: {},
				features: { plugins: false },
			};
			const origins: Record<string, unknown> = {};
			for (const key of ["model", "model_reasoning_effort", "features.plugins"])
				origins[key] = { name: { type: "sessionFlags" }, version: "1" };
			// 按固定 Codex 的 config/read 形状：嵌套对象，数组按元素记录来源。
			for (const [key, value] of Object.entries(CODEX_OFFICIAL_LANE_CONFIG)) {
				const parts = key.split(".");
				let container = config;
				for (const part of parts.slice(0, -1)) {
					container[part] ??= {};
					container = container[part] as Record<string, unknown>;
				}
				container[parts.at(-1) as string] = structuredClone(value);
				for (const originKey of Array.isArray(value)
					? value.map((_, index) => `${key}.${index}`)
					: [key])
					origins[originKey] = { name: { type: "sessionFlags" }, version: "1" };
			}
			const provider = {
				name: "Agent Infra Active Model",
				base_url: this.options?.modelAccess?.endpoint,
				env_key: "AGENT_INFRA_CODEX_MODEL_CREDENTIAL",
				wire_api: "responses",
				requires_openai_auth: false,
				supports_websockets: false,
				request_max_retries: 0,
				stream_max_retries: 0,
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
			config.model_provider = "agent_infra";
			config.model_providers = { agent_infra: provider };
			for (const key of [
				"model_provider",
				...Object.keys(provider)
					.filter((key) => provider[key as keyof typeof provider] !== null)
					.map((key) => `model_providers.agent_infra.${key}`),
			])
				origins[key] = { name: { type: "sessionFlags" }, version: "1" };
			result = { config, origins };
		} else if (frame.method === "model/list") {
			result = {
				data: [
					{
						model: "fixture-model",
						supportedReasoningEfforts: [{ reasoningEffort: "high" }],
					},
				],
				nextCursor: null,
			};
		} else if (frame.method === "thread/start") {
			this.definitions =
				(frame.params as { dynamicTools?: { tools: { name: string }[] }[] })
					.dynamicTools ?? [];
			result = { thread: { id: "fixture-thread" } };
		} else if (frame.method === "thread/resume")
			result = { thread: { id: "fixture-thread" } };
		else if (frame.method === "turn/start") {
			result = { turn: { id: this.turnId, status: this.status } };
		} else if (frame.method === "thread/turns/list")
			result = {
				data: [{ id: this.turnId, status: this.status, items: [] }],
				nextCursor: null,
			};
		else if (frame.method === "thread/items/list")
			result = { data: [], nextCursor: null };
		else if (frame.method === "turn/interrupt") this.status = "interrupted";
		else if (frame.method !== "initialize")
			throw new Error(`Unexpected fixture method ${frame.method}`);
		this.push({ id: frame.id, result });
		if (frame.method === "turn/start")
			this.push({
				method: "turn/started",
				params: {
					threadId: "fixture-thread",
					turn: { id: this.turnId, status: "inProgress", items: [] },
				},
			});
	}
	async *frames() {
		while (!this.closed) {
			const frame = this.queue.shift();
			if (frame) yield frame;
			else
				await new Promise<void>((resolve) => {
					this.wake = resolve;
				});
		}
	}
	async close() {
		this.closed = true;
		this.wake?.();
	}
	call(id = "call-request", patch: Record<string, unknown> = {}) {
		const alias = this.definitions[0]?.tools[0]?.name;
		if (!alias) throw new Error("Missing actual Driver definitions");
		this.push({
			id,
			method: "item/tool/call",
			params: {
				threadId: "fixture-thread",
				turnId: this.turnId,
				callId: "fixture-call",
				namespace: "connection",
				tool: alias,
				arguments: { text: "fixture-note" },
				...patch,
			},
		});
	}
}

const command: RuntimeDriverSubmitTurnCommandV2 = {
	schemaVersion: 2,
	kind: "submit-turn",
	operationId: reference.executionId,
	...reference,
	turnId: "turn-a",
	input: { text: "fixture instruction", attachments: [] },
	selection: {
		schemaVersion: 1,
		modelOptionId: "fixture-option",
		reasoningLevel: "high",
	},
};

async function setup(standardInstalled = true) {
	const fixture = await standardMcpFixture();
	const directory = await mkdtemp(join(tmpdir(), "standard-mcp-driver-"));
	closes.push(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "driver.json");
	const authorization: string[] = [];
	const fetchMethods: string[] = [];
	const options: CodexRuntimeDriverOptions = {
		nativeLane: "official-model-only",
		path,
		configVersion: "fixture-config",
		defaultModelOptionId: "fixture-option",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "fixture-option",
				model: "fixture-model",
				reasoningLevels: ["high"],
				endpoint: "https://relay.example.test",
				credential: "fixture-model-credential",
			},
		],
		authorizeExternalAction: async (action) => {
			authorization.push(action.kind);
			return { revalidate: () => {} };
		},
		standardConnectionClient: {
			target: fixture.target,
			resolveInput: async (ref) => ({
				...fixture.input,
				scope: {
					agentId: ref.agentId,
					conversationId: ref.conversationId,
					executionId: ref.executionId,
					sessionGeneration: ref.sessionGeneration,
				},
			}),
			fetch: (url, init) => {
				if (typeof init?.body === "string")
					fetchMethods.push(JSON.parse(init.body).method);
				return fixture.fetch(url, init);
			},
		},
	};
	const native = new StandardToolNativeFixture();
	const { standardConnectionClient: _standard, ...modelOnlyOptions } = options;
	const driver = await openCodexRuntimeDriverForTest(
		standardInstalled ? options : modelOnlyOptions,
		async (opened) => {
			native.options = opened;
			return native;
		},
	);
	closes.push(() => driver.close());
	const accepted = await driver.execute(command);
	expect(accepted.result).toMatchObject({
		outcome: "accepted",
		status: "running",
	});
	return {
		fixture,
		native,
		driver,
		path,
		options,
		ref: accepted.nativeSessionRef,
		authorization,
		fetchMethods,
	};
}

it.each([false, true])(
	"preserves existing Thread tool binding across standard installation changes, previous=%s",
	async (previous) => {
		const env = await setup(previous);
		env.native.status = "completed";
		env.native.push({
			method: "turn/completed",
			params: {
				threadId: "fixture-thread",
				turn: { id: "fixture-turn", status: "completed", items: [] },
			},
		});
		await waitFor(
			async () =>
				(await env.driver.getStatus(env.ref, reference.executionId)) ===
				"completed",
		);
		await env.driver.close();
		const { standardConnectionClient: _standard, ...modelOnlyOptions } =
			env.options;
		const native = new StandardToolNativeFixture();
		native.turnId = "fixture-turn-b";
		const restored = await openCodexRuntimeDriverForTest(
			previous ? modelOnlyOptions : env.options,
			async (opened) => {
				native.options = opened;
				return native;
			},
		);
		closes.push(() => restored.close());
		const before = env.fixture.trace.length;
		const next = {
			...command,
			executionId: "execution-b",
			operationId: "execution-b",
			turnId: "turn-b",
		};
		if (previous) {
			// #3373：Thread 的工具快照与当前部署不一致时没有发出任何原生调用，声明本次 Turn 未提交。
			await expect(restored.execute(next)).rejects.toMatchObject({
				code: "RUNTIME_TURN_NOT_SUBMITTED",
				reason: "session_preparation_failed",
			});
			expect(await restored.lookupOperation(next)).toEqual({
				state: "missing",
			});
		} else
			expect((await restored.execute(next)).result).toMatchObject({
				outcome: "accepted",
				status: "running",
			});
		expect(env.fixture.trace).toHaveLength(before);
		expect(
			native.sent.filter((frame) => frame.method === "thread/start"),
		).toHaveLength(0);
		expect(
			native.sent.filter((frame) => frame.method === "turn/start"),
		).toHaveLength(previous ? 0 : 1);
		expect(await restored.getStatus(env.ref, reference.executionId)).toBe(
			"completed",
		);
	},
);

async function waitFor(predicate: () => Promise<boolean> | boolean) {
	await expect.poll(predicate, { timeout: 4000, interval: 10 }).toBe(true);
}

async function operationEvents(driver: CodexRuntimeDriver, ref: string) {
	return (await driver.replayEvents(ref, reference.executionId)).filter(
		(event) => event.type === "operation",
	);
}

interface FixtureDriverState {
	sessions: Record<
		string,
		{
			activeExecutionId?: string;
			executions: Record<string, { nativeTurnId: string; status: string }>;
			journals: Record<
				string,
				{
					events: {
						cursor: string;
						type: string;
						payload: { phase?: string };
					}[];
					standardMcpCalls?: Record<
						string,
						{
							phase: string;
							held?: true;
							rpcRequestId?: string | number;
							requestDigest?: string;
						}
					>;
				}
			>;
		}
	>;
}
interface DriverFailureFixture {
	readState(): FixtureDriverState;
	update<T>(change: (state: FixtureDriverState) => T): Promise<T>;
	awaitStandardMcpAck(
		ref: string,
		execution: string,
		cursor: string,
		signal: AbortSignal,
	): Promise<void>;
}

it.each(["failed", "changed"] as const)(
	"holds the original execution without sending after RPC preparation is %s",
	async (outcome) => {
		const env = await setup();
		const internal = env.driver as unknown as DriverFailureFixture;
		const update = internal.update.bind(internal);
		let requestPrepared = false;
		internal.update = async (change) => {
			const probe = structuredClone(internal.readState());
			change(probe);
			const prepared = Object.values(probe.sessions).some((session) =>
				Object.values(session.journals).some((journal) =>
					Object.values(journal.standardMcpCalls ?? {}).some(
						(call) =>
							call.phase === "intent" && call.rpcRequestId !== undefined,
					),
				),
			);
			if (prepared && !requestPrepared) {
				requestPrepared = true;
				if (outcome === "failed")
					throw new Error("Controlled request write failure");
				const committed = await update(change);
				env.fixture.input = { ...env.fixture.input, credentialRevision: "r2" };
				return committed;
			}
			return update(change);
		};
		try {
			env.native.call();
			await waitFor(async () =>
				(await operationEvents(env.driver, env.ref)).some(
					(event) => event.payload.phase === "intent",
				),
			);
			const intent = (await operationEvents(env.driver, env.ref)).at(-1);
			if (!intent) throw new Error("Missing intent");
			await env.driver.acknowledgeEvents(
				env.ref,
				reference.executionId,
				intent.cursor,
			);
			await waitFor(async () =>
				(await operationEvents(env.driver, env.ref)).some(
					(event) => event.payload.phase === "unknown",
				),
			);
			const unknown = (await operationEvents(env.driver, env.ref)).at(-1);
			if (!unknown) throw new Error("Missing unknown result");
			await env.driver.acknowledgeEvents(
				env.ref,
				reference.executionId,
				unknown.cursor,
			);
			await waitFor(() => env.native.closed);
			expect(requestPrepared).toBe(true);
			expect(
				(await operationEvents(env.driver, env.ref)).map(
					(event) => event.payload.phase,
				),
			).toEqual(["intent", "unknown"]);
			const calls = Object.values(
				internal.readState().sessions[env.ref]?.journals ?? {},
			).flatMap((journal) => Object.values(journal.standardMcpCalls ?? {}));
			expect(calls[0]?.rpcRequestId !== undefined).toBe(outcome === "changed");
			if (outcome === "changed")
				expect(calls[0]?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
			expect(
				env.fetchMethods.filter((method) => method === "tools/call"),
			).toHaveLength(0);
			expect(
				env.fixture.trace.filter((request) => request.method === "tools/call"),
			).toHaveLength(0);
			expect(internal.readState().sessions[env.ref]?.activeExecutionId).toBe(
				reference.executionId,
			);
			expect(await env.driver.getStatus(env.ref, reference.executionId)).toBe(
				"unknown",
			);
		} finally {
			internal.update = update;
		}
	},
);

it("does not release occupancy after a transient failed hold write and native completion", async () => {
	const env = await setup();
	const internal = env.driver as unknown as DriverFailureFixture;
	const update = internal.update.bind(internal);
	const ack = internal.awaitStandardMcpAck.bind(internal);
	let ackFailed = false;
	let holdFailed = false;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	internal.awaitStandardMcpAck = async (ref, execution, cursor, signal) => {
		const session = internal.readState().sessions[ref];
		const turn = session?.executions[execution]?.nativeTurnId;
		if (
			turn &&
			session?.journals[turn]?.events.find((event) => event.cursor === cursor)
				?.payload.phase === "completed"
		) {
			ackFailed = true;
			throw new Error("Controlled result ACK failure");
		}
		return ack(ref, execution, cursor, signal);
	};
	internal.update = async (change) => {
		const probe = structuredClone(internal.readState());
		change(probe);
		const held = Object.values(probe.sessions).some((session) =>
			Object.values(session.journals).some((journal) =>
				Object.values(journal.standardMcpCalls ?? {}).some((call) => call.held),
			),
		);
		if (ackFailed && held && !holdFailed) {
			holdFailed = true;
			entered.resolve();
			await release.promise;
			throw new Error("Controlled one failed hold write");
		}
		return update(change);
	};
	try {
		env.native.call();
		await waitFor(async () =>
			(await operationEvents(env.driver, env.ref)).some(
				(event) => event.payload.phase === "intent",
			),
		);
		const intent = (await operationEvents(env.driver, env.ref)).at(-1);
		if (!intent) throw new Error("Missing intent");
		await env.driver.acknowledgeEvents(
			env.ref,
			reference.executionId,
			intent.cursor,
		);
		await entered.promise;
		env.native.status = "completed";
		env.native.push({
			method: "turn/completed",
			params: {
				threadId: "fixture-thread",
				turn: { id: "fixture-turn", status: "completed", items: [] },
			},
		});
		await waitFor(() =>
			Object.values(
				internal.readState().sessions[env.ref]?.journals ?? {},
			).some((journal) =>
				Object.values(journal.standardMcpCalls ?? {}).some((call) => call.held),
			),
		);
		expect(internal.readState().sessions[env.ref]?.activeExecutionId).toBe(
			reference.executionId,
		);
		expect(
			internal.readState().sessions[env.ref]?.executions[reference.executionId]
				?.status,
		).toBe("running");
		expect(await env.driver.getStatus(env.ref, reference.executionId)).toBe(
			"unknown",
		);
	} finally {
		internal.update = update;
		internal.awaitStandardMcpAck = ack;
		release.resolve();
	}
});

it("actual Driver waits for original intent and result ACKs and sends MCP only once", async () => {
	const env = await setup();
	env.native.call();
	await waitFor(async () =>
		(await operationEvents(env.driver, env.ref)).some(
			(event) => event.payload.phase === "intent",
		),
	);
	expect(
		env.fixture.trace.filter((request) => request.method === "tools/call"),
	).toHaveLength(0);
	const intent = (await operationEvents(env.driver, env.ref)).at(-1);
	if (!intent) throw new Error("Missing intent");
	await expect(
		env.driver.validateExternalAction({
			nativeSessionRef: env.ref,
			executionId: reference.executionId,
			runtimeOperationId: reference.executionId,
			operationRef: intent.payload.operationRef,
			attemptRef: intent.payload.attemptRef,
			kind: "tool",
			toolId: "workspace.read_text_file",
		}),
	).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
	await env.driver.acknowledgeEvents(
		env.ref,
		reference.executionId,
		intent.cursor,
	);
	await waitFor(async () =>
		(await operationEvents(env.driver, env.ref)).some(
			(event) => event.payload.phase === "completed",
		),
	);
	expect(env.native.replies).toHaveLength(0);
	const final = (await operationEvents(env.driver, env.ref)).at(-1);
	if (!final) throw new Error("Missing result");
	await env.driver.acknowledgeEvents(
		env.ref,
		reference.executionId,
		final.cursor,
	);
	await waitFor(() => env.native.replies.length === 1);
	expect(env.native.replies[0]?.result).toMatchObject({ success: true });
	expect(
		(await operationEvents(env.driver, env.ref)).map(
			(event) => event.payload.phase,
		),
	).toEqual(["intent", "started", "completed"]);
	expect(env.authorization.every((kind) => kind === "tool")).toBe(true);
	env.native.call("duplicate-id");
	await waitFor(() => env.native.replies.length === 2);
	expect(
		env.fixture.trace.filter((request) => request.method === "tools/call"),
	).toHaveLength(1);
	expect(
		env.fetchMethods.filter((method) => method === "tools/call"),
	).toHaveLength(1);
	expect(JSON.stringify(env.native.sent)).not.toContain(token);
	expect(await readFile(env.path, "utf8")).not.toContain(token);
	expect(final.payload).toMatchObject({
		connection: {
			verification: "unverified",
			reason: "record_unavailable",
			consumerId: "platform",
			instanceRef: "instance-a",
			credentialRevision: "r1",
		},
	});
});

it.each([false, true])(
	"unknown WRITE keeps original occupancy across restart with installed input=%s",
	async (installedAfterRestart) => {
		const env = await setup();
		env.fixture.setBehavior("unknown");
		env.native.call();
		await waitFor(async () =>
			(await operationEvents(env.driver, env.ref)).some(
				(event) => event.payload.phase === "intent",
			),
		);
		const intent = (await operationEvents(env.driver, env.ref)).at(-1);
		if (!intent) throw new Error("Missing intent");
		await env.driver.acknowledgeEvents(
			env.ref,
			reference.executionId,
			intent.cursor,
		);
		await waitFor(async () =>
			(await operationEvents(env.driver, env.ref)).some(
				(event) => event.payload.phase === "unknown",
			),
		);
		const unknown = (await operationEvents(env.driver, env.ref)).at(-1);
		if (!unknown) throw new Error("Missing unknown");
		await env.driver.acknowledgeEvents(
			env.ref,
			reference.executionId,
			unknown.cursor,
		);
		await waitFor(() => env.native.closed);
		expect(env.native.replies).toHaveLength(0);
		expect(await env.driver.getStatus(env.ref, reference.executionId)).toBe(
			"unknown",
		);
		await env.driver.close();
		const { standardConnectionClient: _standard, ...modelOnlyOptions } =
			env.options;
		const restored = await openCodexRuntimeDriverForTest(
			installedAfterRestart ? env.options : modelOnlyOptions,
			async (opened) => {
				const native = new StandardToolNativeFixture();
				native.options = opened;
				return native;
			},
		);
		closes.push(() => restored.close());
		expect(await restored.getStatus(env.ref, reference.executionId)).toBe(
			"unknown",
		);
		expect(
			env.fixture.trace.filter((request) => request.method === "tools/call"),
		).toHaveLength(1);
		const state = JSON.parse(await readFile(env.path, "utf8"));
		expect(state.sessions[env.ref].activeExecutionId).toBe(
			reference.executionId,
		);
	},
);

it.each([
	{ threadId: "foreign-thread" },
	{ namespace: "other" },
	{ arguments: { text: "fixture", principal: "other" } },
])(
	"rejects forged native mapping before external dispatch (%j)",
	async (patch) => {
		const env = await setup();
		env.native.call("forged", patch);
		await waitFor(() => env.native.closed);
		expect(
			env.fixture.trace.filter((request) => request.method === "tools/call"),
		).toHaveLength(0);
	},
);

// #4333 §13.5.6 动态安装的 reader 与可见起点 (ADR-0048): a Thread declares the
// approved contract's tools at start; each call reads its installation.
const declaredTools = {
	contract: { ref: "fixture-mcp-contract", revision: "r1" },
	tools: [
		{
			name: "write_note",
			description: "Write a note",
			inputSchema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
				additionalProperties: false,
			},
		},
	],
};

async function setupDynamic(
	declared: CodexDynamicConnectionClientV1["declared"] = declaredTools,
) {
	const env = await setup(false);
	await env.driver.close();
	closes.pop();
	const reader = {
		refusal: "authorization_required" as
			| "authorization_required"
			| "unavailable"
			| undefined,
		inputRefusal: undefined as
			| "authorization_required"
			| "unavailable"
			| undefined,
		targets: 0,
		inputs: 0,
	};
	const dynamicConnectionClient: CodexDynamicConnectionClientV1 = {
		declared,
		resolveTarget: async () => {
			reader.targets++;
			if (reader.refusal)
				throw new CodexDynamicConnectionRefusalV1(reader.refusal);
			return env.fixture.target;
		},
		resolveInput: async (ref) => {
			reader.inputs++;
			if (reader.inputRefusal)
				throw new CodexDynamicConnectionRefusalV1(reader.inputRefusal);
			return {
				...env.fixture.input,
				scope: {
					agentId: ref.agentId,
					conversationId: ref.conversationId,
					executionId: ref.executionId,
					sessionGeneration: ref.sessionGeneration,
				},
			};
		},
		fetch: env.options.standardConnectionClient?.fetch,
	};
	const { standardConnectionClient: _standard, ...modelOnly } = env.options;
	const options: CodexRuntimeDriverOptions = {
		...modelOnly,
		path: `${env.path}.dynamic`,
		dynamicConnectionClient,
	};
	const native = new StandardToolNativeFixture();
	const driver = await openCodexRuntimeDriverForTest(
		options,
		async (opened) => {
			native.options = opened;
			return native;
		},
	);
	closes.push(() => driver.close());
	const accepted = await driver.execute(command);
	expect(accepted.result).toMatchObject({
		outcome: "accepted",
		status: "running",
	});
	return {
		...env,
		native,
		driver,
		path: options.path,
		options,
		modelOnly: { ...modelOnly, path: options.path },
		ref: accepted.nativeSessionRef,
		reader,
	};
}

async function settleCall(
	env: Awaited<ReturnType<typeof setupDynamic>>,
	replies: number,
	execution = reference.executionId,
) {
	const acknowledged = new Set<string>();
	await waitFor(async () => {
		for (const event of (
			await env.driver.replayEvents(env.ref, execution)
		).filter((event) => event.type === "operation")) {
			if (acknowledged.has(event.cursor)) continue;
			acknowledged.add(event.cursor);
			await env.driver.acknowledgeEvents(env.ref, execution, event.cursor);
		}
		return env.native.replies.length >= replies;
	});
	return env.native.replies.at(-1)?.result as {
		success: boolean;
		contentItems: { type: string; text: string }[];
	};
}

const toolCalls = (env: Awaited<ReturnType<typeof setupDynamic>>) =>
	env.fixture.trace.filter((request) => request.method === "tools/call").length;

it("declares the contract's tools at thread start without calling the reader", async () => {
	const env = await setupDynamic();
	expect(env.native.definitions).toEqual([
		{
			type: "namespace",
			name: "connection",
			description: "Approved Connection tools",
			tools: [
				{
					type: "function",
					name: expect.stringMatching(/^mcp_[a-f0-9]{32}$/),
					description: "write_note: Write a note",
					inputSchema: declaredTools.tools[0]?.inputSchema,
				},
			],
		},
	]);
	expect(env.reader).toMatchObject({ targets: 0, inputs: 0 });
	expect(env.fixture.trace).toHaveLength(0);
	expect(
		JSON.parse(await readFile(env.path, "utf8")).sessions[env.ref]
			.dynamicConnection,
	).toEqual({
		contract: declaredTools.contract,
		toolsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
});

it.each(["authorization_required", "unavailable"] as const)(
	"answers a %s reader refusal with the fixed result before any Connection request",
	async (reason) => {
		const env = await setupDynamic();
		env.reader.refusal = reason;
		env.native.call();
		const reply = await settleCall(env, 1);
		expect(reply.success).toBe(false);
		expect(JSON.parse(reply.contentItems[0]?.text ?? "")).toEqual(
			codexDynamicConnectionRefusalsV1[reason],
		);
		expect(reply.contentItems[0]?.text).not.toContain(token);
		expect(env.reader.targets).toBe(1);
		expect(env.fixture.trace).toHaveLength(0);
		expect(
			(await operationEvents(env.driver, env.ref)).map(
				(event) => event.payload.phase,
			),
		).toEqual(["intent", "failed"]);
		expect(await env.driver.getStatus(env.ref, reference.executionId)).toBe(
			"running",
		);
		expect(env.native.closed).toBe(false);
	},
);

it("does not retry an unavailable input readback and sends nothing to Connection", async () => {
	const env = await setupDynamic();
	env.reader.refusal = undefined;
	env.reader.inputRefusal = "unavailable";
	env.native.call();
	const reply = await settleCall(env, 1);
	expect(JSON.parse(reply.contentItems[0]?.text ?? "")).toEqual(
		codexDynamicConnectionRefusalsV1.unavailable,
	);
	expect(env.reader).toMatchObject({ targets: 1, inputs: 1 });
	expect(env.fixture.trace).toHaveLength(0);
});

it("serves a later call in the same session after the permit is written, then refuses after revocation", async () => {
	const env = await setupDynamic();
	env.native.call("call-before", { callId: "call-before" });
	const before = await settleCall(env, 1);
	expect(JSON.parse(before.contentItems[0]?.text ?? "")).toEqual(
		codexDynamicConnectionRefusalsV1.authorization_required,
	);
	env.reader.refusal = undefined;
	env.native.call("call-after", { callId: "call-after" });
	const after = await settleCall(env, 2);
	expect(after.success).toBe(true);
	expect(toolCalls(env)).toBe(1);
	expect(
		env.native.sent.filter((frame) => frame.method === "thread/start"),
	).toHaveLength(1);
	env.reader.inputRefusal = "authorization_required";
	env.native.call("call-revoked", { callId: "call-revoked" });
	const revoked = await settleCall(env, 3);
	expect(JSON.parse(revoked.contentItems[0]?.text ?? "")).toEqual(
		codexDynamicConnectionRefusalsV1.authorization_required,
	);
	expect(toolCalls(env)).toBe(1);
	expect(await env.driver.getStatus(env.ref, reference.executionId)).toBe(
		"running",
	);
});

it("refuses a discovery that differs from the declaration and keeps the declaration", async () => {
	const env = await setupDynamic({
		...declaredTools,
		tools: [
			{ ...declaredTools.tools[0], description: "Write a draft" },
		] as typeof declaredTools.tools,
	});
	const declared = structuredClone(env.native.definitions);
	env.reader.refusal = undefined;
	env.native.call();
	const reply = await settleCall(env, 1);
	expect(JSON.parse(reply.contentItems[0]?.text ?? "")).toEqual(
		codexDynamicConnectionRefusalsV1.unavailable,
	);
	expect(toolCalls(env)).toBe(0);
	expect(env.native.definitions).toEqual(declared);
	expect(
		env.native.sent.filter((frame) => frame.method === "thread/start"),
	).toHaveLength(1);
});

async function completeTurn(env: Awaited<ReturnType<typeof setupDynamic>>) {
	env.native.status = "completed";
	env.native.push({
		method: "turn/completed",
		params: {
			threadId: "fixture-thread",
			turn: { id: "fixture-turn", status: "completed", items: [] },
		},
	});
	await waitFor(
		async () =>
			(await env.driver.getStatus(env.ref, reference.executionId)) ===
			"completed",
	);
	await env.driver.close();
}

const nextCommand = {
	...command,
	executionId: "execution-b",
	operationId: "execution-b",
	turnId: "turn-b",
};

it("does not add declared tools to a Thread started without them", async () => {
	const env = await setupDynamic();
	// Start a Thread on a model-only Driver first, then enable the contract.
	const plain = new StandardToolNativeFixture();
	const path = `${env.path}.plain`;
	const before = await openCodexRuntimeDriverForTest(
		{ ...env.modelOnly, path },
		async (opened) => {
			plain.options = opened;
			return plain;
		},
	);
	closes.push(() => before.close());
	const accepted = await before.execute(command);
	await completeTurn({
		...env,
		driver: before,
		native: plain,
		ref: accepted.nativeSessionRef,
	});
	const native = new StandardToolNativeFixture();
	native.turnId = "fixture-turn-b";
	const restored = await openCodexRuntimeDriverForTest(
		{ ...env.options, path },
		async (opened) => {
			native.options = opened;
			return native;
		},
	);
	closes.push(() => restored.close());
	expect((await restored.execute(nextCommand)).result).toMatchObject({
		outcome: "accepted",
		status: "running",
	});
	expect(
		native.sent.filter((frame) => frame.method === "thread/start"),
	).toHaveLength(0);
	expect(
		JSON.parse(await readFile(path, "utf8")).sessions[accepted.nativeSessionRef]
			.dynamicConnection,
	).toBeUndefined();
	expect(env.reader).toMatchObject({ targets: 0, inputs: 0 });
});

it("keeps a declared Thread usable with fixed refusals after the Host loses the contract", async () => {
	const env = await setupDynamic();
	await completeTurn(env);
	const native = new StandardToolNativeFixture();
	native.turnId = "fixture-turn-b";
	native.definitions = structuredClone(env.native.definitions);
	const restored = await openCodexRuntimeDriverForTest(
		env.modelOnly,
		async (opened) => {
			native.options = opened;
			return native;
		},
	);
	closes.push(() => restored.close());
	expect((await restored.execute(nextCommand)).result).toMatchObject({
		outcome: "accepted",
		status: "running",
	});
	expect(
		native.sent.filter((frame) => frame.method === "thread/start"),
	).toHaveLength(0);
	native.call();
	const reply = await settleCall(
		{ ...env, driver: restored, native },
		1,
		nextCommand.executionId,
	);
	expect(JSON.parse(reply.contentItems[0]?.text ?? "")).toEqual(
		codexDynamicConnectionRefusalsV1.unavailable,
	);
	expect(env.reader).toMatchObject({ targets: 0, inputs: 0 });
	expect(env.fixture.trace).toHaveLength(0);
	expect(await restored.getStatus(env.ref, nextCommand.executionId)).toBe(
		"running",
	);
});

it.each([
	["renames its tool", { revision: "r2", name: "rename_note" }],
	["removes its tool", { revision: "r1", name: "list_notes" }],
] as const)(
	"keeps a declared Thread usable with fixed refusals after a contract revision %s",
	async (_label, revised) => {
		const env = await setupDynamic();
		await completeTurn(env);
		const current = env.options.dynamicConnectionClient;
		if (!current) throw new Error("Missing dynamic client");
		const native = new StandardToolNativeFixture();
		native.turnId = "fixture-turn-b";
		// The Thread still calls the alias it was declared with at thread start.
		native.definitions = structuredClone(env.native.definitions);
		const restored = await openCodexRuntimeDriverForTest(
			{
				...env.options,
				dynamicConnectionClient: {
					...current,
					declared: {
						contract: {
							ref: declaredTools.contract.ref,
							revision: revised.revision,
						},
						tools: [
							{ ...declaredTools.tools[0], name: revised.name },
						] as typeof declaredTools.tools,
					},
				},
			},
			async (opened) => {
				native.options = opened;
				return native;
			},
		);
		closes.push(() => restored.close());
		expect((await restored.execute(nextCommand)).result).toMatchObject({
			outcome: "accepted",
			status: "running",
		});
		expect(
			native.sent.filter((frame) => frame.method === "thread/start"),
		).toHaveLength(0);
		native.call();
		const reply = await settleCall(
			{ ...env, driver: restored, native },
			1,
			nextCommand.executionId,
		);
		expect(JSON.parse(reply.contentItems[0]?.text ?? "")).toEqual(
			codexDynamicConnectionRefusalsV1.unavailable,
		);
		expect(native.closed).toBe(false);
		expect(env.reader).toMatchObject({ targets: 0, inputs: 0 });
		expect(toolCalls(env)).toBe(0);
		expect(env.fixture.trace).toHaveLength(0);
		expect(await restored.getStatus(env.ref, nextCommand.executionId)).toBe(
			"running",
		);
	},
);

// A well-formed alias the Thread was never declared with.
const forgedAlias = `mcp_${standardMcpDigest("forged_note").slice(0, 32)}`;

it.each([
	["a well-formed undeclared alias", forgedAlias, undefined],
	["a well-formed undeclared alias", forgedAlias, "authorization_required"],
	["a malformed alias", "write_note", undefined],
	["a malformed alias", "write_note", "authorization_required"],
] as const)(
	"rejects %s on a declared Thread before any reader or Connection traffic (alias %s, reader refusal %s)",
	async (_label, alias, readerRefusal) => {
		const env = await setupDynamic();
		env.reader.refusal = readerRefusal;
		env.native.call("forged", { tool: alias });
		await waitFor(() => env.native.closed);
		expect(env.native.replies).toHaveLength(0);
		expect(env.reader).toMatchObject({ targets: 0, inputs: 0 });
		expect(env.fixture.trace).toHaveLength(0);
		expect(env.fetchMethods).toHaveLength(0);
		expect(await operationEvents(env.driver, env.ref)).toHaveLength(0);
	},
);

it("narrows a declared Thread's aliases to the current list while the contract equals its declaration", async () => {
	const env = await setupDynamic();
	// Positive: the declared alias reaches the reader and gets the fixed result.
	env.native.call("declared", { callId: "declared" });
	const reply = await settleCall(env, 1);
	expect(JSON.parse(reply.contentItems[0]?.text ?? "")).toEqual(
		codexDynamicConnectionRefusalsV1.authorization_required,
	);
	expect(env.reader).toMatchObject({ targets: 1 });
	expect(env.native.closed).toBe(false);
	// Negative: an alias outside the current list is refused before the reader.
	env.reader.refusal = undefined;
	env.native.call("undeclared", { callId: "undeclared", tool: forgedAlias });
	await waitFor(() => env.native.closed);
	expect(env.native.replies).toHaveLength(1);
	expect(env.reader).toMatchObject({ targets: 1, inputs: 0 });
	expect(env.fixture.trace).toHaveLength(0);
	expect(
		(await operationEvents(env.driver, env.ref)).map(
			(event) => event.payload.phase,
		),
	).toEqual(["intent", "failed"]);
});

it.each([
	["with a standard client", { standard: true }],
	["with an empty declaration", { declared: { ...declaredTools, tools: [] } }],
	[
		"with an unknown key",
		{ declared: { ...declaredTools, extra: true } as typeof declaredTools },
	],
] as const)("rejects a dynamic client %s", async (_label, variant) => {
	const env = await setup(true);
	await env.driver.close();
	const dynamicConnectionClient = {
		declared: "declared" in variant ? variant.declared : declaredTools,
		resolveTarget: async () => env.fixture.target,
		resolveInput: async () => env.fixture.input,
	} as CodexDynamicConnectionClientV1;
	const { standardConnectionClient, ...modelOnly } = env.options;
	const open = (client: CodexDynamicConnectionClientV1, standard: boolean) =>
		openCodexRuntimeDriverForTest(
			{
				...modelOnly,
				...(standard ? { standardConnectionClient } : {}),
				dynamicConnectionClient: client,
			},
			async (opened) => {
				const native = new StandardToolNativeFixture();
				native.options = opened;
				return native;
			},
		);
	await expect(
		open(dynamicConnectionClient, "standard" in variant),
	).rejects.toMatchObject({ code: "RUNTIME_CODEX_CONFIGURATION_INVALID" });
	// The same Driver opens with a valid declaration and no standard client.
	const valid = await open(
		{ ...dynamicConnectionClient, declared: declaredTools },
		false,
	);
	closes.push(() => valid.close());
	expect((await valid.getCapabilities()).connection).toBe(true);
});
