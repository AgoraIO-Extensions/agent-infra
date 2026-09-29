import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { startObservability } from "./index.js";

const active: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(active.splice(0).map((item) => item.close()));
});

it("emits only bounded metadata and drops logs under backpressure", () => {
	const lines: string[] = [];
	const output = new Writable({
		highWaterMark: 1,
		write(chunk) {
			lines.push(String(chunk));
			// Hold the first write to simulate a stalled log collector.
		},
	});
	const telemetry = startObservability({ service: "platform-api", output });
	active.push(telemetry);
	telemetry.record({
		stage: "http",
		outcome: "completed",
		requestId: "sk-secret-token",
		executionId: "123e4567-e89b-42d3-a456-426614174000",
		code: "SECRET_TOKEN" as "RUNTIME_UNAVAILABLE",
		// The runtime entry point must ignore extra caller fields too.
		message: "PRIVATE_SENTINEL",
	} as Parameters<typeof telemetry.record>[0]);
	telemetry.record({ stage: "http", outcome: "failed" });
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain('"stage":"http"');
	expect(lines[0]).toContain(
		'"executionId":"123e4567-e89b-42d3-a456-426614174000"',
	);
	expect(lines[0]).not.toMatch(/secret-token|SECRET_TOKEN|PRIVATE_SENTINEL/);
	expect(telemetry.status()).toEqual({
		enabled: false,
		state: "active",
		captureFailures: 0,
		exportFailures: 0,
		lastExportFailureAt: undefined,
		droppedLogs: 1,
		invalidRecords: 0,
	});
});

it("keeps the validated service label after caller options change", () => {
	const lines: string[] = [];
	const options = {
		service: "platform-api",
		output: new Writable({
			write(chunk, _encoding, done) {
				lines.push(String(chunk));
				done();
			},
		}),
	};
	const telemetry = startObservability(
		options as Parameters<typeof startObservability>[0],
	);
	active.push(telemetry);
	options.service = "PRIVATE_SENTINEL";
	telemetry.record({ stage: "http", outcome: "completed" });
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain('"service":"platform-api"');
	expect(lines[0]).not.toContain("PRIVATE_SENTINEL");
});

it("bounds resource snapshots and stops reading them after close", async () => {
	const lines: string[] = [];
	const telemetry = startObservability({
		service: "platform-api",
		output: new Writable({
			write(chunk, _encoding, done) {
				lines.push(String(chunk));
				done();
			},
		}),
	});
	active.push(telemetry);
	const observe = telemetry.observeResource;
	observe({ kind: "task_waiting", value: -1 });
	observe({ kind: "task_waiting", value: 1.5 });
	observe({ kind: "task_waiting", value: Number.POSITIVE_INFINITY });
	observe({ kind: "task_waiting", value: Number.MAX_SAFE_INTEGER + 1 });
	observe({ kind: "PRIVATE_SENTINEL", value: 1 } as unknown as Parameters<
		typeof observe
	>[0]);
	observe(
		Object.defineProperty({ kind: "task_waiting" }, "value", {
			get() {
				throw new Error("PRIVATE_SENTINEL");
			},
		}) as Parameters<typeof observe>[0],
	);
	observe({
		kind: "task_waiting",
		value: 2,
		secret: "PRIVATE_SENTINEL",
	} as Parameters<typeof observe>[0]);
	expect(telemetry.status()).toMatchObject({
		enabled: false,
		invalidRecords: 5,
		captureFailures: 1,
	});
	expect(lines).toHaveLength(0);
	await telemetry.close();
	observe(
		Object.defineProperty({}, "kind", {
			get() {
				throw new Error("PRIVATE_SENTINEL");
			},
		}) as Parameters<typeof observe>[0],
	);
	expect(telemetry.status()).toMatchObject({
		state: "closed",
		invalidRecords: 5,
		captureFailures: 1,
	});
});

it("reports shutdown and ignores records once close begins", async () => {
	const lines: string[] = [];
	const output = new Writable({
		write(chunk, _encoding, done) {
			lines.push(String(chunk));
			done();
		},
	});
	const telemetry = startObservability({ service: "platform-api", output });
	active.push(telemetry);
	telemetry.record({ stage: "http", outcome: "completed" });
	const closing = telemetry.close();
	expect(telemetry.status().state).toBe("closing");
	const inaccessible = Object.defineProperty({}, "stage", {
		get() {
			throw new Error("PRIVATE_SENTINEL");
		},
	}) as Parameters<typeof telemetry.record>[0];
	expect(() => telemetry.record(inaccessible)).not.toThrow();
	await closing;
	expect(telemetry.status()).toMatchObject({
		state: "closed",
		captureFailures: 0,
		droppedLogs: 1,
	});
	expect(lines).toHaveLength(1);
	telemetry.record({ stage: "http", outcome: "completed" });
	expect(telemetry.status().droppedLogs).toBe(2);
	expect(lines).toHaveLength(1);
});

it("contains asynchronous log destination errors", async () => {
	const output = new Writable({
		write(_chunk, _encoding, done) {
			setImmediate(() => done(new Error("PRIVATE_SENTINEL")));
		},
	});
	const telemetry = startObservability({ service: "platform-api", output });
	active.push(telemetry);
	telemetry.record({ stage: "http", outcome: "completed" });
	await new Promise((resolve) => output.once("error", resolve));
	telemetry.record({ stage: "http", outcome: "failed" });
	expect(telemetry.status().droppedLogs).toBe(2);
});

it("removes output listeners on close before reusing the destination", async () => {
	const output = new Writable({
		write(_chunk, _encoding, done) {
			done();
		},
	});
	const first = startObservability({ service: "platform-api", output });
	active.push(first);
	expect(output.listenerCount("error")).toBe(1);
	await first.close();
	expect(output.listenerCount("error")).toBe(0);
	const second = startObservability({ service: "platform-api", output });
	active.push(second);
	expect(output.listenerCount("error")).toBe(1);
	output.emit("error", new Error("PRIVATE_SENTINEL"));
	expect(first.status().droppedLogs).toBe(0);
	expect(second.status().droppedLogs).toBe(1);
	await second.close();
	expect(output.listenerCount("error")).toBe(0);
	expect(() =>
		second.record({ stage: "http", outcome: "completed" }),
	).not.toThrow();
	expect(second.status().droppedLogs).toBe(2);
});

it("handles an asynchronous output error after close while a write is pending", async () => {
	let finishWrite: ((error?: Error | null) => void) | undefined;
	const output = new Writable({
		write(_chunk, _encoding, done) {
			finishWrite = done;
		},
	});
	const telemetry = startObservability({ service: "platform-api", output });
	active.push(telemetry);
	telemetry.record({ stage: "http", outcome: "completed" });
	expect(finishWrite).toBeDefined();
	await telemetry.close();
	expect(output.listenerCount("error")).toBe(1);
	finishWrite?.(new Error("PRIVATE_SENTINEL"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(telemetry.status().droppedLogs).toBe(1);
	expect(output.listenerCount("error")).toBe(0);
});

it("keeps the error listener until a delayed write error arrives after close", async () => {
	let finishWrite: ((error?: Error | null) => void) | undefined;
	const output = Object.assign(new EventEmitter(), {
		write(_line: string, done: (error?: Error | null) => void) {
			finishWrite = done;
			return true;
		},
	}) as unknown as Writable;
	const telemetry = startObservability({ service: "platform-api", output });
	active.push(telemetry);
	telemetry.record({ stage: "http", outcome: "completed" });
	await telemetry.close();
	finishWrite?.(new Error("PRIVATE_SENTINEL"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(output.listenerCount("error")).toBe(1);
	output.emit("error", new Error("PRIVATE_SENTINEL"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(telemetry.status().droppedLogs).toBe(1);
	expect(output.listenerCount("error")).toBe(0);
});

it("releases the listener when the write error precedes its callback", async () => {
	let finishWrite: ((error?: Error | null) => void) | undefined;
	const output = Object.assign(new EventEmitter(), {
		write(_line: string, done: (error?: Error | null) => void) {
			finishWrite = done;
			return true;
		},
	}) as unknown as Writable;
	const telemetry = startObservability({ service: "platform-api", output });
	active.push(telemetry);
	telemetry.record({ stage: "http", outcome: "completed" });
	await telemetry.close();
	output.emit("error", new Error("PRIVATE_SENTINEL"));
	finishWrite?.(new Error("PRIVATE_SENTINEL"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(telemetry.status().droppedLogs).toBe(1);
	expect(output.listenerCount("error")).toBe(0);
});

it("keeps malformed operation references out of logs", () => {
	const lines: string[] = [];
	const telemetry = startObservability({
		service: "platform-worker",
		output: new Writable({
			write(chunk, _encoding, done) {
				lines.push(String(chunk));
				done();
			},
		}),
	});
	active.push(telemetry);
	telemetry.record({
		stage: "model",
		outcome: "completed",
		operationRef: "PRIVATE_SENTINEL\n",
		attemptRef: "a".repeat(129),
	});
	expect(lines).toHaveLength(1);
	expect(lines[0]).not.toContain("PRIVATE_SENTINEL");
	expect(lines[0]).not.toContain("attemptRef");
});

it("keeps invalid observational input out of business control flow", () => {
	const telemetry = startObservability({
		service: "platform-api",
		output: new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		}),
	});
	active.push(telemetry);
	expect(() =>
		telemetry.record({
			stage: "http",
			outcome: "completed",
			durationMs: Number.POSITIVE_INFINITY,
		}),
	).not.toThrow();
	expect(telemetry.status().invalidRecords).toBe(1);
});

it("contains capture failures and reports them independently", () => {
	const telemetry = startObservability({
		service: "platform-api",
		output: new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		}),
	});
	active.push(telemetry);
	const event = Object.defineProperty({}, "stage", {
		get() {
			throw new Error("PRIVATE_SENTINEL");
		},
	}) as Parameters<typeof telemetry.record>[0];
	expect(() => telemetry.record(event)).not.toThrow();
	expect(telemetry.status()).toMatchObject({
		captureFailures: 1,
		invalidRecords: 0,
	});
});

it("uses one validated snapshot of observational input", () => {
	const lines: string[] = [];
	const telemetry = startObservability({
		service: "platform-api",
		output: new Writable({
			write(chunk, _encoding, done) {
				lines.push(String(chunk));
				done();
			},
		}),
	});
	active.push(telemetry);
	let stageReads = 0;
	let requestIdReads = 0;
	const event = {
		get stage() {
			return ++stageReads === 1 ? "http" : "PRIVATE_SENTINEL";
		},
		outcome: "completed",
		get requestId() {
			return ++requestIdReads === 1
				? "123e4567-e89b-42d3-a456-426614174000"
				: "PRIVATE_SENTINEL";
		},
	} as Parameters<typeof telemetry.record>[0];
	telemetry.record(event);
	expect(stageReads).toBe(1);
	expect(requestIdReads).toBe(1);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain('"stage":"http"');
	expect(lines[0]).toContain(
		'"requestId":"123e4567-e89b-42d3-a456-426614174000"',
	);
	expect(lines[0]).not.toContain("PRIVATE_SENTINEL");
});

it("rejects objects that coerce to a valid correlation ID", () => {
	const lines: string[] = [];
	const telemetry = startObservability({
		service: "platform-api",
		output: new Writable({
			write(chunk, _encoding, done) {
				lines.push(String(chunk));
				done();
			},
		}),
	});
	active.push(telemetry);
	telemetry.record({
		stage: "http",
		outcome: "completed",
		requestId: {
			secret: "PRIVATE_SENTINEL",
			toString: () => "123e4567-e89b-42d3-a456-426614174000",
		} as unknown as string,
	});
	expect(lines).toHaveLength(1);
	expect(lines[0]).not.toContain("PRIVATE_SENTINEL");
	expect(lines[0]).not.toContain("requestId");
});

it("reports OTLP failures without failing an observed operation", async () => {
	const output = new Writable({
		write(_chunk, _encoding, done) {
			done();
		},
	});
	const telemetry = startObservability({
		service: "platform-worker",
		otlpEndpoint: "http://127.0.0.1:1/",
		metricIntervalMs: 1000,
		output,
	});
	active.push(telemetry);
	expect(() =>
		telemetry.record({
			stage: "worker",
			outcome: "failed",
			code: "RUNTIME_UNAVAILABLE",
			executionId: "execution-1",
			durationMs: 12,
		}),
	).not.toThrow();
	const deadline = Date.now() + 5000;
	while (telemetry.status().exportFailures === 0 && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 100));
	expect(telemetry.status().enabled).toBe(true);
	expect(telemetry.status().exportFailures).toBeGreaterThan(0);
	expect(telemetry.status().lastExportFailureAt).toMatch(/^\d{4}-/);
}, 10_000);

it("rejects credential-bearing exporter URLs", () => {
	expect(() =>
		startObservability({
			service: "platform-api",
			otlpEndpoint: "https://user:secret@collector.example/",
		}),
	).toThrow("Invalid observability endpoint");
	expect(() =>
		startObservability({ service: "platform-api", otlpEndpoint: "" }),
	).toThrow("Invalid observability endpoint");
});

it("redacts malformed exporter URLs from thrown errors", () => {
	const endpoint = "https://user:PRIVATE_SENTINEL@";
	let failure: unknown;
	try {
		startObservability({ service: "platform-api", otlpEndpoint: endpoint });
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(TypeError);
	expect((failure as Error).message).toBe("Invalid observability endpoint");
	expect(JSON.stringify(failure)).not.toContain("PRIVATE_SENTINEL");
});

it("rejects an unbounded service metric label at runtime", () => {
	expect(() =>
		startObservability({ service: "platform-api:private" as "platform-api" }),
	).toThrow("Invalid observability service");
});
