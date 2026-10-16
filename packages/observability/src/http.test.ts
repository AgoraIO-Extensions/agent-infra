import { Writable } from "node:stream";
import { Hono } from "hono";
import { expect, it } from "vitest";
import {
	createHttpObservability,
	currentRequestMetadata,
	recordHttpFailureContext,
} from "./http.js";
import {
	isTraceParent,
	type OperationalEvent,
	startObservability,
} from "./index.js";

it("keeps platform correlation stable within a request and ignores external headers", async () => {
	const events: OperationalEvent[] = [];
	const app = new Hono();
	app.use(
		"*",
		createHttpObservability({ record: (event) => events.push(event) }),
	);
	app.get("/request", async (context) => {
		const before = currentRequestMetadata();
		await Promise.resolve();
		expect(currentRequestMetadata()).toEqual(before);
		return context.json(before);
	});
	const response = await app.request("/request?PRIVATE_SENTINEL", {
		headers: {
			"X-Request-Id": "123e4567-e89b-42d3-a456-426614174000",
			"X-Trace-Id": "123e4567-e89b-42d3-a456-426614174001",
			Authorization: "Bearer PRIVATE_SENTINEL",
		},
	});
	const metadata = (await response.json()) as NonNullable<
		ReturnType<typeof currentRequestMetadata>
	>;
	expect(metadata).toEqual({
		requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
		traceId: expect.stringMatching(/^[a-f0-9-]{36}$/),
	});
	expect(metadata.requestId).not.toBe("123e4567-e89b-42d3-a456-426614174000");
	expect(metadata.traceId).not.toBe("123e4567-e89b-42d3-a456-426614174001");
	expect(events).toEqual([
		{
			stage: "http",
			outcome: "completed",
			durationMs: expect.any(Number),
			...metadata,
		},
	]);
	expect(JSON.stringify(events)).not.toContain("PRIVATE_SENTINEL");
	expect(currentRequestMetadata()).toBeUndefined();
});

it("creates a server-owned W3C context without exposing it in the response object", async () => {
	const output = new Writable({
		write(_chunk, _encoding, done) {
			done();
		},
	});
	const telemetry = startObservability({ service: "platform-api", output });
	const events: OperationalEvent[] = [];
	const app = new Hono();
	app.use(
		"*",
		createHttpObservability({
			...telemetry,
			record: (event) => events.push(event),
		}),
	);
	app.get("/context", (context) => {
		const metadata = currentRequestMetadata();
		expect(metadata?.traceParent).toBeDefined();
		expect(isTraceParent(metadata?.traceParent)).toBe(true);
		return context.json({
			requestId: metadata?.requestId,
			traceId: metadata?.traceId,
		});
	});
	const response = await app.request("/context");
	expect(await response.json()).not.toHaveProperty("traceParent");
	expect(isTraceParent(events[0]?.traceParent)).toBe(true);
	await telemetry.close();
});

it("isolates concurrent requests across awaits", async () => {
	const events: OperationalEvent[] = [];
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let waiting = 0;
	const app = new Hono();
	app.use(
		"*",
		createHttpObservability({ record: (event) => events.push(event) }),
	);
	app.get("/request", async (context) => {
		const metadata = currentRequestMetadata();
		if (++waiting === 2) entered.resolve();
		await release.promise;
		expect(currentRequestMetadata()).toEqual(metadata);
		return context.json(metadata);
	});
	const first = app.request("/request");
	const second = app.request("/request");
	await entered.promise;
	expect(events).toEqual([]);
	release.resolve();
	const [firstResponse, secondResponse] = await Promise.all([first, second]);
	const firstMetadata = (await firstResponse.json()) as NonNullable<
		ReturnType<typeof currentRequestMetadata>
	>;
	const secondMetadata = (await secondResponse.json()) as NonNullable<
		ReturnType<typeof currentRequestMetadata>
	>;
	expect(firstMetadata.requestId).not.toBe(secondMetadata.requestId);
	expect(firstMetadata.traceId).not.toBe(secondMetadata.traceId);
	expect(events).toHaveLength(2);
	expect(events).toEqual(
		expect.arrayContaining([
			expect.objectContaining(firstMetadata),
			expect.objectContaining(secondMetadata),
		]),
	);
	expect(currentRequestMetadata()).toBeUndefined();
});

it.each([
	{ status: 200, outcome: "completed" },
	{ status: 403, outcome: "rejected" },
	{ status: 503, outcome: "failed" },
])(
	"records a $status response once despite capture failure",
	async ({ status, outcome }) => {
		const events: OperationalEvent[] = [];
		const app = new Hono();
		app.use(
			"*",
			createHttpObservability({
				record(event) {
					events.push(event);
					throw new Error("PRIVATE_CAPTURE_SENTINEL");
				},
			}),
		);
		app.get("/request", () => new Response("original response", { status }));
		const response = await app.request("/request");
		expect(response.status).toBe(status);
		expect(await response.text()).toBe("original response");
		expect(events).toEqual([
			{
				stage: "http",
				outcome,
				durationMs: expect.any(Number),
				// 被拒绝或失败的请求带上状态码和路由模板（#2569）；完成的请求保持不变。
				...(outcome === "completed"
					? {}
					: { status, operationRef: "GET.request" }),
				requestId: expect.any(String),
				traceId: expect.any(String),
			},
		]);
		expect(JSON.stringify(events)).not.toContain("SENTINEL");
	},
);

it("preserves the original exception through the application error handler", async () => {
	const failure = new Error("PRIVATE_BUSINESS_SENTINEL");
	const events: OperationalEvent[] = [];
	let handled: Error | undefined;
	const app = new Hono();
	app.onError((error, context) => {
		handled = error;
		return context.text("original failure response", 503);
	});
	app.use(
		"*",
		createHttpObservability({
			record(event) {
				events.push(event);
				throw new Error("PRIVATE_CAPTURE_SENTINEL");
			},
		}),
	);
	app.get("/request", () => {
		throw failure;
	});
	const response = await app.request("/request");
	expect(handled).toBe(failure);
	expect(response.status).toBe(503);
	expect(await response.text()).toBe("original failure response");
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ stage: "http", outcome: "failed" });
	expect(JSON.stringify(events)).not.toContain("SENTINEL");
	expect(currentRequestMetadata()).toBeUndefined();
});

it("expires request context after headers and does not observe a streaming body", async () => {
	const events: OperationalEvent[] = [];
	const release = Promise.withResolvers<void>();
	const background = Promise.withResolvers<void>();
	const app = new Hono();
	app.use(
		"*",
		createHttpObservability({ record: (event) => events.push(event) }),
	);
	app.get("/stream", () => {
		expect(currentRequestMetadata()).toBeDefined();
		const body = new ReadableStream({
			async start(controller) {
				await release.promise;
				expect(currentRequestMetadata()).toBeUndefined();
				controller.enqueue(new TextEncoder().encode("PRIVATE_BODY_SENTINEL"));
				controller.close();
				background.resolve();
			},
		});
		return new Response(body);
	});
	const response = await app.request("/stream");
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ stage: "http", outcome: "completed" });
	release.resolve();
	await background.promise;
	expect(await response.text()).toBe("PRIVATE_BODY_SENTINEL");
	expect(events).toHaveLength(1);
	expect(JSON.stringify(events)).not.toContain("SENTINEL");
	expect(currentRequestMetadata()).toBeUndefined();
});

const failureBody = (code: string, message = "PRIVATE_BODY_SENTINEL") => ({
	schemaVersion: 1,
	code,
	message,
	retryable: true,
	traceId: "trace",
});

function observed() {
	const events: OperationalEvent[] = [];
	const app = new Hono();
	app.use(
		"*",
		createHttpObservability({ record: (event) => events.push(event) }),
	);
	return { app, events };
}

it("records a bounded failure step and SQLSTATE without private error details", async () => {
	const { app, events } = observed();
	app.get("/failure", (context) => {
		recordHttpFailureContext({
			failureStep: "store.management_transaction",
			error: Object.assign(new Error("PRIVATE_SQL_AND_PARAMS"), {
				code: "40P01",
			}),
		});
		recordHttpFailureContext({
			failureStep: "projection.read",
			error: new TypeError("PRIVATE_OUTER_ERROR"),
		});
		return context.json({ code: "DEPENDENCY_UNAVAILABLE" }, 503);
	});
	const response = await app.request("/failure");
	expect(response.status).toBe(503);
	expect(events[0]).toMatchObject({
		failureStep: "store.management_transaction",
		errorClass: "Error",
		sqlState: "40P01",
	});
	expect(JSON.stringify(events)).not.toContain("PRIVATE_SQL_AND_PARAMS");
});

it("records the route template, status and protocol code of a failed request without identifiers (#2569)", async () => {
	const { app, events } = observed();
	app.post("/api/v2/agents/:agentId/lifecycle", (context) =>
		context.json(failureBody("DEPENDENCY_UNAVAILABLE"), 503),
	);
	const response = await app.request(
		"/api/v2/agents/agent_PRIVATE_ID/lifecycle?token=PRIVATE_QUERY",
		{
			method: "POST",
			headers: { Authorization: "Bearer PRIVATE_TOKEN" },
			body: "PRIVATE_REQUEST_BODY",
		},
	);
	expect(response.status).toBe(503);
	// 读取协议错误码不能消耗客户端要读的响应正文。
	expect(await response.json()).toMatchObject({
		code: "DEPENDENCY_UNAVAILABLE",
		message: "PRIVATE_BODY_SENTINEL",
	});
	expect(events).toEqual([
		{
			stage: "http",
			outcome: "failed",
			durationMs: expect.any(Number),
			status: 503,
			operationRef: "POST.api.v2.agents.:agentId.lifecycle",
			protocolCode: "DEPENDENCY_UNAVAILABLE",
			requestId: expect.any(String),
			traceId: expect.any(String),
		},
	]);
	const text = JSON.stringify(events);
	for (const secret of [
		"PRIVATE_ID",
		"PRIVATE_QUERY",
		"PRIVATE_TOKEN",
		"PRIVATE_REQUEST_BODY",
		"PRIVATE_BODY_SENTINEL",
	])
		expect(text).not.toContain(secret);
});

it("records a rejected request the same way and leaves completed requests untouched (#2569)", async () => {
	const { app, events } = observed();
	app.get("/api/v2/conversations/:conversationId", (context) =>
		context.json(failureBody("RESOURCE_UNAVAILABLE"), 404),
	);
	app.get("/ok", (context) => context.json({ ok: true }));
	await app.request("/api/v2/conversations/conversation-PRIVATE");
	await app.request("/ok");
	expect(events[0]).toMatchObject({
		outcome: "rejected",
		status: 404,
		operationRef: "GET.api.v2.conversations.:conversationId",
		protocolCode: "RESOURCE_UNAVAILABLE",
	});
	expect(events[1]).toEqual({
		stage: "http",
		outcome: "completed",
		durationMs: expect.any(Number),
		requestId: expect.any(String),
		traceId: expect.any(String),
	});
});

it("names an unmatched request without its path and ignores bodies that are not protocol errors (#2569)", async () => {
	const { app, events } = observed();
	app.get("/text", (context) => context.text("PRIVATE_TEXT_SENTINEL", 500));
	app.get("/loose", (context) =>
		context.json({ code: "private failure text" }, 500),
	);
	app.get("/large", (context) =>
		context.json(
			{ code: "DEPENDENCY_UNAVAILABLE", pad: "x".repeat(5_000) },
			503,
		),
	);
	await app.request("/missing/PRIVATE_PATH_SENTINEL");
	await app.request("/text");
	await app.request("/loose");
	await app.request("/large");
	expect(
		events.map(({ operationRef, status, protocolCode }) => ({
			operationRef,
			status,
			protocolCode,
		})),
	).toEqual([
		{ operationRef: "GET.unmatched", status: 404, protocolCode: undefined },
		{ operationRef: "GET.text", status: 500, protocolCode: undefined },
		{ operationRef: "GET.loose", status: 500, protocolCode: undefined },
		{ operationRef: "GET.large", status: 503, protocolCode: undefined },
	]);
	expect(JSON.stringify(events)).not.toMatch(/PRIVATE_/);
});

it("stops reading a large JSON error body without a length instead of buffering it (#2569)", async () => {
	const { app, events } = observed();
	let pulled = 0;
	app.get("/endless", () => {
		const chunk = new TextEncoder().encode(`${"x".repeat(1_023)}\n`);
		return new Response(
			new ReadableStream({
				pull(controller) {
					pulled += 1;
					controller.enqueue(chunk);
					// 有限的 2 MiB：回归成「读完整个正文」时用例清晰失败，而不是卡住。
					if (pulled >= 2_048) controller.close();
				},
			}),
			{ status: 503, headers: { "content-type": "application/json" } },
		);
	});
	const response = await app.request("/endless");
	expect(response.status).toBe(503);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		outcome: "failed",
		status: 503,
		operationRef: "GET.endless",
	});
	expect(events[0]?.protocolCode).toBeUndefined();
	// 4 KiB 上限加上 tee 的预取，远小于「读完整个流」。
	expect(pulled).toBeLessThan(32);
	await response.body?.cancel();
});

it("does not wait for a JSON error body that never arrives (#2569)", async () => {
	const { app, events } = observed();
	app.get("/stalled", () => {
		return new Response(new ReadableStream({ start() {} }), {
			status: 502,
			headers: { "content-type": "application/json" },
		});
	});
	const began = performance.now();
	const response = await app.request("/stalled");
	const waited = performance.now() - began;
	expect(response.status).toBe(502);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		outcome: "failed",
		status: 502,
		operationRef: "GET.stalled",
	});
	expect(events[0]?.protocolCode).toBeUndefined();
	expect(waited).toBeLessThan(2_000);
	await response.body?.cancel();
});

it("keeps the failure fields in the structured log line and out of metric labels (#2569)", async () => {
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
	const app = new Hono();
	app.use("*", createHttpObservability(telemetry));
	app.post("/api/v2/agents/:agentId/lifecycle", (context) =>
		context.json(failureBody("DEPENDENCY_UNAVAILABLE"), 503),
	);
	await app.request("/api/v2/agents/agent_PRIVATE_ID/lifecycle", {
		method: "POST",
	});
	expect(lines).toHaveLength(1);
	expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
		level: 50,
		stage: "http",
		outcome: "failed",
		status: 503,
		protocolCode: "DEPENDENCY_UNAVAILABLE",
		operationRef: "POST.api.v2.agents.:agentId.lifecycle",
	});
	expect(lines[0]).not.toContain("PRIVATE_");
	expect(telemetry.status().invalidRecords).toBe(0);
	await telemetry.close();
});
