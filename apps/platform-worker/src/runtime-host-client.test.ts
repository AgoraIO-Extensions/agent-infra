import type { ExecutionGrantV1 } from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";

import { createWorkerRuntimeHostClientV1 } from "./runtime-host-client.js";

const grant: ExecutionGrantV1 = {
	schemaVersion: 1,
	format: "compact-jws",
	token: "header.payload.signature",
};

function request(
	operation: "turn.submit" | "turn.supplement" | "turn.stop" = "turn.submit",
) {
	return {
		schemaVersion: 1 as const,
		operation,
		requestId: "request-client",
		traceId: "trace-client",
		agentId: "agent-client",
		actorId: "actor-client",
		channelId: "web",
		conversationId: "conversation-client",
		executionId: "execution-client",
		turnId: "turn-client",
		messageId: operation === "turn.supplement" ? "message-client" : undefined,
		stopRequestId: operation === "turn.stop" ? "stop-client" : undefined,
		sessionGeneration: 1,
		deliveryFence: 3,
		executionDeliveryFence: operation === "turn.submit" ? undefined : 2,
		hostSessionRef: operation === "turn.submit" ? undefined : "host-client",
		selection:
			operation === "turn.submit"
				? {
						schemaVersion: 1 as const,
						modelOptionId: "model-option-client",
						reasoningLevel: "medium",
					}
				: undefined,
		input:
			operation === "turn.stop"
				? undefined
				: { text: "bounded client fixture", attachments: [] },
		runtimeGrant: grant,
	};
}

function eventRequest(afterCursor?: string) {
	return {
		schemaVersion: 1 as const,
		requestId: "request-events",
		traceId: "trace-client",
		agentId: "agent-client",
		actorId: "actor-client",
		channelId: "web",
		conversationId: "conversation-client",
		executionId: "execution-client",
		turnId: "turn-client",
		sessionGeneration: 1,
		deliveryFence: 3,
		hostSessionRef: "host-client",
		...(afterCursor ? { afterCursor } : {}),
		runtimeGrant: grant,
	};
}

function response(
	result: object = { outcome: "accepted", status: "running" },
	schemaVersion: 1 | 2 = 1,
) {
	return new Response(
		JSON.stringify({
			schemaVersion,
			hostSessionRef: "host-client",
			operationId: "execution-client",
			result,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("Worker RuntimeHost HTTP/SSE client", () => {
	it.each([
		["turn.submit", "/internal/runtime/v2/turns"],
		["turn.supplement", "/internal/runtime/v1/instructions"],
		["turn.stop", "/internal/runtime/v1/stops"],
	] as const)(
		"sends %s through the fixed versioned endpoint",
		async (operation, path) => {
			const fetcher = vi.fn<typeof fetch>(async () =>
				response(
					operation === "turn.submit"
						? { outcome: "accepted", status: "running" }
						: { outcome: "accepted", status: "cancelled" },
					operation === "turn.submit" ? 2 : 1,
				),
			);
			const client = createWorkerRuntimeHostClientV1({
				baseUrl: "https://runtime.internal/",
				serviceToken: "synthetic-service-token",
				fetch: fetcher,
			});

			await client.dispatch(request(operation));

			const [url, init] = fetcher.mock.calls[0] ?? [];
			expect(String(url)).toBe(`https://runtime.internal${path}`);
			expect(init?.headers).toMatchObject({
				authorization: "Bearer synthetic-service-token",
				"x-trace-id": "trace-client",
			});
			const body = JSON.parse(String(init?.body));
			expect(body).toMatchObject({
				schemaVersion: operation === "turn.submit" ? 2 : 1,
				agentId: "agent-client",
				actorId: "actor-client",
				conversationId: "conversation-client",
				executionId: "execution-client",
				sessionGeneration: 1,
				deliveryFence: 3,
				grant,
			});
			if (operation === "turn.submit") {
				expect(body.selection).toEqual({
					schemaVersion: 1,
					modelOptionId: "model-option-client",
					reasoningLevel: "medium",
				});
			}
			expect(JSON.stringify(body)).not.toMatch(/native|vendor|stdio|protocol/i);
		},
	);

	it("maps versioned errors and rejects malformed or native result facts", async () => {
		const errors = [
			new Response(
				JSON.stringify({
					schemaVersion: 1,
					code: "RUNTIME_SERVICE_UNAUTHORIZED",
					message: "Runtime service authentication failed",
					retryable: false,
					traceId: "trace-client",
				}),
				{ status: 401 },
			),
			new Response(
				JSON.stringify({
					schemaVersion: 2,
					hostSessionRef: "host-client",
					operationId: "execution-client",
					result: { outcome: "accepted", status: "running" },
					nativeSessionId: "must-not-cross",
				}),
				{ status: 200 },
			),
		];
		const client = createWorkerRuntimeHostClientV1({
			baseUrl: "https://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: vi.fn<typeof fetch>(async () => errors.shift() as Response),
		});

		await expect(client.dispatch(request())).rejects.toMatchObject({
			code: "RUNTIME_SERVICE_UNAUTHORIZED",
			retryable: false,
		});
		await expect(client.dispatch(request())).rejects.toMatchObject({
			code: "RUNTIME_RESPONSE_INVALID",
			retryable: true,
		});
	});

	it("bounds successful, error, and SSE response bodies before parsing", async () => {
		const oversized = "x".repeat(65_537);
		for (const response of [
			new Response(oversized, { status: 200 }),
			new Response(oversized, { status: 502 }),
		]) {
			const client = createWorkerRuntimeHostClientV1({
				baseUrl: "https://runtime.internal",
				serviceToken: "synthetic-service-token",
				fetch: vi.fn<typeof fetch>(async () => response),
			});
			await expect(client.dispatch(request())).rejects.toMatchObject({
				code: "RUNTIME_RESPONSE_INVALID",
			});
		}

		const client = createWorkerRuntimeHostClientV1({
			baseUrl: "https://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: vi.fn<typeof fetch>(
				async () =>
					new Response(`data: ${oversized}\n\n`, {
						headers: { "content-type": "text/event-stream" },
					}),
			),
		});
		await expect(
			(async () => {
				for await (const _event of client.events(eventRequest())) {
					throw new Error("Unexpected event");
				}
			})(),
		).rejects.toMatchObject({ code: "RUNTIME_EVENT_INVALID" });
	});

	it("uses V1 only for a legacy submit without frozen selection", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => response());
		const client = createWorkerRuntimeHostClientV1({
			baseUrl: "https://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: fetcher,
		});
		const legacy = { ...request(), selection: undefined };

		await client.dispatch(legacy);

		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://runtime.internal/internal/runtime/v1/turns",
		);
		const body = JSON.parse(String(init?.body));
		expect(body).not.toHaveProperty("selection");
	});

	it("streams only contract-valid correlated SSE events after the persisted cursor", async () => {
		const events = [
			{
				schemaVersion: 1,
				adapterEventKey: "event-client-2",
				executionId: "execution-client",
				cursor: "cursor-client-2",
				occurredAt: "2026-09-06T00:00:02.000Z",
				type: "status",
				payload: { status: "running" },
			},
			{
				schemaVersion: 1,
				adapterEventKey: "event-client-3",
				executionId: "execution-client",
				cursor: "cursor-client-3",
				occurredAt: "2026-09-06T00:00:03.000Z",
				type: "completed",
				payload: { status: "completed" },
			},
		];
		const stream = events
			.map(
				(event) =>
					`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join("");
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream; charset=UTF-8" },
				}),
		);
		const client = createWorkerRuntimeHostClientV1({
			baseUrl: "https://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: fetcher,
		});
		const received = [];
		for await (const event of client.events(eventRequest("cursor-client-1"))) {
			received.push(event);
		}

		expect(received).toEqual(events);
		const [, init] = fetcher.mock.calls[0] ?? [];
		expect(JSON.parse(String(init?.body))).toMatchObject({
			afterCursor: "cursor-client-1",
			deliveryFence: 3,
		});
	});

	it("rejects native fields in SSE without returning their values", async () => {
		const event = {
			schemaVersion: 1,
			adapterEventKey: "event-client-raw",
			executionId: "execution-client",
			cursor: "cursor-client-raw",
			occurredAt: "2026-09-06T00:00:02.000Z",
			type: "status",
			payload: { status: "running" },
			nativeSessionId: "must-not-cross",
		};
		const client = createWorkerRuntimeHostClientV1({
			baseUrl: "https://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: vi.fn<typeof fetch>(
				async () =>
					new Response(
						`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					),
			),
		});
		const error = await (async () => {
			try {
				for await (const _event of client.events(eventRequest())) {
					throw new Error("Unexpected event");
				}
				return undefined;
			} catch (failure) {
				return failure;
			}
		})();
		expect(error).toMatchObject({ code: "RUNTIME_EVENT_INVALID" });
		expect(JSON.stringify(error)).not.toContain("must-not-cross");
	});
});
