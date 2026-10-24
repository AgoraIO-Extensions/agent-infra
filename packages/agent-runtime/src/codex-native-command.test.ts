import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CODEX_OFFICIAL_LANE_CONFIG,
	type CodexAppServerBridgeOptions,
	type CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import { seedNativeCommandState } from "./codex-native-command.test-support.js";
import {
	type CodexNativeCommandReadContext,
	type CodexNativeStatusSelection,
	CodexRuntimeDriver,
} from "./codex-runtime-driver.js";
import { DurableJsonFile } from "./durable-json.js";

class MetadataTransport {
	readonly requests: CodexAppServerFrame[] = [];
	options?: CodexAppServerBridgeOptions;
	status: unknown = { type: "notLoaded" };
	threadId = "native-thread-private";
	turns: unknown[] = [];
	error = false;
	errorCode = -32600;
	holdReads = false;
	readonly heldReads: CodexAppServerFrame[] = [];
	closeCount = 0;
	openCount = 0;
	openDelay?: Promise<void>;
	successor?: MetadataTransport;
	beforeSend?: (frame: CodexAppServerFrame) => Promise<void>;
	modelPages = ["gpt-5.3-codex"];
	readSendFailure?: () => Promise<void>;
	beforeResponse?: () => void;
	compactItemId = "context-compaction-item-1";
	compactStartedItemId?: string;
	compactCompletedItemId?: string;
	compactTurnId = "context-compaction-turn-1";
	private readonly queue: CodexAppServerFrame[] = [];
	private wake?: () => void;
	private closed = false;

	async send(frame: CodexAppServerFrame) {
		this.requests.push(frame);
		if (this.beforeSend) await this.beforeSend(frame);
		if (frame.method === "initialize") this.respond(frame, {});
		else if (frame.method === "config/read") {
			const config: Record<string, unknown> = {
				model: this.options?.model,
				model_reasoning_effort: "high",
				mcp_servers: {},
				plugins: {},
				marketplaces: {},
				features: { plugins: false },
			};
			const origins: Record<string, unknown> = Object.fromEntries(
				["model", "model_reasoning_effort", "features.plugins"].map((key) => [
					key,
					{ name: { type: "sessionFlags" }, version: "1" },
				]),
			);
			for (const [key, value] of Object.entries(CODEX_OFFICIAL_LANE_CONFIG)) {
				const parts = key.split(".");
				let container = config;
				for (const part of parts.slice(0, -1)) {
					container[part] ??= {};
					container = container[part] as Record<string, unknown>;
				}
				container[parts.at(-1) as string] = structuredClone(value);
				// 固定 Codex 按元素记录数组配置的来源。
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
			origins.model_provider = { name: { type: "sessionFlags" }, version: "1" };
			for (const [key, value] of Object.entries(provider)) {
				if (value !== null && key !== "supports_standalone_web_search")
					origins[`model_providers.agent_infra.${key}`] = {
						name: { type: "sessionFlags" },
						version: "1",
					};
			}
			this.respond(frame, { config, origins });
		} else if (frame.method === "model/list") {
			const params = frame.params as { cursor?: string } | undefined;
			const page = Number(params?.cursor ?? 0);
			this.respond(frame, {
				data: [
					{
						model: this.modelPages[page],
						supportedReasoningEfforts: [{ reasoningEffort: "high" }],
					},
				],
				nextCursor: page + 1 < this.modelPages.length ? String(page + 1) : null,
			});
		} else if (frame.method === "thread/read") {
			if (this.readSendFailure) return this.readSendFailure();
			if (this.holdReads) {
				this.heldReads.push(frame);
				return;
			}
			this.releaseRead(frame);
		} else if (frame.method === "thread/compact/start") {
			this.respond(frame, {});
			this.push({
				method: "turn/started",
				params: {
					threadId: this.threadId,
					turn: { id: this.compactTurnId, status: "inProgress", items: [] },
				},
			});
			this.push({
				method: "item/started",
				params: {
					threadId: this.threadId,
					turnId: this.compactTurnId,
					item: {
						type: "contextCompaction",
						id: this.compactStartedItemId ?? this.compactItemId,
					},
				},
			});
			this.push({
				method: "item/completed",
				params: {
					threadId: this.threadId,
					turnId: this.compactTurnId,
					item: {
						type: "contextCompaction",
						id: this.compactCompletedItemId ?? this.compactItemId,
					},
				},
			});
			this.push({
				method: "turn/completed",
				params: {
					threadId: this.threadId,
					turn: { id: this.compactTurnId, status: "completed", items: [] },
				},
			});
		} else throw new Error(`Unexpected side effect: ${String(frame.method)}`);
	}

	releaseRead(frame = this.heldReads.shift()) {
		if (!frame) throw new Error("Missing held read");
		this.beforeResponse?.();
		if (this.error)
			this.push({
				id: frame.id,
				error: { code: this.errorCode, message: "secret /private/thread/body" },
			});
		else
			this.respond(frame, {
				thread: {
					id: this.threadId,
					status: this.status,
					turns: this.turns,
					preview: "private conversation body",
					path: "/private/native/session",
					cwd: "/private/workspace",
					credential: "private-credential",
				},
			});
	}

	private respond(frame: CodexAppServerFrame, result: unknown) {
		this.push({ id: frame.id, result });
	}
	push(frame: CodexAppServerFrame) {
		this.queue.push(frame);
		this.wake?.();
	}
	async *frames() {
		while (!this.closed) {
			const frame = this.queue.shift();
			if (frame) yield frame;
			else await new Promise<void>((resolve) => (this.wake = resolve));
		}
	}
	async close() {
		this.closeCount++;
		this.closed = true;
		this.wake?.();
	}
}

class MetadataDriver extends CodexRuntimeDriver {
	static openFixture(path: string, transport: MetadataTransport) {
		let opened = false;
		return MetadataDriver.openWithBridge(
			{
				path,
				nativeLane: "official-model-only",
				configVersion: "config-1",
				defaultModelOptionId: "primary",
				defaultReasoningLevel: "high",
				authorizeExternalAction: async () => {
					throw new Error("Unexpected model authorization");
				},
				modelOptions: [
					{
						modelOptionId: "primary",
						model: "gpt-5.3-codex",
						reasoningLevels: ["high"],
						endpoint: "http://127.0.0.1:1/approved/v1",
						credential: "synthetic-model-credential",
					},
				],
			},
			async (options: CodexAppServerBridgeOptions) => {
				const current = opened ? (transport.successor ?? transport) : transport;
				opened = true;
				current.openCount++;
				current.options = options;
				if (current.openDelay) await current.openDelay;
				return current;
			},
		);
	}
}

const fixtures: { directory: string; driver: CodexRuntimeDriver }[] = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const { directory, driver } of fixtures.splice(0)) {
		await driver.close();
		await rm(directory, { recursive: true, force: true });
	}
});

interface MetadataState {
	sessions: Record<
		string,
		{ requiredRuntime?: { lane: string; schemaVersion: number } }
	>;
	operations: Record<
		string,
		{
			configVersion?: string;
			nativeSessionRef: string;
			record?: { nativeSessionRef: string };
		}
	>;
}

async function fixture(stateful = false) {
	const directory = await mkdtemp(join(tmpdir(), "codex-metadata-unit-"));
	const { path, nativeSessionRef, binding } = await seedNativeCommandState(
		directory,
		undefined,
		stateful,
	);
	const transport = new MetadataTransport();
	const driver = await MetadataDriver.openFixture(path, transport);
	fixtures.push({ directory, driver });
	const abort = new AbortController();
	const read: CodexNativeCommandReadContext = {
		nativeSessionRef,
		signal: abort.signal,
		expiresAt: Date.now() + 10_000,
		assertCurrent: () => binding,
		revalidate: async () => binding,
	};
	return { path, driver, transport, binding, read, abort };
}

async function invokeNativeQuery(
	f: Awaited<ReturnType<typeof fixture>>,
	executionId = "native-query-1",
) {
	const directory = await f.driver.discoverNativeCommands(f.read);
	const capability = directory.capabilities[0];
	if (!capability) throw new Error("Missing native command fixture");
	const authority = {
		...f.binding,
		scope: { ...f.binding.scope, executionId },
	};
	const read: CodexNativeCommandReadContext = {
		...f.read,
		allowUnboundExecution: true,
		assertCurrent: () => authority,
		revalidate: async () => authority,
	};
	const command = f.driver.createNativeCommandCommand({
		schemaVersion: 1,
		kind: "native-command",
		operationId: executionId,
		...authority.scope,
		turnId: `turn-${executionId}`,
		nativeSessionRef: f.read.nativeSessionRef,
		capabilityId: capability.id,
		directoryRevision: directory.revision,
		capabilityName: capability.name,
		capabilitySourceVersion: capability.source.version,
		parameters: "",
		parametersDigest: createHash("sha256").update("").digest("hex"),
	});
	const record = await f.driver.execute(command, { nativeCommand: read });
	return { command, read, record };
}

describe("Codex native command result lifecycle", () => {
	it("exposes compact only through the versioned state-changing directory", async () => {
		const f = await fixture();
		const projection = await f.driver.readNativeMetadataV2("commands", f.read);
		expect(projection.capabilities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "compact",
					effect: "state_changing",
					schemaVersion: 2,
				}),
			]),
		);
		expect(projection.capabilities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "查看原生会话状态",
					effect: "read_only",
				}),
			]),
		);
	});

	it("fails closed before RPC when a stateful command lacks a V2 submit binding", async () => {
		const f = await fixture();
		const projection = await f.driver.readNativeMetadataV2("commands", f.read);
		const compact = projection.capabilities.find(
			(entry) => entry.name === "compact",
		);
		if (!compact) throw new Error("Missing compact capability");
		const command = f.driver.createNativeCommandCommandV2({
			schemaVersion: 2,
			kind: "native-command",
			operationId: "compact-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "compact-1",
			turnId: "turn-compact-1",
			sessionGeneration: 1,
			nativeSessionRef: f.read.nativeSessionRef,
			capabilityId: compact.id,
			directoryRevision: projection.revision,
			capabilityName: compact.name,
			capabilitySourceVersion: compact.source.version,
			parameters: "",
			parametersDigest: createHash("sha256").update("").digest("hex"),
			effect: "state_changing",
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
			keyBinding: {
				purpose: "agent-default",
				subjectId: "agent-1",
				ciphertextRef: "relay-key-1",
				version: 1,
			},
			authorizationRecordId: "authorization-1",
		});
		await expect(
			f.driver.execute(command, { nativeCommand: f.read }),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED" });
		expect(
			f.transport.requests.some(
				({ method }) => method === "thread/compact/start",
			),
		).toBe(false);
	});

	it("waits for both contextCompaction and turn completion after the compact ACK", async () => {
		const f = await fixture(true);
		const projection = await f.driver.readNativeMetadataV2("commands", f.read);
		const compact = projection.capabilities.find(
			(entry) => entry.name === "compact",
		);
		if (!compact) throw new Error("Missing compact capability");
		const command = f.driver.createNativeCommandCommandV2({
			schemaVersion: 2,
			kind: "native-command",
			operationId: "compact-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "compact-1",
			turnId: "turn-compact-1",
			sessionGeneration: 1,
			nativeSessionRef: f.read.nativeSessionRef,
			capabilityId: compact.id,
			directoryRevision: projection.revision,
			capabilityName: compact.name,
			capabilitySourceVersion: compact.source.version,
			parameters: "",
			parametersDigest: createHash("sha256").update("").digest("hex"),
			effect: "state_changing",
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
			keyBinding: {
				purpose: "agent-default",
				subjectId: "agent-1",
				ciphertextRef: "relay-key-1",
				version: 1,
			},
			authorizationRecordId: "authorization-1",
		});
		const record = await f.driver.execute(command, { nativeCommand: f.read });
		expect(record.result).toEqual({ outcome: "accepted", status: "completed" });
		expect(
			f.transport.requests.filter(
				(frame) => frame.method === "thread/compact/start",
			),
		).toHaveLength(1);
		const persisted = JSON.parse(await readFile(f.path, "utf8")) as {
			operations: Record<
				string,
				{ nativeTurnId?: string; nativeCompactionItemId?: string }
			>;
		};
		expect(
			persisted.operations[
				JSON.stringify([
					command.agentId,
					command.conversationId,
					command.sessionGeneration,
					command.kind,
					command.operationId,
				])
			],
		).toMatchObject({
			nativeTurnId: f.transport.compactTurnId,
			nativeCompactionItemId: f.transport.compactItemId,
		});
		expect(await f.driver.execute(command, { nativeCommand: f.read })).toEqual(
			record,
		);
	});

	it("keeps the command unknown when a completion never started for this item", async () => {
		const f = await fixture(true);
		f.transport.compactCompletedItemId = "unrelated-compaction-item";
		const projection = await f.driver.readNativeMetadataV2("commands", f.read);
		const compact = projection.capabilities.find(
			(entry) => entry.name === "compact",
		);
		if (!compact) throw new Error("Missing compact capability");
		const command = f.driver.createNativeCommandCommandV2({
			schemaVersion: 2,
			kind: "native-command",
			operationId: "compact-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "compact-1",
			turnId: "turn-compact-1",
			sessionGeneration: 1,
			nativeSessionRef: f.read.nativeSessionRef,
			capabilityId: compact.id,
			directoryRevision: projection.revision,
			capabilityName: compact.name,
			capabilitySourceVersion: compact.source.version,
			parameters: "",
			parametersDigest: createHash("sha256").update("").digest("hex"),
			effect: "state_changing",
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
			keyBinding: {
				purpose: "agent-default",
				subjectId: "agent-1",
				ciphertextRef: "relay-key-1",
				version: 1,
			},
			authorizationRecordId: "authorization-1",
		});
		const record = await f.driver.execute(command, {
			nativeCommand: f.read,
		});
		expect(record.result.outcome).toBe("unknown");
		expect(
			f.transport.requests.filter(
				(frame) => frame.method === "thread/compact/start",
			),
		).toHaveLength(1);
	});

	it.each([
		[{ type: "notLoaded" }, "not_loaded"],
		[{ type: "idle" }, "idle"],
		[{ type: "active", activeFlags: ["waitingOnApproval"] }, "active"],
		[{ type: "systemError" }, "system_error"],
	] as const)(
		"completes the query and replays its %s result",
		async (status, expected) => {
			const f = await fixture();
			f.transport.status = status;
			const { command, record } = await invokeNativeQuery(f);
			expect(record.result).toEqual({
				outcome: "accepted",
				status: "completed",
			});
			expect(
				await f.driver.getStatus(f.read.nativeSessionRef, command.executionId),
			).toBe("completed");
			const events = await f.driver.replayEvents(
				f.read.nativeSessionRef,
				command.executionId,
			);
			expect(events.map((event) => event.type)).toEqual(["text", "completed"]);
			const result = events.find((event) => event.type === "text");
			if (!result) throw new Error("Missing native result event");
			expect(JSON.parse(result.payload.delta)).toEqual({
				status: expected,
				readAt: result.occurredAt,
			});
			expect(events.at(-1)).toMatchObject({
				executionId: command.executionId,
				payload: { status: "completed" },
			});
			expect(JSON.stringify(events)).not.toContain("native-thread-private");
			expect(JSON.stringify(events)).not.toContain(f.read.nativeSessionRef);
			expect(
				f.transport.requests.every(({ method }) =>
					["initialize", "config/read", "thread/read"].includes(
						method as string,
					),
				),
			).toBe(true);
		},
	);

	it("keeps results and cursors stable across replay, ACK, subscription and restart", async () => {
		const f = await fixture();
		const { command, read, record } = await invokeNativeQuery(f);
		const ref = f.read.nativeSessionRef;
		const events = await f.driver.replayEvents(ref, command.executionId);
		const first = events[0];
		const last = events.at(-1);
		if (!first || !last) throw new Error("Missing native command events");
		const before = await readFile(f.path);
		const requestCount = f.transport.requests.length;
		expect(await f.driver.execute(command, { nativeCommand: read })).toEqual(
			record,
		);
		expect(
			await f.driver.replayEvents(ref, command.executionId, first.cursor),
		).toEqual([last]);
		await f.driver.acknowledgeEvents(ref, command.executionId, last.cursor);
		await f.driver.acknowledgeEvents(ref, command.executionId, last.cursor);
		const streamed = [];
		for await (const event of await f.driver.subscribeEvents(
			ref,
			command.executionId,
		))
			streamed.push(event);
		expect(streamed).toEqual(events);
		expect(f.transport.requests).toHaveLength(requestCount);
		expect(await readFile(f.path)).toEqual(before);
		await f.driver.close();
		const transport = new MetadataTransport();
		const reopened = await MetadataDriver.openFixture(f.path, transport);
		try {
			expect(await reopened.getStatus(ref, command.executionId)).toBe(
				"completed",
			);
			expect(await reopened.replayEvents(ref, command.executionId)).toEqual(
				events,
			);
			await reopened.acknowledgeEvents(ref, command.executionId, last.cursor);
			expect(await reopened.lookupOperation(command)).toEqual({
				state: "found",
				record,
			});
			expect(transport.requests).toEqual([]);
			expect(await readFile(f.path)).toEqual(before);
		} finally {
			await reopened.close();
		}
	});

	it("rejects another execution's cursor and unknown execution/session bindings", async () => {
		const f = await fixture();
		const first = await invokeNativeQuery(f);
		const second = await invokeNativeQuery(f, "native-query-2");
		const ref = f.read.nativeSessionRef;
		const events = await f.driver.replayEvents(ref, first.command.executionId);
		const cursor = events.at(-1)?.cursor;
		if (!cursor) throw new Error("Missing native cursor");
		await expect(
			f.driver.replayEvents(ref, second.command.executionId, cursor),
		).rejects.toThrow();
		await expect(
			f.driver.acknowledgeEvents(ref, second.command.executionId, cursor),
		).rejects.toThrow();
		await expect(
			f.driver.getStatus("other-session", first.command.executionId),
		).rejects.toThrow();
		await expect(
			f.driver.replayEvents(ref, "other-execution"),
		).rejects.toThrow();
	});

	it.each([
		"missing",
		"invalid-status",
		"extra-private-field",
		"invalid-time",
	] as const)(
		"does not fabricate or accept a %s persisted result",
		async (failure) => {
			const f = await fixture();
			const { command } = await invokeNativeQuery(f);
			await f.driver.close();
			const state = JSON.parse(await readFile(f.path, "utf8")) as {
				operations: Record<
					string,
					{
						executionId?: string;
						nativeCommandResult?: Record<string, unknown>;
					}
				>;
			};
			const operation = Object.values(state.operations).find(
				(value) => value.executionId === command.executionId,
			);
			if (!operation?.nativeCommandResult)
				throw new Error("Missing persisted native result");
			if (failure === "missing") delete operation.nativeCommandResult;
			else if (failure === "invalid-status")
				operation.nativeCommandResult.status = "invented";
			else if (failure === "extra-private-field")
				operation.nativeCommandResult.threadId = "private-thread";
			else operation.nativeCommandResult.readAt = "not-a-time";
			await writeFile(f.path, `${JSON.stringify(state)}\n`);
			const transport = new MetadataTransport();
			if (failure !== "missing") {
				await expect(
					MetadataDriver.openFixture(f.path, transport),
				).rejects.toThrow();
			} else {
				const reopened = await MetadataDriver.openFixture(f.path, transport);
				try {
					expect(
						await reopened.getStatus(
							f.read.nativeSessionRef,
							command.executionId,
						),
					).toBe("completed");
					await expect(
						reopened.replayEvents(f.read.nativeSessionRef, command.executionId),
					).rejects.toThrow();
				} finally {
					await reopened.close();
				}
			}
			expect(transport.requests).toEqual([]);
		},
	);
});

interface FixtureRpc {
	readonly pending: Map<number, { abandonedRead?: true }>;
	readonly failed: boolean;
	request(
		method: string,
		params: Record<string, unknown>,
		parse: (value: unknown) => unknown,
		nativeSelectionRejection?: boolean,
		allowHistoryMaterializationRetry?: boolean,
		deadlineAt?: number,
		signal?: AbortSignal,
	): Promise<unknown>;
}

// Inspect the existing connection's bounded rows without adding a production test API.
async function fixtureRpc(f: Awaited<ReturnType<typeof fixture>>) {
	return (
		f.driver as unknown as {
			rpc(ref: string): Promise<FixtureRpc>;
		}
	).rpc(f.read.nativeSessionRef);
}

function requestRead(
	rpc: FixtureRpc,
	signal = new AbortController().signal,
	deadline?: number,
) {
	return rpc.request(
		"thread/read",
		{ threadId: "native-thread-private", includeTurns: false },
		(value) => value,
		false,
		false,
		deadline,
		signal,
	);
}

async function flushFrames() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function alterOriginalFacts(change: (state: MetadataState) => void) {
	const originalRead = DurableJsonFile.prototype.read;
	vi.spyOn(DurableJsonFile.prototype, "read").mockImplementation(function (
		this: DurableJsonFile<unknown>,
	) {
		const state = originalRead.call(this) as MetadataState;
		change(state);
		return state;
	});
}

describe("Codex metadata async current confirmation (controlled behavior only)", () => {
	it.each([
		"missing config",
		"wrong config",
		"missing operation",
		"wrong native",
		"missing runtime",
		"wrong runtime",
	])(
		"does not replace original %s with constructor configuration",
		async (kind) => {
			const f = await fixture();
			alterOriginalFacts((state) => {
				const operation = Object.values(state.operations)[0];
				const session = Object.values(state.sessions)[0];
				if (!operation || !session)
					throw new Error("Missing controlled original facts");
				if (kind === "missing config") delete operation.configVersion;
				if (kind === "wrong config") operation.configVersion = "old-config";
				if (kind === "missing operation") state.operations = {};
				if (kind === "wrong native") {
					operation.nativeSessionRef = "other-session";
					if (operation.record)
						operation.record.nativeSessionRef = "other-session";
				}
				if (kind === "missing runtime") delete session.requiredRuntime;
				if (kind === "wrong runtime" && session.requiredRuntime)
					session.requiredRuntime.schemaVersion = 2;
			});
			await expect(
				f.driver.discoverNativeCommands(f.read),
			).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
			expect(f.transport.openCount).toBe(0);
			expect(f.transport.requests).toEqual([]);
		},
	);

	it("carries bounded command parameters through the native thread/read seam", async () => {
		const f = await fixture();
		const directory = await f.driver.discoverNativeCommands(f.read);
		const capability = directory.capabilities[0];
		await f.driver.readNativeStatus(
			{
				capabilityId: capability?.id as string,
				directoryRevision: directory.revision,
				parameters: { includeTurns: false },
			},
			f.read,
		);
		expect(
			f.transport.requests.filter((x) => x.method === "thread/read").at(-1)
				?.params,
		).toEqual({ threadId: "native-thread-private", includeTurns: false });
	});

	it.each(["bridge", "initialize", "config/read", "thread/read", "projection"])(
		"awaits fresh remote authority after %s and prevents the next dependency on denial",
		async (stage) => {
			const f = await fixture();
			let projected = false;
			f.transport.status = {
				get type() {
					projected = true;
					return "idle";
				},
			};
			const held = Promise.withResolvers<typeof f.binding>();
			let reached = false;
			f.read.revalidate = async () => {
				const last = f.transport.requests.at(-1)?.method;
				const at =
					stage === "bridge"
						? f.transport.openCount > 0 && last === undefined
						: stage === "projection"
							? projected
							: last === stage;
				if (at) {
					reached = true;
					return held.promise;
				}
				return f.binding;
			};
			const query = f.driver.discoverNativeCommands(f.read);
			const rejected = expect(query).rejects.toMatchObject({
				code: "RUNTIME_GRANT_INVALID",
			});
			await vi.waitFor(() => expect(reached).toBe(true));
			const requests = [...f.transport.requests];
			await flushFrames();
			expect(f.transport.requests).toEqual(requests);
			// The synchronous local binding is still valid; only current remote authority changed.
			held.resolve({
				...f.binding,
				principal: { kind: "user", id: "remote-other-reader" },
			});
			await rejected;
			expect(f.transport.requests).toEqual(requests);
		},
	);

	it.each(["throw", "scope", "abort", "expiry", "renewal"])(
		"bounds %s while the first current confirmation is pending and cannot revive it",
		async (kind) => {
			const f = await fixture();
			vi.useFakeTimers();
			Object.assign(f.read, { expiresAt: Date.now() + 1000 });
			const held = Promise.withResolvers<typeof f.binding>();
			let reached = false;
			f.read.revalidate = async () => {
				reached = true;
				return held.promise;
			};
			const query = f.driver.discoverNativeCommands(f.read);
			const rejected = expect(query).rejects.toMatchObject({
				code: "RUNTIME_GRANT_INVALID",
				message: expect.not.stringMatching(/private|secret/),
			});
			await vi.waitFor(() => expect(reached).toBe(true));
			if (kind === "abort") f.abort.abort();
			if (kind === "expiry") await vi.advanceTimersByTimeAsync(1000);
			if (kind === "renewal")
				Object.assign(f.read, { expiresAt: Date.now() + 60_000 });
			if (kind === "throw")
				f.read.assertCurrent = () => {
					throw new Error("private secret");
				};
			held.resolve(
				kind === "scope"
					? {
							...f.binding,
							scope: { ...f.binding.scope, executionId: "other-execution" },
						}
					: f.binding,
			);
			await rejected;
			await flushFrames();
			expect(f.transport.openCount).toBe(0);
			expect(f.transport.requests).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("sanitizes a rejected remote confirmation even while the local assertion remains valid", async () => {
		const f = await fixture();
		f.read.revalidate = async () => {
			throw new Error("private credential body");
		};
		await expect(f.driver.discoverNativeCommands(f.read)).rejects.toMatchObject(
			{
				code: "RUNTIME_GRANT_INVALID",
				message: expect.not.stringMatching(/private|credential|body/),
			},
		);
		expect(f.transport.openCount).toBe(0);
	});

	it.each(["config", "runtime"])(
		"rechecks original %s after remote confirmation resolves",
		async (kind) => {
			const f = await fixture();
			const held = Promise.withResolvers<typeof f.binding>();
			let reached = false;
			f.read.revalidate = async () => {
				if (f.transport.requests.at(-1)?.method === "thread/read") {
					reached = true;
					return held.promise;
				}
				return f.binding;
			};
			const query = f.driver.discoverNativeCommands(f.read);
			const rejected = expect(query).rejects.toMatchObject({
				code: "RUNTIME_CODEX_UNAVAILABLE",
			});
			await vi.waitFor(() => expect(reached).toBe(true));
			alterOriginalFacts((state) => {
				const operation = Object.values(state.operations)[0];
				const session = Object.values(state.sessions)[0];
				if (kind === "config" && operation)
					operation.configVersion = "other-config";
				if (kind === "runtime" && session?.requiredRuntime)
					session.requiredRuntime.schemaVersion = 2;
			});
			held.resolve(f.binding);
			await rejected;
		},
	);

	it("cleans a late owned Bridge after a bounded open abort without initializing it", async () => {
		const f = await fixture();
		const opening = Promise.withResolvers<void>();
		f.transport.openDelay = opening.promise;
		const query = f.driver.discoverNativeCommands(f.read);
		const rejected = expect(query).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
		await vi.waitFor(() => expect(f.transport.openCount).toBe(1));
		f.abort.abort();
		await rejected;
		opening.resolve();
		await vi.waitFor(() => expect(f.transport.closeCount).toBe(1));
		expect(f.transport.requests).toEqual([]);
	});

	it("does not revoke a successor ordinary opening credential when its abandoned predecessor Bridge arrives late", async () => {
		const f = await fixture();
		const before = await readFile(f.path, "utf8");
		const predecessorOpen = Promise.withResolvers<void>();
		f.transport.openDelay = predecessorOpen.promise;
		const successor = new MetadataTransport();
		f.transport.successor = successor;
		const successorInitialize = Promise.withResolvers<void>();
		successor.beforeSend = async (frame) => {
			if (frame.method === "initialize") await successorInitialize.promise;
		};
		const query = f.driver.discoverNativeCommands(f.read);
		const rejected = expect(query).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
		await vi.waitFor(() => expect(f.transport.openCount).toBe(1));
		f.abort.abort();
		await rejected;
		const ordinary = fixtureRpc(f);
		await vi.waitFor(() =>
			expect(successor.requests.at(-1)?.method).toBe("initialize"),
		);
		const access = successor.options?.modelAccess;
		if (!access) throw new Error("Missing controlled process access");
		// Unknown GET checks only the existing local credential holder's authentication.
		// It never submits model input, admits a Turn or invokes the provider/authorizer.
		const assertCredentialRetained = async () => {
			const response = await fetch(`${access.endpoint}/metadata-cleanup-test`, {
				headers: { authorization: `Bearer ${access.credential}` },
			});
			expect(response.status).toBe(404);
			await response.text();
		};
		await assertCredentialRetained();
		predecessorOpen.resolve();
		await vi.waitFor(() => expect(f.transport.closeCount).toBe(1));
		await assertCredentialRetained();
		successorInitialize.resolve();
		const rpc = await ordinary;
		await expect(
			rpc.request("model/list", {}, (value) => value),
		).resolves.toBeDefined();
		await assertCredentialRetained();
		expect(successor.closeCount).toBe(0);
		expect(f.transport.requests).toEqual([]);
		expect(await readFile(f.path, "utf8")).toBe(before);
	});

	it.each(["cached", "in flight"])(
		"preserves a shared %s ordinary RPC when metadata confirmation aborts",
		async (kind) => {
			const f = await fixture();
			const initialization = Promise.withResolvers<void>();
			if (kind === "in flight")
				f.transport.beforeSend = async (frame) => {
					if (frame.method === "initialize") await initialization.promise;
				};
			const ordinary = fixtureRpc(f);
			if (kind === "cached") await ordinary;
			else
				await vi.waitFor(() =>
					expect(f.transport.requests.at(-1)?.method).toBe("initialize"),
				);
			const held = Promise.withResolvers<typeof f.binding>();
			let confirmations = 0;
			f.read.revalidate = async () => {
				confirmations++;
				return confirmations === 1 ? f.binding : held.promise;
			};
			const query = f.driver.discoverNativeCommands(f.read);
			const rejected = expect(query).rejects.toMatchObject({
				code: "RUNTIME_GRANT_INVALID",
			});
			if (kind === "in flight") initialization.resolve();
			await vi.waitFor(() => expect(confirmations).toBe(2));
			f.abort.abort();
			await rejected;
			held.resolve(f.binding);
			const rpc = await ordinary;
			await expect(
				rpc.request("model/list", {}, (value) => value),
			).resolves.toBeDefined();
			expect(f.transport.closeCount).toBe(0);
			expect(
				f.transport.requests.some((frame) => frame.method === "thread/read"),
			).toBe(false);
		},
	);
});

describe("Codex metadata RPC local failure boundaries (scripted unit fixture)", () => {
	it("finishes a valid response before the send callback and still fails on its late rejection", async () => {
		const f = await fixture();
		const rpc = await fixtureRpc(f);
		vi.useFakeTimers();
		let rejectSend: (error: Error) => void = () => {};
		f.transport.readSendFailure = () =>
			new Promise<void>((_, reject) => {
				rejectSend = reject;
			});
		const query = requestRead(rpc, undefined, Date.now() + 100);
		f.transport.push({ id: f.transport.requests.at(-1)?.id, result: {} });
		await expect(query).resolves.toEqual({});
		expect(rpc.pending.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		rejectSend(new Error("private late write failure"));
		await flushFrames();
		expect(rpc.failed).toBe(true);
		expect(f.transport.closeCount).toBeGreaterThan(0);
	});
	it.each(["error", "deadline"])(
		"preserves existing ordinary thread/read %s failure semantics",
		async (mode) => {
			const f = await fixture();
			const rpc = await fixtureRpc(f);
			vi.useFakeTimers();
			f.transport.error = mode === "error";
			f.transport.holdReads = mode === "deadline";
			const query = rpc.request(
				"thread/read",
				{ threadId: "native-thread-private" },
				(value) => value,
				false,
				false,
				Date.now() + 100,
			);
			const rejected = expect(query).rejects.toBeInstanceOf(Error);
			if (mode === "deadline") await vi.advanceTimersByTimeAsync(100);
			await rejected;
			expect(rpc.failed).toBe(true);
			expect(rpc.pending.size).toBe(0);
			expect(f.transport.closeCount).toBeGreaterThan(0);
		},
	);
	it.each([-32601, -32600])(
		"keeps the connection usable after legal error %s",
		async (code) => {
			const f = await fixture();
			const rpc = await fixtureRpc(f);
			f.transport.error = true;
			f.transport.errorCode = code;
			await expect(
				f.driver.discoverNativeCommands(f.read),
			).rejects.toMatchObject({
				code:
					code === -32601
						? "RUNTIME_CODEX_COMMAND_UNSUPPORTED"
						: "RUNTIME_CODEX_UNAVAILABLE",
				message: expect.not.stringMatching(/secret|private/),
			});
			f.transport.error = false;
			expect(
				(await f.driver.discoverNativeCommands(f.read)).capabilities,
			).toHaveLength(1);
			await expect(
				rpc.request("model/list", {}, (value) => value),
			).resolves.toBeDefined();
			expect(rpc.pending.size).toBe(0);
			expect(f.transport.closeCount).toBe(0);
		},
	);

	it.each(["abort", "deadline"])(
		"isolates %s and consumes one legal late response",
		async (mode) => {
			const f = await fixture();
			const before = await readFile(f.path, "utf8");
			const rpc = await fixtureRpc(f);
			vi.useFakeTimers();
			f.transport.holdReads = true;
			const controller = new AbortController();
			const remove = vi.spyOn(controller.signal, "removeEventListener");
			const query = requestRead(rpc, controller.signal, Date.now() + 100);
			const rejected = expect(query).rejects.toMatchObject({
				code: "RUNTIME_CODEX_UNAVAILABLE",
			});
			if (mode === "abort") controller.abort();
			else await vi.advanceTimersByTimeAsync(100);
			await rejected;
			expect(rpc.pending.size).toBe(1);
			expect([...rpc.pending.values()][0]?.abandonedRead).toBe(true);
			expect(remove).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
			// A late response body is discarded without metadata parsing.
			f.transport.status = { type: "invalid-late-body" };
			f.transport.releaseRead();
			await flushFrames();
			expect(rpc.pending.size).toBe(0);
			expect(f.transport.closeCount).toBe(0);
			f.transport.holdReads = false;
			f.transport.status = { type: "idle" };
			expect(
				(await f.driver.discoverNativeCommands(f.read)).capabilities,
			).toHaveLength(1);
			expect(await readFile(f.path, "utf8")).toBe(before);
		},
	);

	it.each(["active", "abandoned"])(
		"caps 16 %s read rows while ordinary RPC remains available",
		async (mode) => {
			const f = await fixture();
			const rpc = await fixtureRpc(f);
			f.transport.holdReads = true;
			const controllers: AbortController[] = [];
			const queries: Promise<unknown>[] = [];
			for (let i = 0; i < 16; i++) {
				const controller = new AbortController();
				controllers.push(controller);
				const query = requestRead(rpc, controller.signal);
				queries.push(query.catch((error: unknown) => error));
				if (mode === "abandoned") controller.abort();
			}
			expect(rpc.pending.size).toBe(16);
			const sent = f.transport.requests.length;
			await expect(requestRead(rpc)).rejects.toMatchObject({
				code: "RUNTIME_CODEX_UNAVAILABLE",
			});
			expect(f.transport.requests).toHaveLength(sent);
			await expect(
				rpc.request("model/list", {}, (value) => value),
			).resolves.toBeDefined();
			for (const controller of controllers) controller.abort();
			await Promise.all(queries);
			f.transport.releaseRead();
			await flushFrames();
			expect(rpc.pending.size).toBe(15);
			const controller = new AbortController();
			const query = requestRead(rpc, controller.signal).catch(
				(error: unknown) => error,
			);
			expect(rpc.pending.size).toBe(16);
			controller.abort();
			await query;
			expect(f.transport.closeCount).toBe(0);
			await f.driver.close();
			expect(rpc.pending.size).toBe(0);
		},
	);

	it.each(["abort", "deadline"])(
		"pre-cancelled %s sends nothing and leaves no row",
		async (mode) => {
			const f = await fixture();
			const rpc = await fixtureRpc(f);
			const controller = new AbortController();
			if (mode === "abort") controller.abort();
			const sent = f.transport.requests.length;
			await expect(
				requestRead(
					rpc,
					controller.signal,
					mode === "deadline" ? 0 : undefined,
				),
			).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
			expect(f.transport.requests).toHaveLength(sent);
			expect(rpc.pending.size).toBe(0);
			expect(f.transport.closeCount).toBe(0);
		},
	);

	it.each(["response", "abort", "deadline"])(
		"settles the %s winner without leaking timers or listeners",
		async (winner) => {
			const f = await fixture();
			const rpc = await fixtureRpc(f);
			vi.useFakeTimers();
			f.transport.holdReads = true;
			const controller = new AbortController();
			const remove = vi.spyOn(controller.signal, "removeEventListener");
			const query = requestRead(rpc, controller.signal, Date.now() + 100).then(
				() => "resolved",
				() => "rejected",
			);
			if (winner === "response") {
				f.transport.releaseRead();
				await flushFrames();
				controller.abort();
				await vi.advanceTimersByTimeAsync(100);
			} else {
				if (winner === "abort") controller.abort();
				else await vi.advanceTimersByTimeAsync(100);
				f.transport.releaseRead();
			}
			expect(await query).toBe(winner === "response" ? "resolved" : "rejected");
			await flushFrames();
			expect(rpc.pending.size).toBe(0);
			expect(remove).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
			expect(f.transport.closeCount).toBe(0);
		},
	);

	it.each([
		"unknown",
		"duplicate",
		"bad-error",
		"both",
		"method",
		"version",
		"extra",
		"string-id",
	])("fails the shared connection for %s late envelopes", async (mode) => {
		const f = await fixture();
		const rpc = await fixtureRpc(f);
		f.transport.holdReads = true;
		const controller = new AbortController();
		const query = requestRead(rpc, controller.signal).catch(
			(error: unknown) => error,
		);
		controller.abort();
		await query;
		const id = f.transport.heldReads[0]?.id;
		let frame: CodexAppServerFrame = { id, result: {} };
		if (mode === "unknown") frame = { id: 100_000, result: {} };
		else if (mode === "duplicate") {
			f.transport.releaseRead();
			await flushFrames();
		} else if (mode === "bad-error")
			frame = { id, error: { code: 1.2, message: "private" } };
		else if (mode === "both")
			frame = { id, result: {}, error: { code: -1, message: "private" } };
		else if (mode === "method")
			frame = { id, method: "item/tool/call", result: {} };
		else if (mode === "version") frame = { id, jsonrpc: "1.0", result: {} };
		else if (mode === "extra") frame = { id, result: {}, unexpected: true };
		else if (mode === "string-id") frame = { id: String(id), result: {} };
		f.transport.push(frame);
		await flushFrames();
		expect(rpc.failed).toBe(true);
		expect(rpc.pending.size).toBe(0);
		expect(f.transport.closeCount).toBeGreaterThan(0);
		await expect(
			rpc.request("model/list", {}, (value) => value),
		).rejects.toMatchObject({ code: "RUNTIME_CODEX_UNAVAILABLE" });
	});

	it.each(["immediate", "after-abort", "after-deadline"])(
		"preserves a genuine send failure %s",
		async (mode) => {
			const f = await fixture();
			const rpc = await fixtureRpc(f);
			vi.useFakeTimers();
			let rejectSend: (error: Error) => void = () => {};
			f.transport.readSendFailure = () =>
				new Promise<void>((_, reject) => {
					rejectSend = reject;
				});
			const controller = new AbortController();
			const query = requestRead(rpc, controller.signal, Date.now() + 100).catch(
				(error: unknown) => error,
			);
			if (mode === "after-abort") controller.abort();
			else if (mode === "after-deadline")
				await vi.advanceTimersByTimeAsync(100);
			if (mode !== "immediate") await query;
			rejectSend(new Error("private send failure"));
			await query;
			await flushFrames();
			expect(rpc.failed).toBe(true);
			expect(rpc.pending.size).toBe(0);
			expect(f.transport.closeCount).toBeGreaterThan(0);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("preserves stream-end failure and clears active and abandoned rows", async () => {
		const f = await fixture();
		const rpc = await fixtureRpc(f);
		f.transport.holdReads = true;
		const controller = new AbortController();
		const first = requestRead(rpc, controller.signal).catch(
			(error: unknown) => error,
		);
		controller.abort();
		await first;
		const second = requestRead(rpc);
		const rejected = expect(second).rejects.toMatchObject({
			code: "RUNTIME_CODEX_UNAVAILABLE",
		});
		await f.transport.close();
		await rejected;
		expect(rpc.failed).toBe(true);
		expect(rpc.pending.size).toBe(0);
	});
});

describe("Codex native metadata command (scripted unit fixture)", () => {
	it.each(["commands", "skills"] as const)(
		"projects native metadata selector %s through the existing directory reader",
		async (selector) => {
			const f = await fixture();
			const directory = {
				revision: "a".repeat(64),
				capabilities: [],
			};
			if (selector === "commands")
				vi.spyOn(f.driver, "discoverNativeCommands").mockResolvedValue(
					directory,
				);
			else
				vi.spyOn(f.driver, "discoverNativeSkills").mockResolvedValue(directory);
			await expect(
				f.driver.readNativeMetadataV1(selector, f.read),
			).resolves.toEqual({ selector, ...directory });
		},
	);

	it("projects status through the V1 metadata reader without exposing native refs", async () => {
		const f = await fixture();
		f.transport.status = { type: "idle" };
		const result = await f.driver.readNativeMetadataV1("status", f.read);
		expect(result).toEqual({
			selector: "status",
			status: "idle",
			readAt: expect.any(String),
		});
		expect(
			f.transport.requests.filter((x) => x.method === "thread/read"),
		).toHaveLength(1);
		for (const request of f.transport.requests.filter(
			(x) => x.method === "thread/read",
		))
			expect(request.params).toEqual({
				threadId: "native-thread-private",
				includeTurns: false,
			});
		expect(JSON.stringify(result)).not.toMatch(/private|threadId|credential/);
	});

	it.each([
		[{ type: "notLoaded" }, "not_loaded"],
		[{ type: "idle" }, "idle"],
		[{ type: "active", activeFlags: ["waitingOnApproval"] }, "active"],
		[{ type: "systemError" }, "system_error"],
	] as const)(
		"projects %j without business activity",
		async (status, projected) => {
			const f = await fixture();
			f.transport.status = status;
			const before = await readFile(f.path, "utf8");
			const directory = await f.driver.discoverNativeCommands(f.read);
			expect(directory.capabilities).toHaveLength(1);
			const capability = directory.capabilities[0];
			const result = await f.driver.readNativeStatus(
				{
					capabilityId: capability?.id as string,
					directoryRevision: directory.revision,
					parameters: {},
				},
				f.read,
			);
			expect(result).toEqual({ status: projected, readAt: expect.any(String) });
			expect(Number.isFinite(Date.parse(result.readAt))).toBe(true);
			expect(
				f.transport.requests.filter((x) => x.method === "thread/read"),
			).toHaveLength(2);
			for (const request of f.transport.requests.filter(
				(x) => x.method === "thread/read",
			))
				expect(request.params).toEqual({
					threadId: "native-thread-private",
					includeTurns: false,
				});
			expect(await readFile(f.path, "utf8")).toBe(before);
			expect(JSON.stringify([directory, result])).not.toMatch(
				/private|credential|threadId|preview|cwd/,
			);
		},
	);

	it("does not alias directory selections across readers or configuration", async () => {
		const f = await fixture();
		const first = await f.driver.discoverNativeCommands(f.read);
		f.binding.principal.id = "reader-2";
		const second = await f.driver.discoverNativeCommands(f.read);
		expect(second.revision).not.toBe(first.revision);
		expect(second.capabilities[0]?.id).not.toBe(first.capabilities[0]?.id);
		await expect(
			f.driver.readNativeStatus(
				{
					capabilityId: first.capabilities[0]?.id as string,
					directoryRevision: first.revision,
					parameters: {},
				},
				f.read,
			),
		).rejects.toBeInstanceOf(Error);
		Object.assign(f.driver, { configVersion: "config-2" });
		await expect(
			f.driver.readNativeStatus(
				{
					capabilityId: second.capabilities[0]?.id as string,
					directoryRevision: second.revision,
					parameters: {},
				},
				f.read,
			),
		).rejects.toBeInstanceOf(Error);
	});

	it.each([
		"agentId",
		"conversationId",
		"executionId",
		"sessionGeneration",
	] as const)(
		"rejects a replaced %s before contacting native",
		async (field) => {
			const f = await fixture();
			if (field === "sessionGeneration") f.binding.scope[field] = 2;
			else f.binding.scope[field] = "another-resource";
			await expect(
				f.driver.discoverNativeCommands(f.read),
			).rejects.toBeInstanceOf(Error);
			expect(f.transport.requests).toEqual([]);
		},
	);

	it.each(["revoked", "aborted", "expired"])(
		"rechecks %s before returning",
		async (failure) => {
			const f = await fixture();
			f.transport.beforeResponse = () => {
				if (failure === "aborted") f.abort.abort();
				else if (failure === "expired") Object.assign(f.read, { expiresAt: 0 });
				else
					Object.assign(f.read, {
						assertCurrent: () => {
							throw new Error("private revoked credential");
						},
					});
			};
			await expect(
				f.driver.discoverNativeCommands(f.read),
			).rejects.toMatchObject({
				message: expect.not.stringMatching(/private|credential/),
			});
		},
	);

	it.each([
		{ type: "invented" },
		{ type: "active" },
		{ type: "active", activeFlags: ["invented"] },
		null,
	])("rejects invalid native status %j", async (status) => {
		const f = await fixture();
		f.transport.status = status;
		await expect(f.driver.discoverNativeCommands(f.read)).rejects.toMatchObject(
			{ code: "RUNTIME_CODEX_PROTOCOL_INVALID" },
		);
	});

	it.each(["error", "history", "thread"])(
		"fails closed on native %s",
		async (mode) => {
			const f = await fixture();
			if (mode === "error") f.transport.error = true;
			else if (mode === "history")
				f.transport.turns = [{ body: "private-body" }];
			else f.transport.threadId = "other-native-thread";
			await expect(
				f.driver.discoverNativeCommands(f.read),
			).rejects.toMatchObject({
				message: expect.not.stringMatching(/private|body|credential/),
			});
		},
	);

	it("rejects unknown selection and arbitrary native parameters without new RPC", async () => {
		const f = await fixture();
		const directory = await f.driver.discoverNativeCommands(f.read);
		const count = f.transport.requests.length;
		const selection = {
			capabilityId: directory.capabilities[0]?.id as string,
			directoryRevision: directory.revision,
			parameters: {},
		};
		for (const input of [
			{ ...selection, capabilityId: "unknown" },
			{ ...selection, directoryRevision: "stale" },
			{ ...selection, parameters: { threadId: "other" } },
			{ ...selection, method: "thread/resume" },
		])
			await expect(
				f.driver.readNativeStatus(
					input as unknown as CodexNativeStatusSelection,
					f.read,
				),
			).rejects.toBeInstanceOf(Error);
		expect(f.transport.requests).toHaveLength(count);
	});

	it("returns a stable directory revision for unchanged current authority", async () => {
		const f = await fixture();
		expect(await f.driver.discoverNativeCommands(f.read)).toEqual(
			await f.driver.discoverNativeCommands(f.read),
		);
	});

	it.each(["principal", "scope", "nativeSessionRef"])(
		"rejects an asynchronous %s change without returning metadata",
		async (change) => {
			const f = await fixture();
			f.transport.beforeResponse = () => {
				if (change === "principal") f.binding.principal.id = "reader-2";
				else if (change === "scope") f.binding.scope.executionId = "other";
				else Object.assign(f.read, { nativeSessionRef: "other" });
			};
			await expect(
				f.driver.discoverNativeCommands(f.read),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		},
	);

	it.each(["expired", "aborted", "missing-session"])(
		"rejects %s before contacting native",
		async (mode) => {
			const f = await fixture();
			if (mode === "expired") Object.assign(f.read, { expiresAt: 0 });
			else if (mode === "aborted") f.abort.abort();
			else Object.assign(f.read, { nativeSessionRef: "absent" });
			await expect(
				f.driver.discoverNativeCommands(f.read),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
			expect(f.transport.requests).toEqual([]);
		},
	);

	it("keeps valid metadata queries usable after an invalid content response", async () => {
		const f = await fixture();
		f.transport.status = { type: "invented" };
		await expect(f.driver.discoverNativeCommands(f.read)).rejects.toMatchObject(
			{ code: "RUNTIME_CODEX_PROTOCOL_INVALID" },
		);
		f.transport.status = { type: "idle" };
		expect(
			(await f.driver.discoverNativeCommands(f.read)).capabilities,
		).toHaveLength(1);
	});
});
