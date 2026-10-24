import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { startObservability } from "./index.js";

const active: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(active.splice(0).map((item) => item.close()));
});

it("bounds token fields without logging usage metadata or reading it after close", async () => {
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
	for (const value of [
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	])
		telemetry.recordModelUsage({ inputTokens: value });
	telemetry.recordModelUsage({
		inputTokens: 0,
		outputTokens: 2,
		secret: "PRIVATE_SENTINEL",
	} as Parameters<typeof telemetry.recordModelUsage>[0]);
	expect(telemetry.status()).toMatchObject({
		invalidRecords: 5,
		captureFailures: 0,
	});
	expect(lines).toEqual([]);
	await telemetry.close();
	telemetry.recordModelUsage(
		Object.defineProperty({}, "inputTokens", {
			get() {
				throw new Error("PRIVATE_SENTINEL");
			},
		}),
	);
	expect(telemetry.status()).toMatchObject({
		invalidRecords: 5,
		captureFailures: 0,
	});
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

it("logs a bounded stage duration for latency comparison (#1525)", () => {
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
		stage: "result_persist",
		outcome: "completed",
		durationMs: 12.6,
	});
	telemetry.record({ stage: "result_persist", outcome: "completed" });
	expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
		stage: "result_persist",
		durationMs: 13,
	});
	expect(JSON.parse(lines[1] ?? "{}")).not.toHaveProperty("durationMs");
});

it("keeps the bounded Session Sandbox workload failure steps (#2733)", () => {
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
	for (const failureStep of [
		"workload.policy",
		"workload.conflict",
		"workload.unavailable",
		"workload.sandbox-secret-name",
	])
		telemetry.record({
			stage: "workload",
			outcome: "failed",
			code: "WORKLOAD_RECONCILIATION_FAILED",
			failureStep,
			errorClass: "WorkloadKubernetesError",
		});
	const steps = lines.map((line) => JSON.parse(line).failureStep);
	expect(steps).toEqual([
		"workload.policy",
		"workload.conflict",
		"workload.unavailable",
		undefined,
	]);
});

it("keeps only the fixed Session Sandbox claim wait steps (#3089)", () => {
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
	const known = [
		"sandbox.intent_mismatch",
		"sandbox.lifecycle_stale",
		"sandbox.authorization_changed",
		"sandbox.agent_not_running",
		"sandbox.workload_not_ready",
		"sandbox.configuration_pending",
		"sandbox.capacity_mismatch",
		"sandbox.lease_ineligible",
		"sandbox.policy_changed",
	];
	for (const failureStep of [...known, "sandbox.conversation-secret-id"])
		telemetry.record({
			stage: "workload",
			outcome: "waiting",
			code: "WORKLOAD_UNAVAILABLE",
			failureStep,
		});
	const steps = lines.map((line) => JSON.parse(line).failureStep);
	expect(steps).toEqual([...known, undefined]);
	expect(lines.join("")).not.toContain("conversation-secret-id");
});

it("keeps only the fixed Runtime file exchange denial steps (#3307)", () => {
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
	const known = [
		"file_exchange.grant",
		"file_exchange.service_identity",
		"file_exchange.credential_scope",
		"file_exchange.conversation",
		"file_exchange.execution",
		"file_exchange.delivery_fence",
		"file_exchange.task_authorization",
		"file_exchange.boundary",
		"file_exchange.authorize",
		"file_exchange.limits",
		"file_exchange.file",
		"file_exchange.store",
	];
	// 调用方拼出的步骤（例如带上 token 或对象引用）不在固定集合内，必须被丢弃。
	for (const failureStep of [...known, "file_exchange.sk-private-token"])
		telemetry.record({
			stage: "http",
			outcome: "rejected",
			status: 404,
			failureStep,
		} as Parameters<typeof telemetry.record>[0]);
	const steps = lines.map((line) => JSON.parse(line).failureStep);
	expect(steps).toEqual([...known, undefined]);
	expect(lines.join("")).not.toContain("sk-private-token");
});

it("accepts waiting as a non-error operational outcome", () => {
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
	telemetry.record({ stage: "task_dispatch", outcome: "waiting" });
	expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
		stage: "task_dispatch",
		outcome: "waiting",
	});
	expect(telemetry.status().invalidRecords).toBe(0);
});

it("writes the service key once per operation log line (#2306)", () => {
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
	telemetry.record({ stage: "result_persist", outcome: "completed" });
	telemetry.record({ stage: "worker", outcome: "failed", durationMs: 5 });
	expect(lines).toHaveLength(2);
	for (const line of lines) {
		// JSON.parse 会静默保留最后一个重复键，所以直接数原始行中的键。
		expect(line.match(/"service":/g)).toHaveLength(1);
		expect(JSON.parse(line)).toMatchObject({ service: "platform-worker" });
	}
});

it("emits Browser categories as bounded telemetry metadata", () => {
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
		stage: "browser",
		outcome: "failed",
		browserCategory: "policy_rejection",
	});
	telemetry.record({
		stage: "http",
		outcome: "failed",
		browserCategory: "policy_rejection",
	} as Parameters<typeof telemetry.record>[0]);
	expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
		stage: "browser",
		browserCategory: "policy_rejection",
	});
	expect(telemetry.status().invalidRecords).toBe(1);
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

it("records bounded Sandbox lifecycle identity and retry facts", () => {
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
		stage: "workload",
		outcome: "failed",
		failureStep: "runtime.configuration",
		sandboxId: "123e4567-e89b-42d3-a456-426614174000",
		sandboxResourceUid: "123e4567-e89b-42d3-a456-426614174001",
		sourceRevision: 3,
		desiredRevision: 4,
		configurationRevision: 7,
		imageDigest: `sha256:${"a".repeat(64)}`,
		backoffMs: 60_000,
	});
	expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
		failureStep: "runtime.configuration",
		sandboxId: "123e4567-e89b-42d3-a456-426614174000",
		sandboxResourceUid: "123e4567-e89b-42d3-a456-426614174001",
		sourceRevision: 3,
		desiredRevision: 4,
		configurationRevision: 7,
		imageDigest: `sha256:${"a".repeat(64)}`,
		backoffMs: 60_000,
	});
	telemetry.record({
		stage: "workload",
		outcome: "failed",
		imageDigest: "PRIVATE_SENTINEL",
	});
	expect(telemetry.status().invalidRecords).toBe(1);
	expect(lines.join("")).not.toContain("PRIVATE_SENTINEL");
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

it("accepts a bounded HTTP status and protocol code only on the http stage (#2569)", () => {
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
		outcome: "failed",
		status: 503,
		protocolCode: "DEPENDENCY_UNAVAILABLE",
	});
	for (const status of [99, 600, 503.5, Number.NaN, "503" as unknown as number])
		telemetry.record({ stage: "http", outcome: "failed", status });
	for (const protocolCode of [
		"lowercase",
		"HAS SPACE",
		"X",
		"A".repeat(65),
		"PRIVATE\nSENTINEL",
	])
		telemetry.record({ stage: "http", outcome: "failed", protocolCode });
	telemetry.record({
		stage: "worker",
		outcome: "failed",
		status: 503,
		protocolCode: "DEPENDENCY_UNAVAILABLE",
	});
	expect(lines).toHaveLength(12);
	expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
		status: 503,
		protocolCode: "DEPENDENCY_UNAVAILABLE",
	});
	for (const line of lines.slice(1)) {
		expect(JSON.parse(line)).not.toHaveProperty("status");
		expect(JSON.parse(line)).not.toHaveProperty("protocolCode");
		expect(line).not.toContain("PRIVATE");
	}
	expect(telemetry.status().invalidRecords).toBe(0);
});

it("keeps a bounded Runtime error code on the runtime stage without an HTTP status (#3276)", () => {
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
		stage: "runtime",
		outcome: "failed",
		status: 503,
		protocolCode: "RUNTIME_CODEX_UNAVAILABLE",
	});
	telemetry.record({
		stage: "runtime",
		outcome: "failed",
		protocolCode: "PRIVATE\nSENTINEL",
	});
	expect(lines).toHaveLength(2);
	expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
		stage: "runtime",
		protocolCode: "RUNTIME_CODEX_UNAVAILABLE",
	});
	expect(JSON.parse(lines[0] ?? "{}")).not.toHaveProperty("status");
	expect(JSON.parse(lines[1] ?? "{}")).not.toHaveProperty("protocolCode");
	expect(lines[1]).not.toContain("PRIVATE");
});
