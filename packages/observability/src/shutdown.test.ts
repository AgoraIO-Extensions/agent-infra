import { Writable } from "node:stream";
import { ExportResultCode } from "@opentelemetry/core";
import { afterEach, expect, it, vi } from "vitest";
import { startObservability } from "./index.js";

const fake = vi.hoisted(() => ({
	traceExporter: undefined as
		| { export(data: unknown, done: (result: { code: number }) => void): void }
		| undefined,
	metricExporter: undefined as
		| { export(data: unknown, done: (result: { code: number }) => void): void }
		| undefined,
	traceExports: 0,
	metricExports: 0,
	resolveTrace: undefined as (() => void) | undefined,
	rejectTrace: undefined as ((error: Error) => void) | undefined,
	resolveMetric: undefined as (() => void) | undefined,
}));

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
	OTLPTraceExporter: class {
		constructor() {
			fake.traceExporter = this;
		}
		export(_data: unknown, done: (result: { code: number }) => void) {
			fake.traceExports++;
			done({ code: 0 });
		}
	},
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-proto", () => ({
	OTLPMetricExporter: class {
		constructor() {
			fake.metricExporter = this;
		}
		export(_data: unknown, done: (result: { code: number }) => void) {
			fake.metricExports++;
			done({ code: 0 });
		}
	},
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
	BasicTracerProvider: class {
		getTracer() {
			return { startSpan: () => ({ end() {} }) };
		}
		shutdown() {
			return new Promise<void>((resolve, reject) => {
				fake.resolveTrace = resolve;
				fake.rejectTrace = reject;
			});
		}
	},
	BatchSpanProcessor: class {},
}));

vi.mock("@opentelemetry/sdk-metrics", () => ({
	MeterProvider: class {
		getMeter() {
			return {
				createCounter: () => ({ add() {} }),
				createHistogram: () => ({ record() {} }),
			};
		}
		shutdown() {
			return new Promise<void>((resolve) => {
				fake.resolveMetric = resolve;
			});
		}
	},
	PeriodicExportingMetricReader: class {},
}));

afterEach(() => {
	fake.resolveTrace?.();
	fake.resolveMetric?.();
	vi.useRealTimers();
});

it("keeps timed-out shutdown visible and blocks later exports", async () => {
	vi.useFakeTimers();
	const telemetry = startObservability({
		service: "platform-api",
		otlpEndpoint: "http://127.0.0.1:4318/",
		output: new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		}),
	});
	const closing = telemetry.close();
	await vi.advanceTimersByTimeAsync(5000);
	await closing;
	expect(telemetry.status()).toMatchObject({
		state: "closing",
		exportFailures: 1,
	});
	let traceResult: { code: number } | undefined;
	let metricResult: { code: number } | undefined;
	fake.traceExporter?.export([], (result) => {
		traceResult = result;
	});
	fake.metricExporter?.export([], (result) => {
		metricResult = result;
	});
	expect(fake.traceExports).toBe(0);
	expect(fake.metricExports).toBe(0);
	expect(traceResult?.code).toBe(ExportResultCode.FAILED);
	expect(metricResult?.code).toBe(ExportResultCode.FAILED);
	fake.resolveTrace?.();
	fake.resolveMetric?.();
	await vi.advanceTimersByTimeAsync(0);
	expect(telemetry.status().state).toBe("closed");
});

it("waits for both providers after one shutdown fails", async () => {
	const telemetry = startObservability({
		service: "platform-api",
		otlpEndpoint: "http://127.0.0.1:4318/",
		output: new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		}),
	});
	const closing = telemetry.close();
	await Promise.resolve();
	await Promise.resolve();
	fake.rejectTrace?.(new Error("PRIVATE_SENTINEL"));
	await Promise.resolve();
	expect(telemetry.status().state).toBe("closing");
	fake.resolveMetric?.();
	await closing;
	expect(telemetry.status()).toMatchObject({
		state: "closed",
		exportFailures: 1,
	});
});
