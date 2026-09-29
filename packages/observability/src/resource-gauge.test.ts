import { createServer } from "node:http";
import { Writable } from "node:stream";
import protobuf from "protobufjs";
import { expect, it, vi } from "vitest";
import { startObservability } from "./index.js";

const metricRequest = protobuf
	.parse(
		`syntax = "proto3";
	message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
	message ResourceMetrics { repeated ScopeMetrics scope_metrics = 2; }
	message ScopeMetrics { repeated Metric metrics = 2; }
	message Metric { string name = 1; string unit = 3; Gauge gauge = 5; }
	message Gauge { repeated NumberDataPoint data_points = 1; }
	message NumberDataPoint { double as_double = 4; repeated KeyValue attributes = 7; }
	message KeyValue { string key = 1; AnyValue value = 2; }
	message AnyValue { string string_value = 1; }
`,
		{ keepCase: true },
	)
	.root.lookupType("ExportMetricsServiceRequest");

interface GaugePoint {
	as_double?: number;
	attributes?: { key: string; value?: { string_value?: string } }[];
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing OTLP metrics request");
	return value;
}

function resourcePoints(body: Buffer): GaugePoint[] {
	const request = metricRequest.toObject(metricRequest.decode(body)) as {
		resource_metrics?: {
			scope_metrics?: {
				metrics?: {
					name?: string;
					unit?: string;
					gauge?: { data_points?: GaugePoint[] };
				}[];
			}[];
		}[];
	};
	return (request.resource_metrics ?? []).flatMap((resource) =>
		(resource.scope_metrics ?? []).flatMap((scope) =>
			(scope.metrics ?? []).flatMap((metric) => {
				if (metric.name !== "agent_platform_resource_count") return [];
				expect(metric.unit).toBe("1");
				return metric.gauge?.data_points ?? [];
			}),
		),
	);
}

function labeledPoints(points: GaugePoint[]) {
	return points.map((point) => ({
		value: point.as_double,
		labels: Object.fromEntries(
			(point.attributes ?? []).map(({ key, value }) => [
				key,
				value?.string_value,
			]),
		),
	}));
}

it("exports the latest bounded resource snapshot without inventing zero samples", async () => {
	const requests: Buffer[] = [];
	const collector = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		if (request.url === "/v1/metrics") requests.push(Buffer.concat(chunks));
		response.writeHead(200);
		response.end();
	});
	await new Promise<void>((resolve, reject) => {
		collector.once("error", reject);
		collector.listen(0, "127.0.0.1", resolve);
	});
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
	let clock: ReturnType<typeof vi.spyOn> | undefined;
	try {
		telemetry.record({ stage: "worker", outcome: "completed" });
		await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), {
			timeout: 5000,
			interval: 100,
		});
		expect(resourcePoints(required(requests.at(-1)))).toHaveLength(0);

		telemetry.observeResource({ kind: "task_waiting", value: 2 });
		telemetry.observeResource({ kind: "task_waiting", value: 5 });
		telemetry.observeResource({
			kind: "sse_connections",
			value: 0,
			secret: "PRIVATE_SENTINEL",
		} as Parameters<typeof telemetry.observeResource>[0]);
		await vi.waitFor(
			() => {
				const latest = requests.at(-1);
				expect(latest).toBeDefined();
				expect(labeledPoints(resourcePoints(required(latest)))).toEqual([
					{
						value: 5,
						labels: { service: "platform-worker", kind: "task_waiting" },
					},
					{
						value: 0,
						labels: { service: "platform-worker", kind: "sse_connections" },
					},
				]);
			},
			{ timeout: 5000, interval: 100 },
		);
		for (const request of requests)
			expect(request.toString()).not.toContain("PRIVATE_SENTINEL");

		const nextExport = requests.length;
		clock = vi.spyOn(performance, "now").mockReturnValue(1_000_000_000);
		expect(performance.now()).toBe(1_000_000_000);
		telemetry.record({ stage: "worker", outcome: "completed" });
		await vi.waitFor(
			() => {
				expect(requests.length).toBeGreaterThan(nextExport);
				expect(resourcePoints(required(requests.at(-1)))).toHaveLength(0);
			},
			{ timeout: 5000, interval: 100 },
		);

		const resumedExport = requests.length;
		telemetry.observeResource({ kind: "task_waiting", value: 7 });
		await vi.waitFor(
			() => {
				expect(requests.length).toBeGreaterThan(resumedExport);
				expect(
					labeledPoints(resourcePoints(required(requests.at(-1)))),
				).toEqual([
					{
						value: 7,
						labels: { service: "platform-worker", kind: "task_waiting" },
					},
				]);
			},
			{ timeout: 5000, interval: 100 },
		);
	} finally {
		clock?.mockRestore();
		await telemetry.close();
		await new Promise<void>((resolve) => collector.close(() => resolve()));
	}
}, 10_000);

it("keeps resource snapshots within their own concurrent and restarted instance", async () => {
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
	const address = collector.address();
	if (!address || typeof address === "string")
		throw new Error("No collector port");
	const start = (path: string) =>
		startObservability({
			service: "platform-worker",
			otlpEndpoint: `http://127.0.0.1:${address.port}/${path}/`,
			metricIntervalMs: 1000,
			output: new Writable({
				write(_chunk, _encoding, done) {
					done();
				},
			}),
		});
	const first = start("first");
	const second = start("second");
	let restarted: ReturnType<typeof start> | undefined;
	const latest = (path: string) =>
		requests.filter((request) => request.path === `/${path}/v1/metrics`).at(-1);
	try {
		first.observeResource({ kind: "task_waiting", value: 3 });
		second.observeResource({ kind: "task_waiting", value: 9 });
		await vi.waitFor(
			() => {
				expect(
					labeledPoints(resourcePoints(required(latest("first")).body)),
				).toEqual([
					{
						value: 3,
						labels: { service: "platform-worker", kind: "task_waiting" },
					},
				]);
				expect(
					labeledPoints(resourcePoints(required(latest("second")).body)),
				).toEqual([
					{
						value: 9,
						labels: { service: "platform-worker", kind: "task_waiting" },
					},
				]);
			},
			{ timeout: 5000, interval: 100 },
		);
		await first.close();
		restarted = start("restarted");
		restarted.record({ stage: "worker", outcome: "completed" });
		await vi.waitFor(() => expect(latest("restarted")).toBeDefined(), {
			timeout: 5000,
			interval: 100,
		});
		expect(resourcePoints(required(latest("restarted")).body)).toHaveLength(0);
		restarted.observeResource({ kind: "task_waiting", value: 4 });
		const prior = requests.length;
		await vi.waitFor(
			() => {
				expect(requests.length).toBeGreaterThan(prior);
				expect(
					labeledPoints(resourcePoints(required(latest("restarted")).body)),
				).toEqual([
					{
						value: 4,
						labels: { service: "platform-worker", kind: "task_waiting" },
					},
				]);
			},
			{ timeout: 5000, interval: 100 },
		);
	} finally {
		await Promise.all([first.close(), second.close(), restarted?.close()]);
		await new Promise<void>((resolve) => collector.close(() => resolve()));
	}
}, 12_000);
