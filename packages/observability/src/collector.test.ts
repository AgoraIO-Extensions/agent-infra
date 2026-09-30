import { createServer } from "node:http";
import { Writable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { startObservability } from "./index.js";

const active: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(active.splice(0).map((item) => item.close()));
});

it("exports correlated traces and bounded metrics to a local OTLP collector", async () => {
	const requests: Array<{ path: string; body: Buffer }> = [];
	const collector = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		requests.push({ path: request.url ?? "", body: Buffer.concat(chunks) });
		response.writeHead(200);
		response.end();
	});
	await new Promise<void>((resolve, reject) => {
		collector.once("error", reject);
		collector.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = collector.address();
		if (!address || typeof address === "string")
			throw new Error("No collector port");
		const telemetry = startObservability({
			service: "platform-worker",
			otlpEndpoint: `http://127.0.0.1:${address.port}`,
			metricIntervalMs: 1000,
			output: new Writable({
				write(_chunk, _encoding, done) {
					done();
				},
			}),
		});
		active.push(telemetry);
		telemetry.record({
			stage: "sse",
			outcome: "completed",
			ssePhase: "connected",
			agentId: "123e4567-e89b-42d3-a456-426614174001",
			conversationId: "123e4567-e89b-42d3-a456-426614174002",
			executionId: "123e4567-e89b-42d3-a456-426614174003",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			durationMs: 14,
			message: "PRIVATE_SENTINEL",
		} as Parameters<typeof telemetry.record>[0]);
		const deadline = Date.now() + 5000;
		while (
			(!requests.some((item) => item.path === "/v1/traces") ||
				!requests.some((item) => item.path === "/v1/metrics")) &&
			Date.now() < deadline
		)
			await new Promise((resolve) => setTimeout(resolve, 100));
		expect(requests.map((item) => item.path)).toContain("/v1/traces");
		expect(requests.map((item) => item.path)).toContain("/v1/metrics");
		expect(
			requests.find((item) => item.path === "/v1/traces")?.body.toString(),
		).toContain("123e4567-e89b-42d3-a456-426614174003");
		expect(
			requests.find((item) => item.path === "/v1/traces")?.body.toString(),
		).toContain("operation-1");
		expect(
			requests.find((item) => item.path === "/v1/traces")?.body.toString(),
		).toContain("attempt-1");
		expect(
			requests.find((item) => item.path === "/v1/traces")?.body.toString(),
		).toContain("connected");
		expect(
			requests.find((item) => item.path === "/v1/metrics")?.body.toString(),
		).toContain("connected");
		for (const request of requests)
			expect(request.body.toString()).not.toContain("PRIVATE_SENTINEL");
		expect(telemetry.status().exportFailures).toBe(0);
	} finally {
		await Promise.all(active.splice(0).map((item) => item.close()));
		await new Promise<void>((resolve) => collector.close(() => resolve()));
	}
}, 10_000);

it("keeps concurrent and restarted exporters on their own collector paths", async () => {
	const requests: Array<{ path: string; body: string }> = [];
	const collector = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		requests.push({
			path: request.url ?? "",
			body: Buffer.concat(chunks).toString(),
		});
		response.writeHead(200);
		response.end();
	});
	await new Promise<void>((resolve, reject) => {
		collector.once("error", reject);
		collector.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = collector.address();
		if (!address || typeof address === "string")
			throw new Error("No collector port");
		const output = new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		});
		const start = (path: string) => {
			const telemetry = startObservability({
				service: "platform-worker",
				otlpEndpoint: `http://127.0.0.1:${address.port}/${path}/`,
				metricIntervalMs: 1000,
				output,
			});
			active.push(telemetry);
			return telemetry;
		};
		const first = start("first");
		const second = start("second");
		second.record({
			stage: "worker",
			outcome: "completed",
			operationRef: "second-instance",
		});
		await first.close();
		const restarted = start("restarted");
		restarted.record({
			stage: "worker",
			outcome: "completed",
			operationRef: "restarted-instance",
		});
		const deadline = Date.now() + 5000;
		while (
			["second", "restarted"].some(
				(path) =>
					!requests.some((item) => item.path === `/${path}/v1/traces`) ||
					!requests.some((item) => item.path === `/${path}/v1/metrics`),
			) &&
			Date.now() < deadline
		)
			await new Promise((resolve) => setTimeout(resolve, 100));
		expect(second.status().enabled).toBe(true);
		expect(restarted.status().enabled).toBe(true);
		for (const [path, marker] of [
			["second", "second-instance"],
			["restarted", "restarted-instance"],
		] as const) {
			expect(requests.some((item) => item.path === `/${path}/v1/metrics`)).toBe(
				true,
			);
			expect(
				requests.some(
					(item) =>
						item.path === `/${path}/v1/traces` && item.body.includes(marker),
				),
			).toBe(true);
			expect(
				requests.some(
					(item) =>
						item.path !== `/${path}/v1/traces` && item.body.includes(marker),
				),
			).toBe(false);
		}
	} finally {
		await Promise.all(active.splice(0).map((item) => item.close()));
		await new Promise<void>((resolve) => collector.close(() => resolve()));
	}
}, 10_000);
