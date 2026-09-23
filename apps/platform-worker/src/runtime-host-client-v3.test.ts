import { requireConversationOperationSuccessorV2 } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import { createWorkerRuntimeHostClientV3 } from "./runtime-host-client.js";

const base = {
	schemaVersion: 3 as const,
	requestId: "request",
	traceId: "trace",
	principal: { kind: "user" as const, id: "user" },
	channelId: "web",
	agentId: "agent",
	conversationId: "conversation",
	executionId: "execution",
	turnId: "turn",
	sessionGeneration: 1,
	hostSessionRef: "host",
	operation: {
		kind: "execution" as const,
		id: "execution",
		deliveryFence: 1,
		executionDeliveryFence: 1,
	},
	grant: {
		schemaVersion: 2 as const,
		format: "runtime-execution-jws" as const,
		token: "header.payload.signature",
	},
};
function client(fetcher: typeof fetch) {
	return createWorkerRuntimeHostClientV3({
		baseUrl: "http://runtime.local",
		serviceToken: "synthetic-service-proof",
		fetch: fetcher,
	});
}

describe("Worker V3 Runtime Client", () => {
	it("projects unverified and verified evidence into the same terminal domain attempt", async () => {
		const fact = {
			kind: "tool",
			phase: "completed",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			toolId: "connection.github.create_pr",
			startedAt: "2026-09-14T12:00:00.000Z",
			finishedAt: "2026-09-14T12:00:01.000Z",
			durationMs: 1_000,
			resultRef: "result-1",
			connection: {
				serviceRef: "connection-primary",
				verification: "unverified",
				callRef: "call-1",
				reason: "record_unavailable",
			},
		};
		const facts = [
			fact,
			{
				...fact,
				connection: {
					serviceRef: "connection-primary",
					verification: "verified",
					callRef: "call-1",
				},
			},
		];
		const wireEvents = facts.map((payload, i) => ({
			schemaVersion: 2,
			type: "operation",
			adapterEventKey: `event-${i}`,
			executionId: "execution",
			cursor: `cursor-${i}`,
			occurredAt: "2026-09-14T12:00:02.000Z",
			payload,
		}));
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(
					wireEvents
						.map(
							(event) =>
								`id: ${event.cursor}\nevent: operation\ndata: ${JSON.stringify(event)}\n\n`,
						)
						.join(""),
					{ headers: { "content-type": "text/event-stream" } },
				),
			);
		const received = [];
		for await (const entry of client(fetcher).events({
			...base,
			consumer: "platform_worker_persistence",
			afterCursor: null,
		}))
			received.push(entry);
		expect(received).toEqual(wireEvents);
		const before = received[0];
		const after = received[1];
		if (before?.schemaVersion !== 2 || after?.schemaVersion !== 2)
			throw new Error("Expected domain operation facts");
		expect(() =>
			requireConversationOperationSuccessorV2([before.payload], after.payload),
		).not.toThrow();
	});

	it("rejects private, arbitrary or cross-execution evidence before projecting a domain event", async () => {
		const connection = {
			serviceRef: "connection-primary",
			verification: "verified",
			callRef: "call-1",
		};
		const event = {
			schemaVersion: 2,
			adapterEventKey: "fact-1",
			executionId: "execution",
			cursor: "cursor-1",
			occurredAt: "2026-09-14T12:00:00Z",
			type: "operation",
			payload: {
				kind: "tool",
				phase: "completed",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
				toolId: "connection.github.create_pr",
				connection,
			},
		};
		for (const invalid of [
			{ ...event, executionId: "other-execution" },
			...[
				{ ...connection, serviceRef: "https://arbitrary.test" },
				{ ...connection, callRef: "https://arbitrary.test/call" },
				{ ...connection, principal: { kind: "user", id: "other-user" } },
				{ ...connection, token: "synthetic-private-value" },
				{ ...connection, operationNonce: "private-nonce" },
				{
					...connection,
					verification: "unverified",
					reason: "unbounded response text",
				},
			].map((association) => ({
				...event,
				payload: { ...event.payload, connection: association },
			})),
			{
				...event,
				payload: {
					kind: "model",
					phase: "completed",
					operationRef: "operation-1",
					attemptRef: "attempt-1",
					model: {
						configVersion: "revision-1",
						modelOptionId: "model-1",
						modelId: "model-1",
					},
					connection,
				},
			},
		]) {
			const fetcher = vi
				.fn<typeof fetch>()
				.mockResolvedValue(
					new Response(
						`id: cursor-1\nevent: operation\ndata: ${JSON.stringify(invalid)}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					),
				);
			const received: unknown[] = [];
			await expect(async () => {
				for await (const entry of client(fetcher).events({
					...base,
					consumer: "platform_worker_persistence",
					afterCursor: null,
				}))
					received.push(entry);
			}).rejects.toMatchObject({ code: "RUNTIME_EVENT_INVALID" });
			expect(received).toEqual([]);
		}
	});
	it("sends only the original digest for control recovery, including when Host ref is unknown", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					schemaVersion: 3,
					outcome: "not_found",
					hostSessionRef: "host",
					executionId: "execution",
				}),
				{ status: 200 },
			),
		);
		const result = await client(fetcher).recoverStatus({
			...base,
			hostSessionRef: null,
			originalOperationDigest: "a".repeat(43),
		});
		expect(result.outcome).toBe("not_found");
		const call = fetcher.mock.calls[0];
		if (!call) throw new Error("missing request");
		const [url, options] = call;
		expect(String(url)).toBe("http://runtime.local/internal/runtime/v3/status");
		const payload = JSON.parse(options?.body as string);
		expect(payload).not.toHaveProperty("input");
		expect(payload).not.toHaveProperty("recovery");
		expect(payload.hostSessionRef).toBeNull();
	});
	it("never downgrades a rejected V3 request", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("{}", { status: 403 }));
		await expect(
			client(fetcher).submitTurn({
				...base,
				input: { text: "synthetic input", attachments: [] },
			}),
		).rejects.toThrow();
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(String(fetcher.mock.calls[0]?.[0])).toContain("/v3/turns");
	});
	it("preserves versioned operation facts and rejects an event from another execution", async () => {
		const event = {
			schemaVersion: 2,
			adapterEventKey: "fact-1",
			executionId: "execution",
			cursor: "cursor-1",
			occurredAt: "2026-09-14T12:00:00Z",
			type: "operation",
			payload: {
				kind: "model",
				phase: "completed",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
				model: {
					configVersion: "config-1",
					modelOptionId: "option",
					modelId: "model",
				},
			},
		};
		const response = (value: typeof event) =>
			new Response(
				`id: ${value.cursor}\nevent: operation\ndata: ${JSON.stringify(value)}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(event))
			.mockResolvedValueOnce(
				response({ ...event, executionId: "another-execution" }),
			);
		const request = {
			...base,
			consumer: "platform_worker_persistence" as const,
			afterCursor: null,
		};
		const received = [];
		for await (const entry of client(fetcher).events(request))
			received.push(entry);
		expect(received).toEqual([event]);
		await expect(async () => {
			for await (const _entry of client(fetcher).events(request)) {
				/* consume */
			}
		}).rejects.toThrow();
	});
});
