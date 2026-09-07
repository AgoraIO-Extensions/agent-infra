import { execFileSync } from "node:child_process";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeSubmitTurnRequestV1 } from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CODEX_APP_SERVER_V2_PROVENANCE,
	CodexAppServerBridge,
} from "./codex-app-server-bridge.js";
import { CodexRuntimeDriver } from "./codex-runtime-driver.js";
import type { RuntimeDriverCommand } from "./driver.js";
import { FileRuntimeStore } from "./file-runtime-store.js";
import {
	ingressVerifiedRuntimeHost,
	runtimeGrantFixture,
} from "./grant-fixture.test-support.js";
import { RuntimeHost } from "./runtime-host.js";

const directories: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
const enabled = process.env.AGENT_INFRA_CODEX_NATIVE_TEST === "1";

interface NativeResponses {
	initialize: unknown;
	"config/read": unknown;
	"thread/start": { thread: { id: string } };
	"thread/resume": { thread: { id: string } };
	"thread/turns/list": { data: { id: string; status: string }[] };
	"thread/read": { thread: { id: string; turns: unknown[] } };
	"thread/items/list": unknown;
	"turn/start": { turn: { id: string; status: string } };
	"turn/interrupt": unknown;
}

// Only real Bridge frames enter this client. Assertions compare IDs as booleans
// so failures never print native IDs, protocol frames, or deployment paths.
class NativeClient {
	private sequence = 0;
	private readonly startedTurns = new Set<string>();
	private readonly turnStartedWaiters = new Map<string, Set<() => void>>();
	private readonly responses = new Map<
		number,
		{
			method: string;
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	constructor(readonly bridge: CodexAppServerBridge) {
		void (async () => {
			try {
				for await (const frame of bridge.frames()) {
					this.recordTurnStarted(frame);
					const pending =
						typeof frame.id === "number"
							? this.responses.get(frame.id)
							: undefined;
					if (pending && typeof frame.id === "number") {
						this.responses.delete(frame.id);
						if (frame.error)
							pending.reject(
								new Error(`Native ${pending.method} request unavailable`),
							);
						else pending.resolve(frame.result);
					}
				}
			} catch {
				/* Expected after an injected native crash. */
			}
			for (const pending of this.responses.values())
				pending.reject(new Error("Native process unavailable"));
		})();
	}
	async request<M extends keyof NativeResponses>(
		method: M,
		params: Record<string, unknown> = {},
	): Promise<NativeResponses[M]> {
		const id = ++this.sequence;
		const result = new Promise<unknown>((resolve, reject) =>
			this.responses.set(id, { method, resolve, reject }),
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await this.bridge.send({ id, method, params });
			return (await Promise.race([
				result,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Native request timed out")),
						10_000,
					);
				}),
			])) as NativeResponses[M];
		} finally {
			clearTimeout(timer);
		}
	}
	async waitForTurnStarted(threadId: string, turnId: string) {
		const key = JSON.stringify([threadId, turnId]);
		if (this.startedTurns.has(key)) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				const waiters = this.turnStartedWaiters.get(key) ?? new Set();
				this.turnStartedWaiters.set(key, waiters);
				waiters.add(resolve);
				timer = setTimeout(() => {
					waiters.delete(resolve);
					if (waiters.size === 0) this.turnStartedWaiters.delete(key);
					reject(new Error("Native Turn did not start"));
				}, 10_000);
			});
		} finally {
			clearTimeout(timer);
		}
	}
	private recordTurnStarted(frame: unknown) {
		if (
			typeof frame !== "object" ||
			frame === null ||
			(frame as { method?: unknown }).method !== "turn/started"
		)
			return;
		const params = (frame as { params?: unknown }).params;
		if (
			typeof params !== "object" ||
			params === null ||
			typeof (params as { threadId?: unknown }).threadId !== "string" ||
			typeof (params as { turn?: { id?: unknown } }).turn?.id !== "string"
		)
			return;
		const key = JSON.stringify([
			(params as { threadId: string }).threadId,
			(params as { turn: { id: string } }).turn.id,
		]);
		this.startedTurns.add(key);
		for (const wake of this.turnStartedWaiters.get(key) ?? []) wake();
		this.turnStartedWaiters.delete(key);
	}
}

async function directory() {
	const path = await mkdtemp(join(tmpdir(), "agent-runtime-native-recovery-"));
	directories.push(path);
	return path;
}

async function nativeClient(path: string, experimentalApi = false) {
	const bridge = await CodexAppServerBridge.open({
		dataDirectory: path,
		model: "gpt-5.3-codex",
		reasoningEffort: "low",
		provenance: CODEX_APP_SERVER_V2_PROVENANCE,
	});
	closers.push(() => bridge.close());
	const client = new NativeClient(bridge);
	await client.request("initialize", {
		clientInfo: { name: "agent-infra-runtime", version: "1" },
		...(experimentalApi ? { capabilities: { experimentalApi: true } } : {}),
	});
	await client.request("config/read", { includeLayers: false });
	return client;
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

type LoopbackResponseMode = "active";

async function loopbackResponsesProvider(
	root: string,
	responseMode?: LoopbackResponseMode,
) {
	let requested = false;
	const responses = new Set<ServerResponse>();
	const server = createServer((request, response) => {
		if (
			request.method === "POST" &&
			(request.url === "/v1/responses" || request.url === "/responses")
		) {
			requested = true;
			request.resume();
			if (responseMode) {
				response.writeHead(200, {
					"cache-control": "no-cache",
					"content-type": "text/event-stream",
					connection: "keep-alive",
				});
				response.flushHeaders();
				response.write(
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_agent_infra_native"}}\n\n',
				);
			}
			responses.add(response);
			response.once("close", () => responses.delete(response));
			return;
		}
		response.statusCode = 404;
		response.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	closers.push(async () => {
		for (const response of responses) response.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected loopback provider port");
	}
	const nativeExecutable = execFileSync("which", ["codex"], {
		encoding: "utf8",
	}).trim();
	if (nativeExecutable.length === 0)
		throw new Error("Expected pinned Codex binary");
	const bin = join(root, "loopback-bin");
	await mkdir(bin);
	const provider = "agent_infra_native_fixture";
	const providerConfigs = [
		`model_provider=${JSON.stringify(provider)}`,
		`model_providers.${provider}.name=${JSON.stringify("Agent Infra native fixture")}`,
		`model_providers.${provider}.base_url=${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)}`,
		`model_providers.${provider}.wire_api="responses"`,
		`model_providers.${provider}.requires_openai_auth=false`,
		`model_providers.${provider}.request_max_retries=0`,
		`model_providers.${provider}.stream_max_retries=0`,
	];
	await writeFile(
		join(bin, "codex"),
		`#!/bin/sh\nexec ${shellQuote(nativeExecutable)} "$@" ${providerConfigs.map((value) => `--config ${shellQuote(value)}`).join(" ")}\n`,
	);
	await chmod(join(bin, "codex"), 0o700);
	vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
	return { wasRequested: () => requested };
}

function nativePid() {
	const rows = execFileSync(
		"ps",
		["-A", "-o", "pid=", "-o", "ppid=", "-o", "comm="],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n");
	const owned = rows
		.map((row) => row.trim().split(/\s+/))
		.filter(
			(row) =>
				Number(row[1]) === process.pid &&
				row.slice(2).join(" ").includes("codex"),
		);
	if (owned.length !== 1) throw new Error("Expected one owned native process");
	return Number(owned[0]?.[0]);
}

async function crash() {
	const pid = nativePid();
	process.kill(pid, "SIGKILL");
	await expect
		.poll(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		})
		.toBe(true);
}

function driverOptions(path: string) {
	return {
		path,
		model: "gpt-5.3-codex",
		reasoningEffort: "low",
		modelOptions: [
			{
				modelOptionId: "synthetic",
				model: "gpt-5.3-codex",
				reasoningLevels: ["low"],
			},
		],
	};
}

async function nativeDriver(path: string) {
	const driver = await CodexRuntimeDriver.open(driverOptions(path));
	closers.push(() => driver.close());
	return driver;
}

function submit(
	executionId = "synthetic-execution",
	nativeSessionRef?: string,
	text = "synthetic recovery input",
): RuntimeDriverCommand {
	return {
		schemaVersion: 1,
		kind: "submit-turn",
		operationId: executionId,
		agentId: "synthetic-agent",
		conversationId: "synthetic-conversation",
		executionId,
		turnId: `${executionId}-turn`,
		sessionGeneration: 1,
		input: { text, attachments: [] },
		...(nativeSessionRef ? { nativeSessionRef } : {}),
	};
}

function stop(
	executionId: string,
	turnId: string,
	nativeSessionRef: string,
): Extract<RuntimeDriverCommand, { kind: "stop" }> {
	return {
		schemaVersion: 1,
		kind: "stop",
		operationId: `${executionId}-stop`,
		agentId: "synthetic-agent",
		conversationId: "synthetic-conversation",
		executionId,
		turnId,
		sessionGeneration: 1,
		nativeSessionRef,
	};
}

function submitRequest(): RuntimeSubmitTurnRequestV1 {
	const binding = {
		agentId: "synthetic-agent",
		actorId: "synthetic-actor",
		channelId: "synthetic-channel",
		conversationId: "synthetic-conversation",
		executionId: "synthetic-execution",
		turnId: "synthetic-execution-turn",
		sessionGeneration: 1,
		traceId: "synthetic-trace",
	};
	return {
		schemaVersion: 1,
		requestId: "synthetic-request",
		...binding,
		deliveryFence: 1,
		grant: runtimeGrantFixture(binding, ["turn.submit"]),
		input: { text: "synthetic recovery input", attachments: [] },
	};
}

async function mapping(path: string) {
	const state = JSON.parse(await readFile(path, "utf8")) as {
		sessions: Record<
			string,
			{ threadId: string; executions: Record<string, { nativeTurnId: string }> }
		>;
	};
	const sessions = Object.entries(state.sessions);
	if (sessions.length !== 1 || !sessions[0])
		throw new Error("Expected one native session mapping");
	const [nativeSessionRef, session] = sessions[0];
	if (!nativeSessionRef || !session)
		throw new Error("Expected one native session mapping");
	return { nativeSessionRef, ...session };
}

type NativeHistory = { contents: string; size: number };

async function nativeHistory(home: string): Promise<NativeHistory[]> {
	try {
		const historyFiles = (await readdir(home, { recursive: true })).filter(
			(entry) => entry.endsWith(".jsonl"),
		);
		return await Promise.all(
			historyFiles.map(async (entry) => {
				const path = join(home, entry);
				return {
					contents: await readFile(path, "utf8"),
					size: (await stat(path)).size,
				};
			}),
		);
	} catch {
		return [];
	}
}

async function waitForNativeHistorySeed(
	home: string,
	threadId: string,
	seed: string,
	ordinal: number,
) {
	const persisted = await expect
		.poll(
			async () =>
				(await nativeHistory(home)).some(
					({ contents }) =>
						contents.includes(threadId) && contents.includes(seed),
				),
			{ timeout: 60_000 },
		)
		.toBe(true)
		.then(
			() => true,
			() => false,
		);
	if (!persisted)
		throw new Error(
			`Native history seed materialization timed out (seed ${ordinal})`,
		);
}

async function seedDriver(path: string) {
	await loopbackResponsesProvider(dirname(path));
	const driver = await nativeDriver(path);
	const accepted = await driver.execute(submit());
	expect(accepted.result.outcome).toBe("accepted");
	// The native acceptance response precedes recording the user input. Wait for
	// native metadata before closing, without fabricating native IDs or history.
	await expect
		.poll(
			() => {
				let database: DatabaseSync | undefined;
				try {
					database = new DatabaseSync(`${path}.native/home/state_5.sqlite`, {
						readOnly: true,
					});
					return database
						.prepare("SELECT first_user_message FROM threads")
						.all()
						.some(
							(row) => row.first_user_message === "synthetic recovery input",
						);
				} catch {
					return false;
				} finally {
					database?.close();
				}
			},
			{ timeout: 60_000 },
		)
		.toBe(true);
	// Closing the real native process cancels its Turn and flushes native history.
	await driver.close();
	return accepted;
}

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const close of closers.splice(0).reverse())
		await close().catch(() => {});
	for (const path of directories.splice(0))
		await rm(path, { recursive: true, force: true });
});

describe
	.skipIf(!enabled)
	.sequential("pinned Codex native process recovery", () => {
		it("shows that the legacy turns-list read cannot observe a new active Turn", async () => {
			const root = await directory();
			const path = join(root, "driver.json");
			await loopbackResponsesProvider(root);
			const driver = await nativeDriver(path);
			await driver.close();
			const client = await nativeClient(`${path}.native`);
			const started = await client.request("thread/start");
			const turn = await client.request("turn/start", {
				threadId: started.thread.id,
				clientUserMessageId: "synthetic-operation",
				input: [{ type: "text", text: "synthetic recovery input" }],
				model: "gpt-5.3-codex",
				effort: "low",
			});
			const legacy = await client
				.request("thread/turns/list", {
					threadId: started.thread.id,
					itemsView: "notLoaded",
					limit: 100,
				})
				.catch(() => undefined);
			expect(
				legacy?.data.find(({ id }) => id === turn.turn.id)?.status,
			).not.toBe("inProgress");
		}, 90_000);

		it("reads a subsequent active Turn from materialized legacy history", async () => {
			const root = await directory();
			const path = join(root, "driver.json");
			await loopbackResponsesProvider(root, "active");
			const driver = await nativeDriver(path);
			await driver.close();
			const client = await nativeClient(`${path}.native`);
			const started = await client.request("thread/start");
			const first = await client.request("turn/start", {
				threadId: started.thread.id,
				clientUserMessageId: "synthetic-legacy-first-operation",
				input: [{ type: "text", text: "synthetic recovery input" }],
				model: "gpt-5.3-codex",
				effort: "low",
			});
			await client.waitForTurnStarted(started.thread.id, first.turn.id);
			await client.request("turn/interrupt", {
				threadId: started.thread.id,
				turnId: first.turn.id,
			});
			await expect
				.poll(
					async () => {
						const turns = await client.request("thread/turns/list", {
							threadId: started.thread.id,
							itemsView: "notLoaded",
							limit: 100,
						});
						return turns.data.find(({ id }) => id === first.turn.id)?.status;
					},
					{ timeout: 10_000 },
				)
				.toMatch(/^(completed|failed|interrupted)$/);
			const next = await client.request("turn/start", {
				threadId: started.thread.id,
				clientUserMessageId: "synthetic-legacy-next-operation",
				input: [{ type: "text", text: "synthetic recovery input" }],
				model: "gpt-5.3-codex",
				effort: "low",
			});
			await client.waitForTurnStarted(started.thread.id, next.turn.id);
			const turns = await client.request("thread/turns/list", {
				threadId: started.thread.id,
				itemsView: "notLoaded",
				limit: 100,
			});
			expect(turns.data.find(({ id }) => id === next.turn.id)?.status).toBe(
				"inProgress",
			);
		}, 90_000);

		it("reads an active Turn through native thread/read after experimental API negotiation", async () => {
			const root = await directory();
			const path = join(root, "driver.json");
			await loopbackResponsesProvider(root, "active");
			const driver = await nativeDriver(path);
			await driver.close();
			const client = await nativeClient(`${path}.native`, true);
			const started = await client.request("thread/start");
			const turn = await client.request("turn/start", {
				threadId: started.thread.id,
				clientUserMessageId: "synthetic-operation",
				input: [{ type: "text", text: "synthetic recovery input" }],
				model: "gpt-5.3-codex",
				effort: "low",
			});
			await client.waitForTurnStarted(started.thread.id, turn.turn.id);
			const read = await client.request("thread/read", {
				threadId: started.thread.id,
				includeTurns: true,
			});
			expect(read.thread.id === started.thread.id).toBe(true);
			const matches = read.thread.turns.filter(
				(value): value is { id: string; status: string; items: unknown[] } =>
					typeof value === "object" &&
					value !== null &&
					!Array.isArray(value) &&
					(value as { id?: unknown }).id === turn.turn.id &&
					typeof (value as { status?: unknown }).status === "string" &&
					Array.isArray((value as { items?: unknown }).items),
			);
			expect(matches).toHaveLength(1);
			expect(matches[0]?.status).toBe("inProgress");
		}, 90_000);

		it("reads an active Turn through paginated native turn history", async () => {
			const root = await directory();
			const path = join(root, "driver.json");
			await loopbackResponsesProvider(root, "active");
			const driver = await nativeDriver(path);
			await driver.close();
			const client = await nativeClient(`${path}.native`, true);
			const started = await client.request("thread/start", {
				historyMode: "paginated",
			});
			const turn = await client.request("turn/start", {
				threadId: started.thread.id,
				clientUserMessageId: "synthetic-operation",
				input: [{ type: "text", text: "synthetic recovery input" }],
				model: "gpt-5.3-codex",
				effort: "low",
			});
			await client.waitForTurnStarted(started.thread.id, turn.turn.id);
			const turns = await client.request("thread/turns/list", {
				threadId: started.thread.id,
				itemsView: "notLoaded",
				limit: 1,
			});
			const matches = turns.data.filter(
				(value): value is { id: string; status: string; items: unknown[] } =>
					typeof value === "object" &&
					value !== null &&
					!Array.isArray(value) &&
					(value as { id?: unknown }).id === turn.turn.id &&
					typeof (value as { status?: unknown }).status === "string" &&
					Array.isArray((value as { items?: unknown }).items),
			);
			expect(matches).toHaveLength(1);
			expect(matches[0]?.status).toBe("inProgress");
		}, 90_000);

		it("observes a newly accepted Turn through the Driver during initial native history availability", async () => {
			const root = await directory();
			const path = join(root, "driver.json");
			await loopbackResponsesProvider(root, "active");
			const driver = await nativeDriver(path);
			const accepted = await driver.execute(submit());
			expect(accepted.result).toEqual({
				outcome: "accepted",
				status: "running",
			});
			expect(
				await driver.getStatus(
					accepted.nativeSessionRef,
					"synthetic-execution",
				),
			).toBe("running");
			await driver.close();
		}, 90_000);

		it("observes a newly accepted Turn through the Host during initial native history availability", async () => {
			const root = await directory();
			const path = join(root, "driver.json");
			await loopbackResponsesProvider(root, "active");
			const driver = await nativeDriver(path);
			const runtimeHost = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					store: await FileRuntimeStore.open(join(root, "host.json")),
					driver,
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
				}),
			);

			const request = submitRequest();
			const response = await runtimeHost.submitTurn(request);
			expect(response.result).toEqual({
				outcome: "accepted",
				status: "running",
			});
			const { input: _input, ...statusContext } = request;
			expect(
				await runtimeHost.status({
					...statusContext,
					requestId: "synthetic-status",
					hostSessionRef: response.hostSessionRef,
					grant: runtimeGrantFixture(statusContext, ["session.status"]),
				}),
			).toMatchObject({ status: "running" });
			expect(JSON.stringify(response)).not.toContain(
				"synthetic recovery input",
			);
		}, 90_000);

		it("reads an active Turn from paginated history larger than one Bridge frame", async () => {
			const root = await directory();
			const path = join(root, "driver.json");
			await loopbackResponsesProvider(root, "active");
			const driver = await nativeDriver(path);
			const syntheticHistoryInputs = Array.from(
				{ length: 8 },
				(_, index) => `synthetic-long-history-${index}-${"x".repeat(9_000)}`,
			);
			let nativeSessionRef: string | undefined;
			let threadId: string | undefined;
			const home = `${path}.native/home`;

			for (let index = 0; index < 8; index += 1) {
				const seed = syntheticHistoryInputs[index];
				if (!seed) throw new Error("Expected synthetic history seed");
				const command = submit(
					`synthetic-history-${index}`,
					nativeSessionRef,
					seed,
				);
				const accepted = await driver.execute(command);
				nativeSessionRef ??= accepted.nativeSessionRef;
				expect(accepted.nativeSessionRef).toBe(nativeSessionRef);
				const session = await mapping(path);
				expect(session.nativeSessionRef).toBe(accepted.nativeSessionRef);
				const mappedThreadId = threadId ?? session.threadId;
				threadId = mappedThreadId;
				expect(session.threadId).toBe(mappedThreadId);
				await waitForNativeHistorySeed(home, mappedThreadId, seed, index);
				expect(
					(
						await driver.execute(
							stop(
								command.executionId,
								command.turnId,
								accepted.nativeSessionRef,
							),
						)
					).result,
				).toEqual({ outcome: "accepted", status: "cancelled" });
			}
			if (!nativeSessionRef || !threadId)
				throw new Error("Expected a native Session mapping");
			const session = await mapping(path);
			expect(session.nativeSessionRef).toBe(nativeSessionRef);
			expect(session.threadId).toBe(threadId);
			expect(Object.keys(session.executions)).toHaveLength(8);

			const history = await nativeHistory(home);
			const relevantHistory = history.filter(({ contents }) =>
				syntheticHistoryInputs.some((input) => contents.includes(input)),
			);
			for (const input of syntheticHistoryInputs) {
				expect(
					relevantHistory.some(({ contents }) => contents.includes(input)),
				).toBe(true);
			}
			expect(
				relevantHistory.every(({ contents }) =>
					contents.includes(session.threadId),
				),
			).toBe(true);
			const historyBytes = relevantHistory.reduce(
				(total, entry) => total + entry.size,
				0,
			);
			expect(historyBytes).toBeGreaterThan(65_536);

			const command = submit(
				"synthetic-active-after-long-history",
				nativeSessionRef,
			);
			const active = await driver.execute(command);
			expect(active.nativeSessionRef).toBe(nativeSessionRef);
			expect(
				await driver.getStatus(active.nativeSessionRef, command.executionId),
			).toBe("running");
		}, 90_000);

		it.each(["close", "crash"])(
			"restores durable native Session, Turn, history and workspace after %s",
			async (exit) => {
				const root = await directory();
				const path = join(root, "driver.json");
				const scratch = join(root, "scratch");
				const personal = join(root, "synthetic-parent-home");
				await mkdir(scratch);
				await mkdir(personal);
				const parentConfig =
					'model = "synthetic-parent-model"\n[mcp_servers.synthetic_parent]\ncommand = "false"\n';
				await writeFile(join(personal, "config.toml"), parentConfig);
				await writeFile(
					join(personal, "auth.json"),
					'{"OPENAI_API_KEY":"synthetic-parent-credential"}',
				);
				vi.stubEnv("HOME", personal);
				vi.stubEnv("CODEX_HOME", personal);
				vi.stubEnv("OPENAI_API_KEY", "synthetic-parent-credential");
				vi.stubEnv("TMPDIR", scratch);
				const accepted = await seedDriver(path);
				expect(await readdir(scratch)).toEqual([]);
				if (!accepted.nativeSessionRef)
					throw new Error("Expected session reference");
				const original = await mapping(path);
				const workspace = join(`${path}.native`, "workspace", "synthetic.txt");
				await writeFile(workspace, "synthetic workspace");
				const first = await nativeDriver(path);
				const pid = nativePid();
				expect(
					await first.getStatus(
						accepted.nativeSessionRef,
						"synthetic-execution",
					),
				).toBe("cancelled");
				if (exit === "close") await first.close();
				else await crash();
				await expect.poll(() => readdir(scratch)).toEqual([]);
				const second = await nativeDriver(path);
				expect(nativePid() !== pid).toBe(true);
				const replay = await second.execute(submit());
				expect(replay.nativeSessionRef === accepted.nativeSessionRef).toBe(
					true,
				);
				expect(replay.result).toEqual({
					outcome: "accepted",
					status: "cancelled",
				});
				expect(
					await second.getStatus(
						accepted.nativeSessionRef,
						"synthetic-execution",
					),
				).toBe("cancelled");
				await second.close();
				expect((await mapping(path)).threadId === original.threadId).toBe(true);
				expect(await readFile(workspace, "utf8")).toBe("synthetic workspace");
				const inspect = await nativeClient(`${path}.native`);
				const resumed = await inspect.request("thread/resume", {
					threadId: original.threadId,
					excludeTurns: true,
				});
				expect(resumed.thread.id === original.threadId).toBe(true);
				const turns = await inspect.request("thread/turns/list", {
					threadId: original.threadId,
					itemsView: "notLoaded",
				});
				expect(turns.data.length).toBe(1);
				const turn = turns.data[0];
				if (!turn) throw new Error("Expected original native Turn");
				expect(
					turn.id === original.executions["synthetic-execution"]?.nativeTurnId,
				).toBe(true);
				const items = await inspect.request("thread/items/list", {
					threadId: original.threadId,
					turnId: turn.id,
				});
				expect(JSON.stringify(items).includes("synthetic recovery input")).toBe(
					true,
				);
				await inspect.bridge.close();
				expect(await readdir(scratch)).toEqual([]);
				expect(await readFile(join(personal, "config.toml"), "utf8")).toBe(
					parentConfig,
				);
				expect(await readdir(personal)).toEqual(["auth.json", "config.toml"]);
			},
			90_000,
		);

		it.each(["missing", "corrupt"])(
			"fails closed on %s native history without replacing the Session",
			async (damage) => {
				const path = join(await directory(), "driver.json");
				const accepted = await seedDriver(path);
				const original = await mapping(path);
				const home = `${path}.native/home`;
				const rollouts = (await readdir(home, { recursive: true })).filter(
					(name) => name.endsWith(".jsonl"),
				);
				expect(rollouts.length).toBe(1);
				for (const rollout of rollouts) {
					if (damage === "missing") await rm(join(home, rollout));
					else
						await writeFile(
							join(home, rollout),
							"synthetic corrupt native history\n",
						);
				}
				const restored = await nativeDriver(path);
				await expect(
					restored.execute(submit("synthetic-next", accepted.nativeSessionRef)),
				).rejects.toMatchObject({
					code: "RUNTIME_CODEX_UNAVAILABLE",
					message: "Codex Runtime is unavailable",
				});
				expect(
					JSON.stringify(await restored.execute(submit())) ===
						JSON.stringify(accepted),
				).toBe(true);
				expect((await mapping(path)).threadId === original.threadId).toBe(true);
				const healthy = await restored.execute({
					...submit("synthetic-other"),
					conversationId: "synthetic-other-conversation",
				});
				expect(healthy.result.outcome).toBe("accepted");
			},
			90_000,
		);

		it.each([
			"missing mapping",
			"corrupt mapping",
			"missing native root",
			"missing workspace",
		])(
			"rejects %s without silently creating replacement state",
			async (damage) => {
				const path = join(await directory(), "driver.json");
				await seedDriver(path);
				if (damage === "missing mapping") await rm(path);
				if (damage === "corrupt mapping")
					await writeFile(path, "synthetic corrupt driver state");
				if (damage === "missing native root")
					await rm(`${path}.native`, { recursive: true });
				if (damage === "missing workspace")
					await rm(`${path}.native/workspace`, { recursive: true });
				await expect(nativeDriver(path)).rejects.toMatchObject({
					httpStatus: 503,
				});
				if (damage === "missing mapping")
					await expect(access(path)).rejects.toThrow();
				if (damage === "missing native root")
					await expect(access(`${path}.native`)).rejects.toThrow();
				if (damage === "missing workspace")
					await expect(access(`${path}.native/workspace`)).rejects.toThrow();
			},
			90_000,
		);
	});
