import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { startObservability } from "./index.js";

const TRACE_QUEUE_SIZE = 512;
const TRACE_BATCH_SIZE = 32;
const TRACE_RECORDS = TRACE_QUEUE_SIZE + 128;
const MAX_TRACE_REQUESTS = Math.ceil(TRACE_QUEUE_SIZE / TRACE_BATCH_SIZE) + 1;
const CLOSE_BOUND_MS = 5000;
const CHILD_EXIT_BOUND_MS = 8000;

type RequestRecord = { path: string; body: Buffer };
const activeTelemetry: Array<{ close(): Promise<void> }> = [];
const activeCollectors: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.allSettled(
		activeTelemetry.splice(0).map((item) => item.close()),
	);
	await Promise.allSettled(
		activeCollectors.splice(0).map((item) => item.close()),
	);
});

async function createSlowCollector() {
	const requests: RequestRecord[] = [];
	const sockets = new Set<Socket>();
	const pending: Array<{ response: import("node:http").ServerResponse }> = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			requests.push({
				path: request.url ?? "",
				body: Buffer.concat(chunks),
			});
			pending.push({ response });
		});
	});
	server.on("connection", (socket) => {
		const connection = socket as Socket;
		sockets.add(connection);
		connection.once("close", () => sockets.delete(connection));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No collector port");
	return {
		endpoint: `http://127.0.0.1:${address.port}`,
		requests,
		async close() {
			for (const { response } of pending) response.destroy();
			for (const socket of sockets) socket.destroy();
			if (server.listening)
				await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 4000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 50));
	expect(condition()).toBe(true);
}

function traceRequests(requests: RequestRecord[]) {
	return requests.filter((request) => request.path === "/v1/traces");
}

it("bounds real trace export under a slow OTLP sink and closes within five seconds", async () => {
	const collector = await createSlowCollector();
	activeCollectors.push(collector);
	const logOutput: Buffer[] = [];
	const telemetry = startObservability({
		service: "platform-worker",
		otlpEndpoint: collector.endpoint,
		metricIntervalMs: 1000,
		output: new Writable({
			write(chunk, _encoding, done) {
				logOutput.push(Buffer.from(chunk));
				done();
			},
		}),
	});
	activeTelemetry.push(telemetry);
	const markers = Array.from(
		{ length: TRACE_RECORDS },
		(_, index) => `queue-${index}`,
	);
	for (const operationRef of markers) {
		telemetry.record({
			stage: "worker",
			outcome: "completed",
			operationRef,
			requestId: "PRIVATE_SENTINEL",
		});
	}
	const businessResult = { completed: true };

	// The test intentionally records beyond BatchSpanProcessor's 512-span queue.
	expect(markers.length).toBeGreaterThan(TRACE_QUEUE_SIZE);
	await waitFor(() => traceRequests(collector.requests).length > 0);
	const received = markers.filter((marker) =>
		traceRequests(collector.requests).some((request) =>
			request.body.toString("utf8").includes(marker),
		),
	).length;
	expect(received).toBeGreaterThan(0);
	expect(received).toBeLessThan(markers.length);

	const startedAt = Date.now();
	await telemetry.close();
	const elapsed = Date.now() - startedAt;
	expect(elapsed).toBeLessThanOrEqual(CLOSE_BOUND_MS);
	await waitFor(() => telemetry.status().state === "closed");
	expect(telemetry.status().exportFailures).toBeGreaterThan(0);
	expect(businessResult.completed).toBe(true);
	for (const request of collector.requests)
		expect(request.body.toString("utf8")).not.toContain("PRIVATE_SENTINEL");
	await new Promise((resolve) => setTimeout(resolve, 500));
	expect(traceRequests(collector.requests).length).toBeLessThanOrEqual(
		MAX_TRACE_REQUESTS,
	);
	const traceCountAfterClose = traceRequests(collector.requests).length;
	telemetry.record({
		stage: "worker",
		outcome: "completed",
		operationRef: "after-close",
	});
	await new Promise((resolve) => setTimeout(resolve, 2500));
	expect(traceRequests(collector.requests).length).toBe(traceCountAfterClose);
	expect(Buffer.concat(logOutput).toString("utf8")).not.toContain(
		"PRIVATE_SENTINEL",
	);
});

it("lets a child using the real package exit naturally after a slow export", async () => {
	const collector = await createSlowCollector();
	activeCollectors.push(collector);
	const packageEntry = fileURLToPath(
		new URL("../dist/index.mjs", import.meta.url),
	);
	const script = `
		import { Writable } from "node:stream";
		import { startObservability } from ${JSON.stringify(packageEntry)};
		const telemetry = startObservability({
			service: "platform-worker",
			otlpEndpoint: ${JSON.stringify(collector.endpoint)},
			metricIntervalMs: 1000,
			output: new Writable({ write(_chunk, _encoding, done) { done(); } }),
		});
		telemetry.record({ stage: "worker", outcome: "completed", operationRef: "child-natural-exit" });
		console.log("CHILD_BUSINESS_COMPLETE");
		await telemetry.close();
		console.log("CHILD_TELEMETRY_CLOSED");
		const activeResources = process.getActiveResourcesInfo();
		const otelLeaks = activeResources.filter((resource) =>
			["Timeout", "TCP", "TCPConnectWrap", "TCPSocketWrap", "HTTPParser"].includes(resource),
		);
		if (otelLeaks.length > 0) {
			console.error("CHILD_OTEL_HANDLES:", otelLeaks.join(","));
			process.exitCode = 1;
		} else {
			console.log("CHILD_NO_OTEL_HANDLES");
		}
	`;
	const child = spawn(
		process.execPath,
		["--input-type=module", "--eval", script],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (!child.stdout || !child.stderr) {
		child.kill("SIGKILL");
		throw new Error("child stdio was not piped");
	}
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
	const exit = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("child did not exit within the bounded deadline"));
		}, CHILD_EXIT_BOUND_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
	const result = await exit;
	expect(result).toMatchObject({ code: 0, signal: null });
	expect(Buffer.concat(stdout).toString("utf8")).toContain(
		"CHILD_BUSINESS_COMPLETE",
	);
	expect(Buffer.concat(stdout).toString("utf8")).toContain(
		"CHILD_TELEMETRY_CLOSED",
	);
	expect(Buffer.concat(stdout).toString("utf8")).toContain(
		"CHILD_NO_OTEL_HANDLES",
	);
	expect(Buffer.concat(stderr).toString("utf8")).not.toContain(
		"PRIVATE_SENTINEL",
	);
	await waitFor(() =>
		traceRequests(collector.requests).some((request) =>
			request.body.toString("utf8").includes("child-natural-exit"),
		),
	);
	for (const request of collector.requests)
		expect(request.body.toString("utf8")).not.toContain("PRIVATE_SENTINEL");
});
