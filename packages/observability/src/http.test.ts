import { Hono } from "hono";
import { expect, it } from "vitest";
import { createHttpObservability, currentRequestMetadata } from "./http.js";
import type { OperationalEvent } from "./index.js";

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
