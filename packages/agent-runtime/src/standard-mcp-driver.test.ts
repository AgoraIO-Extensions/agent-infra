import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeDriverSubmitTurnCommandV2 } from "@agent-infra/contracts/runtime";
import { afterEach, expect, it } from "vitest";
import {
	CODEX_MODEL_ONLY_CONFIG,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import type {
	CodexRuntimeDriver,
	CodexRuntimeDriverOptions,
} from "./codex-runtime-driver.js";
import { openCodexRuntimeDriverForTest } from "./codex-runtime-driver.test-support.js";
import {
	closeStandardMcpFixtures,
	reference,
	standardMcpFixture,
	token,
} from "./standard-mcp.fixture.js";

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
			for (const key of [
				"model",
				"model_reasoning_effort",
				"features.plugins",
				...Object.keys(CODEX_MODEL_ONLY_CONFIG),
			])
				origins[key] = { name: { type: "sessionFlags" }, version: "1" };
			for (const [key, value] of Object.entries(CODEX_MODEL_ONLY_CONFIG)) {
				if (key.startsWith("features."))
					(config.features as Record<string, unknown>)[key.slice(9)] = value;
				else config[key] = value;
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
			result = { turn: { id: "fixture-turn", status: this.status } };
		} else if (frame.method === "thread/turns/list")
			result = {
				data: [{ id: "fixture-turn", status: this.status, items: [] }],
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
					turn: { id: "fixture-turn", status: "inProgress", items: [] },
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
				turnId: "fixture-turn",
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

async function setup() {
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
		connection: { verification: "unverified", reason: "record_unavailable" },
	});
});

it("unknown WRITE is persisted, closes native and keeps original occupancy across restart", async () => {
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
	const restored = await openCodexRuntimeDriverForTest(
		env.options,
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
	expect(state.sessions[env.ref].activeExecutionId).toBe(reference.executionId);
});

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
