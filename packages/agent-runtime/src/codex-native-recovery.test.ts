import { execFileSync } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CODEX_APP_SERVER_V2_PROVENANCE,
	CodexAppServerBridge,
} from "./codex-app-server-bridge.js";
import { CodexRuntimeDriver } from "./codex-runtime-driver.js";
import type { RuntimeDriverCommand } from "./driver.js";

const directories: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
const enabled = process.env.AGENT_INFRA_CODEX_NATIVE_TEST === "1";

interface NativeResponses {
	initialize: unknown;
	"thread/resume": { thread: { id: string } };
	"thread/turns/list": { data: { id: string; status: string }[] };
	"thread/items/list": unknown;
}

// Only real Bridge frames enter this client. Assertions compare IDs as booleans
// so failures never print native IDs, protocol frames, or deployment paths.
class NativeClient {
	private sequence = 0;
	private readonly responses = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	constructor(readonly bridge: CodexAppServerBridge) {
		void (async () => {
			try {
				for await (const frame of bridge.frames()) {
					const pending =
						typeof frame.id === "number"
							? this.responses.get(frame.id)
							: undefined;
					if (pending && typeof frame.id === "number") {
						this.responses.delete(frame.id);
						if (frame.error)
							pending.reject(new Error("Native request unavailable"));
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
			this.responses.set(id, { resolve, reject }),
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
}

async function directory() {
	const path = await mkdtemp(join(tmpdir(), "agent-runtime-native-recovery-"));
	directories.push(path);
	return path;
}

async function nativeClient(path: string) {
	const bridge = await CodexAppServerBridge.open({
		dataDirectory: path,
		model: "gpt-5.3-codex",
		reasoningEffort: "low",
		provenance: CODEX_APP_SERVER_V2_PROVENANCE,
	});
	closers.push(() => bridge.close());
	const client = new NativeClient(bridge);
	await client.request("initialize", {
		clientInfo: { name: "synthetic-recovery-test", version: "1" },
	});
	return client;
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
		input: { text: "synthetic recovery input", attachments: [] },
		...(nativeSessionRef ? { nativeSessionRef } : {}),
	};
}

async function mapping(path: string) {
	const state = JSON.parse(await readFile(path, "utf8")) as {
		sessions: Record<
			string,
			{ threadId: string; executions: Record<string, { nativeTurnId: string }> }
		>;
	};
	const sessions = Object.values(state.sessions);
	if (sessions.length !== 1 || !sessions[0])
		throw new Error("Expected one native session mapping");
	return sessions[0];
}

async function seedDriver(path: string) {
	const driver = await nativeDriver(path);
	const accepted = await driver.execute(submit());
	expect(accepted.result.outcome).toBe("accepted");
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
			30_000,
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
			30_000,
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
			20_000,
		);
	});
