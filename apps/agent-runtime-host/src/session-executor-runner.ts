import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
	CODEX_PILOT_EXECUTABLE,
	CODEX_SESSION_EXECUTOR_BACKEND,
	CODEX_SESSION_EXECUTOR_BINDING_ENV,
	type CodexSessionExecutorBindingV1,
	codexSessionExecutorBindingDigestV1,
	initializeCodexSessionExecutorWorkspaceV1,
	parseCodexSessionExecutorBindingV1,
	probeCodexSessionExecutorStartupV1,
	verifyCodexPilotInstallation,
} from "@agent-infra/agent-runtime";
import { WebSocket, WebSocketServer } from "ws";
import { assertRuntimeProcessProtection } from "./process-protection.js";

const maximumProxyMessageBytes = 64 * 1024 * 1024;

/** @internal Started only after the fixed deployment probe, never by a readiness request. */
export async function startCodexSessionExecutorGatewayV1(
	binding: CodexSessionExecutorBindingV1,
	podUid: string,
	epoch: string,
	onDisconnect: () => void,
) {
	const status = {
		schemaVersion: 1 as const,
		podUid,
		bindingDigest: codexSessionExecutorBindingDigestV1(binding),
		epoch,
		ready: true,
	};
	const streams = new Set<import("node:http").ServerResponse>();
	const pairs = new Map<WebSocket, WebSocket>();
	let closed = false;
	const poison = () => {
		if (!status.ready) return;
		status.ready = false;
		for (const stream of streams) stream.end();
		for (const [front, back] of pairs) {
			front.terminate();
			back.terminate();
		}
		if (!closed) onDisconnect();
	};
	const server = createServer((request, response) => {
		if (
			request.method !== "GET" ||
			request.headers.origin !== undefined ||
			!["/status", "/lifetime"].includes(request.url ?? "")
		) {
			response.writeHead(404).end();
			return;
		}
		if (!status.ready) {
			response.writeHead(503).end();
			return;
		}
		response.writeHead(200, {
			"content-type": "application/json",
			"cache-control": "no-store",
		});
		if (request.url === "/status") {
			response.end(JSON.stringify(status));
			return;
		}
		// A Host observes this connection once. Reconnecting cannot attest the old executor.
		streams.add(response);
		response.write(`${JSON.stringify(status)}\n`);
		const timer = setInterval(() => {
			if (response.writableLength > 4096) {
				response.destroy();
				return;
			}
			response.write(`${JSON.stringify(status)}\n`);
		}, 250);
		timer.unref();
		response.on("close", () => {
			clearInterval(timer);
			streams.delete(response);
		});
	});
	const sockets = new WebSocketServer({
		noServer: true,
		maxPayload: maximumProxyMessageBytes,
	});
	server.on("upgrade", (request, socket, head) => {
		if (
			closed ||
			!status.ready ||
			request.url !== "/" ||
			request.headers.origin !== undefined
		) {
			socket.destroy();
			return;
		}
		sockets.handleUpgrade(request, socket, head, (front) =>
			sockets.emit("connection", front),
		);
	});
	sockets.on("connection", (front: WebSocket) => {
		const back = new WebSocket(CODEX_SESSION_EXECUTOR_BACKEND, {
			maxPayload: maximumProxyMessageBytes,
			handshakeTimeout: 2000,
		});
		pairs.set(front, back);
		const queued: { data: Buffer; binary: boolean }[] = [];
		let queuedBytes = 0;
		front.on("message", (data, binary) => {
			if (back.readyState === WebSocket.OPEN) {
				if (back.bufferedAmount > maximumProxyMessageBytes) {
					poison();
					return;
				}
				back.send(data, { binary });
			} else if (
				back.readyState === WebSocket.CONNECTING &&
				queued.length < 16 &&
				queuedBytes + Buffer.byteLength(data as Buffer) <=
					maximumProxyMessageBytes
			) {
				queuedBytes += Buffer.byteLength(data as Buffer);
				queued.push({ data: Buffer.from(data as Buffer), binary });
			} else poison();
		});
		back.on("open", () => {
			for (const item of queued.splice(0))
				back.send(item.data, { binary: item.binary });
			queuedBytes = 0;
		});
		back.on("message", (data, binary) => {
			if (
				front.readyState !== WebSocket.OPEN ||
				front.bufferedAmount > maximumProxyMessageBytes
			) {
				poison();
				return;
			}
			front.send(data, { binary });
		});
		for (const socket of [front, back]) {
			socket.on("error", poison);
			socket.on("close", () => {
				if (!closed) poison();
				front.terminate();
				back.terminate();
				pairs.delete(front);
			});
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(8068, "127.0.0.1", resolve);
	});
	return {
		async close() {
			if (closed) return;
			closed = true;
			poison();
			for (const stream of streams) stream.destroy();
			for (const [front, back] of pairs) {
				front.terminate();
				back.terminate();
			}
			sockets.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function run() {
	assertRuntimeProcessProtection();
	const binding = parseCodexSessionExecutorBindingV1(
		JSON.parse(process.env[CODEX_SESSION_EXECUTOR_BINDING_ENV] ?? ""),
	);
	const mode = process.argv[2];
	if (process.argv.length !== 3 || !["init", "run"].includes(mode ?? ""))
		throw new Error("CODEX_SESSION_EXECUTOR_INVALID");
	if (mode === "init") {
		await initializeCodexSessionExecutorWorkspaceV1(binding);
		return;
	}
	const allowed = new Set([
		CODEX_SESSION_EXECUTOR_BINDING_ENV,
		"AGENT_INFRA_RUNTIME_POD_UID",
		"AGENT_INFRA_RUNTIME_INSTALLED_SKILL",
		"AGENT_INFRA_RUNTIME_DATA_DIR",
	]);
	if (
		Object.keys(process.env).some(
			(name) => name.startsWith("AGENT_INFRA_") && !allowed.has(name),
		) ||
		(process.env.AGENT_INFRA_RUNTIME_DATA_DIR !== undefined &&
			process.env.AGENT_INFRA_RUNTIME_DATA_DIR !== "/var/lib/agent-runtime")
	)
		throw new Error("CODEX_SESSION_EXECUTOR_INVALID");
	const podUid = process.env.AGENT_INFRA_RUNTIME_POD_UID;
	if (!podUid || !/^[a-zA-Z0-9-]{1,256}$/.test(podUid))
		throw new Error("CODEX_SESSION_EXECUTOR_INVALID");
	await verifyCodexPilotInstallation(
		process.env.AGENT_INFRA_RUNTIME_INSTALLED_SKILL === "workspace-summary-v1"
			? "workspace-summary-v1"
			: undefined,
	);
	const home = "/tmp/codex-executor-home";
	await mkdir(home, { mode: 0o700 });
	const child = spawn(
		CODEX_PILOT_EXECUTABLE,
		["exec-server", "--listen", CODEX_SESSION_EXECUTOR_BACKEND],
		{
			cwd: binding.workspaceRoot,
			env: {
				PATH: "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
				HOME: home,
				CODEX_HOME: home,
				TMPDIR: "/tmp",
			},
			stdio: ["ignore", "ignore", "ignore"],
			detached: true,
		},
	);
	let stopping = false;
	let gateway:
		| Awaited<ReturnType<typeof startCodexSessionExecutorGatewayV1>>
		| undefined;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		void gateway?.close().catch(() => {});
		try {
			if (child.pid) process.kill(-child.pid, "SIGTERM");
		} catch {
			/* Already exited. */
		}
		setTimeout(() => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				/* Already exited. */
			}
			process.exit(1);
		}, 1000).unref();
	};
	child.once("error", stop);
	child.once("exit", stop);
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		// Only connection establishment may retry; a command that was sent is never replayed.
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error("CODEX_EXECUTOR_STARTUP_FAILED")),
				5000,
			);
			child.once("spawn", () => {
				clearTimeout(timeout);
				resolve();
			});
			child.once("error", () => {
				clearTimeout(timeout);
				reject(new Error("CODEX_EXECUTOR_STARTUP_FAILED"));
			});
		});
		// The fixed server binds its listener after spawning; only readiness-free connection attempts may retry.
		await new Promise((resolve) => setTimeout(resolve, 200));
		await probeCodexSessionExecutorStartupV1(binding);
		if (stopping) throw new Error("CODEX_EXECUTOR_STARTUP_FAILED");
		gateway = await startCodexSessionExecutorGatewayV1(
			binding,
			podUid,
			randomUUID(),
			stop,
		);
	} catch {
		process.exitCode = 1;
		stop();
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	void run().catch(() => {
		console.error(
			JSON.stringify({
				service: "codex-session-executor",
				code: "CODEX_EXECUTOR_STARTUP_FAILED",
			}),
		);
		process.exitCode = 1;
	});
}
