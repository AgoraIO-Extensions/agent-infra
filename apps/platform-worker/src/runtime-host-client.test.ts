import type {
	ExecutionGrantV1,
	RuntimeSkillDirectoryEntryV1,
	RuntimeSkillDirectoryRequestV1,
	RuntimeSkillResourceReadRequestV1,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";

import {
	createWorkerRuntimeHostClientV1,
	createWorkerRuntimeHostClientV3,
} from "./runtime-host-client.js";

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

function statusRequest() {
	return {
		...eventRequest(),
		schemaVersion: 2 as const,
		recovery: {
			schemaVersion: 1 as const,
			input: { text: "bounded client fixture", attachments: [] },
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "model-option-client",
				reasoningLevel: "medium",
			},
		},
	};
}

function skillRequest(): RuntimeSkillDirectoryRequestV1;
function skillRequest(relativePath: string): RuntimeSkillResourceReadRequestV1;
function skillRequest(relativePath?: string) {
	const base = {
		schemaVersion: 1 as const,
		requestId: "request-skill",
		traceId: "trace-skill",
		actorId: "actor-client",
		channelId: "web",
		agentId: "agent-client",
		conversationId: "conversation-client",
		executionId: "execution-client",
		turnId: "turn-client",
		sessionGeneration: 1,
		deliveryFence: 3,
		hostSessionRef: "host-client",
		grant,
	};
	return relativePath === undefined
		? base
		: { ...base, skillName: "demo", relativePath };
}

const skillDirectoryResponse = {
	schemaVersion: 1,
	hostSessionRef: "host-client",
	generationId: "a".repeat(64),
	skills: [
		{
			schemaVersion: 1,
			name: "demo",
			version: "1.0.0",
			manifestSha256: "b".repeat(64),
			packageDigest: "c".repeat(64),
			readOnly: true,
		},
	],
} as const;

const skillResourceResponse = {
	schemaVersion: 1,
	hostSessionRef: "host-client",
	skillName: "demo",
	relativePath: "SKILL.md",
	sizeBytes: 5,
	sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
	bytesBase64: "aGVsbG8=",
};

function firstSkill(directory: {
	readonly skills: readonly RuntimeSkillDirectoryEntryV1[];
}): RuntimeSkillDirectoryEntryV1 {
	const entry = directory.skills[0];
	if (!entry) throw new Error("Missing Skill fixture");
	return entry;
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
	it.each(
		[createWorkerRuntimeHostClientV1, createWorkerRuntimeHostClientV3].flatMap(
			(createClient) =>
				[
					"https://runtime.internal/",
					"http://user:secret@runtime.internal/",
					"http://runtime.internal/?override=1",
					"http://runtime.internal/#fragment",
				].map((baseUrl) => [createClient, baseUrl] as const),
		),
	)(
		"rejects a non in-cluster plaintext origin before any Runtime credentials can be sent (%#)",
		(createClient, baseUrl) => {
			expect(() =>
				createClient({ baseUrl, serviceToken: "synthetic-service-token" }),
			).toThrow("RuntimeHost base URL is invalid");
		},
	);
	it("never follows Runtime redirects on the default in-cluster transport", async () => {
		const { runtimeFetch } = await import("./runtime-transport.js");
		const original = globalThis.fetch;
		const seen: RequestInit[] = [];
		globalThis.fetch = (async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			seen.push(init ?? {});
			return new Response("{}");
		}) as typeof fetch;
		try {
			await runtimeFetch("http://runtime.internal/internal/runtime/v3/turns", {
				method: "POST",
				redirect: "follow",
			});
			expect(seen[0]?.redirect).toBe("error");
			await expect(
				runtimeFetch("https://runtime.internal/internal/runtime/v3/turns"),
			).rejects.toThrow("RUNTIME_ORIGIN_INVALID");
			expect(seen).toHaveLength(1);
		} finally {
			globalThis.fetch = original;
		}
	});
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
				baseUrl: "http://runtime.internal/",
				serviceToken: "synthetic-service-token",
				fetch: fetcher,
			});

			await client.dispatch(request(operation));

			const [url, init] = fetcher.mock.calls[0] ?? [];
			expect(String(url)).toBe(`http://runtime.internal${path}`);
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
			baseUrl: "http://runtime.internal",
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
		const cancel = vi.fn();
		const declaredOversized = new Response(new ReadableStream({ cancel }), {
			status: 200,
			headers: { "content-length": "65537" },
		});
		for (const response of [
			new Response(oversized, { status: 200 }),
			new Response(oversized, { status: 502 }),
			declaredOversized,
		]) {
			const client = createWorkerRuntimeHostClientV1({
				baseUrl: "http://runtime.internal",
				serviceToken: "synthetic-service-token",
				fetch: vi.fn<typeof fetch>(async () => response),
			});
			await expect(client.dispatch(request())).rejects.toMatchObject({
				code: "RUNTIME_RESPONSE_INVALID",
			});
		}
		expect(cancel).toHaveBeenCalledOnce();

		const oversizedFrame = "x".repeat(131_073);
		const client = createWorkerRuntimeHostClientV1({
			baseUrl: "http://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: vi.fn<typeof fetch>(
				async () =>
					new Response(`data: ${oversizedFrame}\n\n`, {
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
			baseUrl: "http://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: fetcher,
		});
		const legacy = { ...request(), selection: undefined };

		await client.dispatch(legacy);

		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"http://runtime.internal/internal/runtime/v1/turns",
		);
		const body = JSON.parse(String(init?.body));
		expect(body).not.toHaveProperty("selection");
	});

	it("recovers Execution status through the fixed versioned endpoint", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(
					JSON.stringify({
						schemaVersion: 2,
						hostSessionRef: "host-client",
						executionId: "execution-client",
						outcome: "found",
						status: "running",
					}),
				),
		);
		const client = createWorkerRuntimeHostClientV1({
			baseUrl: "http://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: fetcher,
		});

		await expect(client.recoverStatus(statusRequest())).resolves.toMatchObject({
			status: "running",
		});
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"http://runtime.internal/internal/runtime/v2/status",
		);
		expect(JSON.parse(String(init?.body))).toMatchObject({
			executionId: "execution-client",
			deliveryFence: 3,
			recovery: {
				input: { text: "bounded client fixture", attachments: [] },
			},
			grant,
		});
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
			baseUrl: "http://runtime.internal",
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
			baseUrl: "http://runtime.internal",
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

	it("reads the authenticated directory and a bound resource through fixed Host routes", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(skillDirectoryResponse), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(skillResourceResponse), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		const client = createWorkerRuntimeHostClientV1({
			baseUrl: "http://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: fetcher,
		});
		const directory = await client.skillDirectory(skillRequest());
		const resource = await client.readSkillResource(skillRequest("SKILL.md"), {
			generationId: directory.generationId,
			entry: firstSkill(directory),
			maximumBytes: 5,
		});
		expect(directory).toEqual(skillDirectoryResponse);
		expect(resource).toEqual(skillResourceResponse);
		expect(String(fetcher.mock.calls[0]?.[0])).toBe(
			"http://runtime.internal/internal/runtime/v1/skills",
		);
		expect(String(fetcher.mock.calls[1]?.[0])).toBe(
			"http://runtime.internal/internal/runtime/v1/skills/resources",
		);
		for (const [, init] of fetcher.mock.calls) {
			expect(init?.headers).toMatchObject({
				authorization: "Bearer synthetic-service-token",
				"content-type": "application/json",
			});
		}
		expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(
			skillRequest("SKILL.md"),
		);
	});

	it("rejects an invalid service token response and malformed or oversized bodies", async () => {
		const unauthorized = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					schemaVersion: 1,
					code: "RUNTIME_SERVICE_UNAUTHORIZED",
					message: "Runtime service authentication failed",
					retryable: false,
					traceId: "trace-skill",
				}),
				{ status: 401 },
			),
		);
		await expect(
			createWorkerRuntimeHostClientV1({
				baseUrl: "http://runtime.internal",
				serviceToken: "wrong-service-token",
				fetch: unauthorized,
			}).skillDirectory(skillRequest()),
		).rejects.toMatchObject({
			code: "RUNTIME_SERVICE_UNAUTHORIZED",
			retryable: false,
		});

		const malformed = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(skillDirectoryResponse), { status: 200 }),
			)
			.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
		const malformedClient = createWorkerRuntimeHostClientV1({
			baseUrl: "http://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: malformed,
		});
		const directory = await malformedClient.skillDirectory(skillRequest());
		await expect(
			malformedClient.readSkillResource(skillRequest("SKILL.md"), {
				generationId: directory.generationId,
				entry: firstSkill(directory),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_RESPONSE_INVALID" });

		const oversized = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(skillDirectoryResponse), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response("x".repeat(1_402_201), { status: 200 }),
			);
		const oversizedClient = createWorkerRuntimeHostClientV1({
			baseUrl: "http://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: oversized,
		});
		await oversizedClient.skillDirectory(skillRequest());
		await expect(
			oversizedClient.readSkillResource(skillRequest("SKILL.md")),
		).rejects.toMatchObject({ code: "RUNTIME_RESPONSE_INVALID" });
	});

	it("fails closed on generation, entry, path and digest drift", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(skillDirectoryResponse), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						...skillResourceResponse,
						relativePath: "other.md",
					}),
					{ status: 200 },
				),
			);
		const client = createWorkerRuntimeHostClientV1({
			baseUrl: "http://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: fetcher,
		});
		const directory = await client.skillDirectory(skillRequest());
		await expect(
			client.readSkillResource(skillRequest("SKILL.md"), {
				generationId: "d".repeat(64),
				entry: firstSkill(directory),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_REQUEST_INVALID" });
		expect(fetcher).toHaveBeenCalledOnce();

		await expect(
			client.readSkillResource(skillRequest("SKILL.md"), {
				generationId: directory.generationId,
				entry: { ...firstSkill(directory), name: "foreign" },
			}),
		).rejects.toMatchObject({ code: "RUNTIME_REQUEST_INVALID" });
		expect(fetcher).toHaveBeenCalledOnce();

		await expect(
			client.readSkillResource(skillRequest("SKILL.md")),
		).rejects.toMatchObject({ code: "RUNTIME_RESPONSE_INVALID" });
	});

	it("converts cancellation into a retryable interruption before delivering bytes", async () => {
		let release: (() => void) | undefined;
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(skillDirectoryResponse), { status: 200 }),
			)
			.mockImplementationOnce(
				() =>
					new Promise<Response>(
						(resolve) => (release = () => resolve(new Response("{}"))),
					),
			);
		const client = createWorkerRuntimeHostClientV1({
			baseUrl: "http://runtime.internal",
			serviceToken: "synthetic-service-token",
			fetch: fetcher,
		});
		const directory = await client.skillDirectory(skillRequest());
		const controller = new AbortController();
		const pending = client.readSkillResource(
			skillRequest("SKILL.md"),
			{ generationId: directory.generationId, entry: firstSkill(directory) },
			controller.signal,
		);
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		controller.abort();
		await expect(pending).rejects.toMatchObject({
			code: "RUNTIME_INTERRUPTED",
			retryable: true,
		});
		release?.();
	});
});
