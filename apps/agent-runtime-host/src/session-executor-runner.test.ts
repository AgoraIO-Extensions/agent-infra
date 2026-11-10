import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import {
	createCodexSessionExecutorBindingV1,
	openCodexSessionExecutorAdmissionV1,
	probeCodexSessionExecutorStartupV1,
} from "@agent-infra/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startCodexSessionExecutorGatewayV1 } from "./session-executor-runner.js";

const binding = createCodexSessionExecutorBindingV1({
	namespace: "test-runtime",
	podName: "sandbox-a",
	sandboxId: "a",
	agentId: "agent-a",
	conversationId: "conversation-a",
	sessionGeneration: 1,
	resourceFence: 1,
	imageDigest: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

function status(path: string, headers: Record<string, string> = {}) {
	return new Promise<number>((resolve, reject) => {
		const call = request(
			`http://127.0.0.1:8068${path}`,
			{ agent: false, headers },
			(response) => {
				response.resume();
				response.once("end", () => resolve(response.statusCode ?? 0));
			},
		);
		call.once("error", reject);
		call.end();
	});
}

async function backend(
	onConnection: (socket: WebSocket) => void = (socket) =>
		socket.on("message", (message, binary) => socket.send(message, { binary })),
) {
	const server = createServer();
	const ws = new WebSocketServer({ server });
	ws.on("connection", onConnection);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(8070, "127.0.0.1", resolve);
	});
	cleanups.push(async () => {
		for (const client of ws.clients) client.terminate();
		ws.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
}

async function startupBackend(
	outcome:
		| "success"
		| "start-ack-only"
		| "streams-open"
		| "nonzero-exit"
		| "process-failure"
		| "file-mismatch"
		| "start-error",
) {
	const methods: string[] = [];
	let connections = 0;
	let reads = 0;
	await backend((socket) => {
		connections++;
		socket.on("message", (message) => {
			const frame = JSON.parse(message.toString());
			methods.push(frame.method);
			if (frame.id === undefined) return;
			let result: unknown = {};
			if (frame.method === "initialize")
				result = { sessionId: "synthetic-startup-session" };
			if (frame.method === "process/start" && outcome === "start-error") {
				socket.send(
					JSON.stringify({
						id: frame.id,
						error: { code: -32000, message: "synthetic-startup-rejection" },
					}),
				);
				return;
			}
			if (frame.method === "process/read") {
				reads++;
				result = {
					chunks:
						reads === 1 && outcome !== "start-ack-only"
							? [{ seq: 1, stream: "stdout", chunk: "b2sK" }]
							: [],
					nextSeq: 2,
					exited: outcome !== "start-ack-only",
					closed: outcome !== "start-ack-only" && outcome !== "streams-open",
					exitCode: outcome === "nonzero-exit" ? 41 : 0,
					failure:
						outcome === "process-failure"
							? { code: "synthetic-process-failure" }
							: null,
					sandboxDenied: false,
				};
			}
			if (frame.method === "fs/readFile")
				result = { dataBase64: outcome === "file-mismatch" ? "bm8K" : "b2sK" };
			socket.send(JSON.stringify({ id: frame.id, result }));
		});
	});
	return {
		methods,
		connections: () => connections,
		reads: () => reads,
	};
}

describe.sequential("Session executor loopback gateway", () => {
	it("admits startup only after the process closes successfully and remote output matches", async () => {
		const startup = await startupBackend("success");
		await expect(
			probeCodexSessionExecutorStartupV1(binding),
		).resolves.toBeUndefined();
		expect(
			startup.methods.filter((method) => method === "process/start"),
		).toHaveLength(1);
		expect(startup.methods).toContain("fs/readFile");
		expect(startup.methods.at(-1)).toBe("fs/remove");
		expect(startup.connections()).toBe(1);
	});

	it.each(["start-ack-only", "streams-open"] as const)(
		"does not admit startup on %s or replay its process",
		async (outcome) => {
			const startup = await startupBackend(outcome);
			await expect(probeCodexSessionExecutorStartupV1(binding)).rejects.toThrow(
				/^CODEX_SESSION_EXECUTOR_INVALID$/,
			);
			expect(startup.reads()).toBe(8);
			expect(
				startup.methods.filter((method) => method === "process/start"),
			).toHaveLength(1);
			expect(startup.methods).not.toContain("fs/readFile");
			expect(startup.methods.at(-1)).toBe("fs/remove");
			expect(startup.connections()).toBe(1);
		},
	);

	it.each([
		"nonzero-exit",
		"process-failure",
		"file-mismatch",
		"start-error",
	] as const)(
		"rejects startup on %s without restarting the command",
		async (outcome) => {
			const startup = await startupBackend(outcome);
			await expect(probeCodexSessionExecutorStartupV1(binding)).rejects.toThrow(
				/^CODEX_(?:SESSION_EXECUTOR_INVALID|EXECUTOR_STARTUP_FAILED)$/,
			);
			expect(
				startup.methods.filter((method) => method === "process/start"),
			).toHaveLength(1);
			expect(startup.methods.at(-1)).toBe("fs/remove");
			expect(startup.connections()).toBe(1);
		},
	);

	it("forwards native traffic and permanently invalidates admission on disconnect", async () => {
		await backend();
		let poisoned = 0;
		const gateway = await startCodexSessionExecutorGatewayV1(
			binding,
			"pod-a",
			randomUUID(),
			() => {
				poisoned++;
			},
		);
		cleanups.push(() => gateway.close());
		const admission = await openCodexSessionExecutorAdmissionV1(
			binding,
			"pod-a",
		);
		cleanups.push(() => admission.close());
		const failed = new Promise<void>((resolve) => admission.onFailure(resolve));
		const socket = new WebSocket("ws://127.0.0.1:8068");
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		const reply = new Promise<string>((resolve, reject) => {
			socket.once("message", (data) => resolve(data.toString()));
			socket.once("error", reject);
		});
		socket.send('{"synthetic":"frame"}');
		expect(await reply).toBe('{"synthetic":"frame"}');
		await admission.assertCurrent();
		socket.close();
		await failed;
		expect(poisoned).toBe(1);
		expect(await status("/status")).toBe(503);
		await expect(admission.assertCurrent()).rejects.toThrow();
	});
	it("rejects browser Origin upgrades and arbitrary HTTP paths", async () => {
		const gateway = await startCodexSessionExecutorGatewayV1(
			binding,
			"pod-a",
			randomUUID(),
			() => {},
		);
		cleanups.push(() => gateway.close());
		expect(
			await status("/status", { origin: "https://untrusted.example.test" }),
		).toBe(404);
		expect(await status("/command")).toBe(404);
		const socket = new WebSocket("ws://127.0.0.1:8068", {
			origin: "https://untrusted.example.test",
		});
		let opened = false;
		socket.once("open", () => {
			opened = true;
			socket.close();
		});
		await new Promise<void>((resolve) => {
			socket.on("error", () => {});
			socket.once("close", resolve);
		});
		expect(opened).toBe(false);
	});
});
