import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { PiRuntimeDriver } from "./pi-runtime-driver.js";

const command = {
	schemaVersion: 2 as const,
	kind: "submit-turn" as const,
	agentId: "agent-a",
	conversationId: "conversation-a",
	sessionGeneration: 1,
	executionId: "execution-a",
	turnId: "turn-a",
	operationId: "operation-a",
	input: { text: "synthetic input", attachments: [] },
	selection: {
		schemaVersion: 1 as const,
		modelOptionId: "primary",
		reasoningLevel: "high",
	},
};
async function fixture(mode = "normal") {
	const path = await mkdtemp(join(tmpdir(), "pi-driver-"));
	const options = {
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "configured/model",
				reasoningLevels: ["high"],
			},
		],
		launch: async () => ({
			command: process.execPath,
			args: [
				fileURLToPath(new URL("./pi-peer.test-support.mjs", import.meta.url)),
			],
			env: { PI_PEER_MODE: mode },
		}),
	};
	let driver = await PiRuntimeDriver.open(options);
	return {
		path,
		get driver() {
			return driver;
		},
		async restart() {
			await driver.close();
			driver = await PiRuntimeDriver.open(options);
		},
		async close() {
			await driver.close();
			await rm(path, { recursive: true, force: true });
		},
	};
}

it.each([false, true])(
	"keeps ACK separate from completion and resumes the exact session (native exit: %s)",
	async (exit) => {
		const f = await fixture("tool");
		try {
			const result = await f.driver.execute(command);
			expect(result.result).toEqual({ outcome: "accepted", status: "running" });
			expect(
				await f.driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe("running");
			await vi.waitFor(async () =>
				expect(
					await f.driver.getStatus(
						result.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			);
			const events = await f.driver.replayEvents(
				result.nativeSessionRef,
				command.executionId,
			);
			expect(
				events.flatMap((event) =>
					event.type === "operation" && event.payload.kind === "model"
						? [event.payload.phase]
						: [],
				),
			).toEqual(["intent", "completed"]);
			expect(
				events.flatMap((event) =>
					event.type === "operation" && event.payload.kind === "tool"
						? [event.payload.phase]
						: [],
				),
			).toEqual(["intent", "started", "completed"]);
			expect(
				events
					.filter((event) => event.type === "text")
					.map((event) => event.payload.delta)
					.join(""),
			).toBe("synthetic result");
			expect(events.filter((event) => event.type === "completed")).toHaveLength(
				1,
			);
			expect(JSON.stringify(events)).not.toContain("sensitive-vendor-canary");
			const ownerFile = join(f.path, result.nativeSessionRef, "process.json");
			const owner = JSON.parse(await readFile(ownerFile, "utf8")).owner;
			const stateFile = join(f.path, result.nativeSessionRef, "state.json");
			const nativeId = JSON.parse(await readFile(stateFile, "utf8")).nativeId;
			if (exit) {
				process.kill(owner.pid, "SIGKILL");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const next = await f.driver.execute({
				...command,
				nativeSessionRef: result.nativeSessionRef,
				executionId: "execution-b",
				turnId: "turn-b",
				operationId: "operation-b",
			});
			await vi.waitFor(async () =>
				expect(
					await f.driver.getStatus(next.nativeSessionRef, "execution-b"),
				).toBe("completed"),
			);
			const nextOwner = JSON.parse(await readFile(ownerFile, "utf8")).owner;
			expect(nextOwner.pid === owner.pid).toBe(!exit);
			expect(JSON.parse(await readFile(stateFile, "utf8")).nativeId).toBe(
				nativeId,
			);
			await f.restart();
			expect(await f.driver.execute(command)).toEqual(result);
			expect(
				await f.driver.replayEvents(
					result.nativeSessionRef,
					command.executionId,
				),
			).toEqual(events);
		} finally {
			await f.close();
		}
	},
);

it.each(["normal", "cancel", "abort-only"])(
	"does not interpret abort ACK as a terminal result (%s)",
	async (mode) => {
		const f = await fixture(mode);
		try {
			const result = await f.driver.execute(command);
			const { input: _input, selection: _selection, ...identity } = command;
			const stop = await f.driver.execute({
				...identity,
				schemaVersion: 1,
				kind: "stop",
				nativeSessionRef: result.nativeSessionRef,
				operationId: "stop-a",
			});
			if (mode === "abort-only") {
				expect(stop.result.outcome).toBe("unknown");
				expect(
					await f.driver.getStatus(
						result.nativeSessionRef,
						command.executionId,
					),
				).toBe("running");
			} else
				expect(stop.result).toEqual({
					outcome: "accepted",
					status: mode === "cancel" ? "cancelled" : "completed",
				});
		} finally {
			await f.close();
		}
	},
);

it.each([
	"exit",
	"malformed",
	"wrong-response",
	"stale-terminal",
	"missing-history",
	"changed-history",
])("keeps uncertain execution unknown and sanitizes %s", async (mode) => {
	const f = await fixture(mode);
	try {
		const result = await f.driver.execute(command);
		await vi.waitFor(async () =>
			expect(
				await f.driver.getStatus(result.nativeSessionRef, command.executionId),
			).toBe("unknown"),
		);
		const events = await f.driver.replayEvents(
			result.nativeSessionRef,
			command.executionId,
		);
		expect(events.some((event) => event.type === "completed")).toBe(false);
		expect(JSON.stringify(events)).not.toContain("sensitive-vendor-canary");
		expect(await f.driver.execute(command)).toEqual(result);
	} finally {
		await f.close();
	}
});

it("fails closed without the workspace policy and retires the process", async () => {
	const f = await fixture("missing-policy");
	try {
		await expect(f.driver.execute(command)).rejects.toThrow(
			"Runtime session could not be recovered",
		);
		const ref = JSON.parse(await readFile(join(f.path, "index.json"), "utf8"))
			.sessions[0].ref;
		expect(
			JSON.parse(await readFile(join(f.path, ref, "process.json"), "utf8")),
		).toEqual({});
	} finally {
		await f.close();
	}
});

it.each(["invalid-json", "self-cycle", "two-node-cycle"])(
	"rejects a damaged native session (%s) without blocking a healthy conversation",
	async (corruption) => {
		const f = await fixture();
		try {
			const result = await f.driver.execute(command);
			await vi.waitFor(async () =>
				expect(
					await f.driver.getStatus(
						result.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			);
			await f.restart();
			const file = join(
				f.path,
				result.nativeSessionRef,
				"native/session.jsonl",
			);
			const header = (await readFile(file, "utf8")).split("\n")[0];
			const nodes = [
				{
					type: "message",
					id: "cycle-a",
					parentId: corruption === "self-cycle" ? "cycle-a" : "cycle-b",
					message: { role: "user", content: "synthetic" },
				},
			];
			if (corruption === "two-node-cycle")
				nodes.push({
					type: "message",
					id: "cycle-b",
					parentId: "cycle-a",
					message: { role: "user", content: "synthetic" },
				});
			const corrupt =
				corruption === "invalid-json"
					? "damaged-session-evidence"
					: `${header}\n${nodes.map((node) => JSON.stringify(node)).join("\n")}\n`;
			await writeFile(file, corrupt);
			await expect(
				f.driver.execute({
					...command,
					nativeSessionRef: result.nativeSessionRef,
					executionId: "execution-b",
					turnId: "turn-b",
					operationId: "operation-b",
				}),
			).rejects.toThrow("Runtime session could not be recovered");
			expect(await readFile(file, "utf8")).toBe(corrupt);
			const healthy = await f.driver.execute({
				...command,
				conversationId: "healthy-conversation",
			});
			await vi.waitFor(async () =>
				expect(
					await f.driver.getStatus(
						healthy.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			);
		} finally {
			await f.close();
		}
	},
);
