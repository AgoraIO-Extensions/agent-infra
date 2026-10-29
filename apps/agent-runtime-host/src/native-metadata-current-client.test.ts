import { describe, expect, it, vi } from "vitest";
import { createRuntimeNativeMetadataCurrentClientV1 } from "./native-metadata-current-client.js";

const request = {
	schemaVersion: 1 as const,
	readId: "read-host-client",
	selector: "status" as const,
	scope: {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: "user-host-client" },
		agentId: "agent-host-client",
		channelId: "web",
		conversationId: "conversation-host-client",
		executionId: "execution-host-client",
		sessionGeneration: 1,
		authorizationRevision: "authorization-host-client",
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "request-host-client",
	traceId: "trace-host-client",
	phase: "read_metadata" as const,
	originalHostScopeRef: "host-host-client",
};

describe("Runtime native metadata current client", () => {
	it("posts only to the fixed Worker current route", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ outcome: "allowed", request }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const client = createRuntimeNativeMetadataCurrentClientV1({
			baseUrl: "http://worker.internal",
			serviceToken: "worker-service-token",
			fetch: fetcher,
		});
		await expect(
			client.check({
				request,
				apiRequestSourceRef: "api-source-host-client",
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ outcome: "allowed", request });
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"http://worker.internal/internal/platform-worker/v1/native-metadata/current",
		);
		expect(JSON.parse(init?.body as string)).toEqual({
			apiRequestSourceRef: "api-source-host-client",
			request,
		});
		expect(init?.headers).toMatchObject({
			authorization: "Bearer worker-service-token",
		});
	});

	it("fails closed on unavailable Worker responses", async () => {
		const client = createRuntimeNativeMetadataCurrentClientV1({
			baseUrl: "http://worker.internal",
			serviceToken: "worker-service-token",
			fetch: async () =>
				new Response(JSON.stringify({ outcome: "unavailable" }), {
					status: 503,
					headers: { "content-type": "application/json" },
				}),
		});
		await expect(
			client.check({
				request,
				apiRequestSourceRef: "api-source-host-client",
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({ outcome: "unavailable" });
	});
});

it.each([200, 201, 403])(
	"preserves current-confirmation status %i without a media check",
	async (status) => {
		const result = { outcome: "allowed", request };
		const client = createRuntimeNativeMetadataCurrentClientV1({
			baseUrl: "http://worker",
			serviceToken: "token",
			fetch: async () =>
				new Response(JSON.stringify(result), {
					status,
					headers: { "content-type": "text/plain" },
				}),
		});
		await expect(
			client.check({
				request,
				apiRequestSourceRef: "source",
				signal: new AbortController().signal,
			}),
		).resolves.toEqual(status === 403 ? { outcome: "unavailable" } : result);
	},
);

it("releases an unread rejected response even when cancellation fails", async () => {
	let canceled = false;
	const client = createRuntimeNativeMetadataCurrentClientV1({
		baseUrl: "http://worker",
		serviceToken: "token",
		fetch: async () =>
			new Response(
				new ReadableStream({
					cancel() {
						canceled = true;
						throw new Error("private cancellation failure");
					},
				}),
				{ status: 503 },
			),
	});
	await expect(
		client.check({
			request,
			apiRequestSourceRef: "source",
			signal: new AbortController().signal,
		}),
	).resolves.toEqual({ outcome: "unavailable" });
	expect(canceled).toBe(true);
});

it.each([65_536, 65_537])(
	"retains the Host current response budget at %i bytes",
	async (size) => {
		const result = { outcome: "allowed", request };
		const json = JSON.stringify(result);
		const client = createRuntimeNativeMetadataCurrentClientV1({
			baseUrl: "http://worker",
			serviceToken: "token",
			fetch: async () => new Response(json + " ".repeat(size - json.length)),
		});
		await expect(
			client.check({
				request,
				apiRequestSourceRef: "source",
				signal: new AbortController().signal,
			}),
		).resolves.toEqual(size === 65_536 ? result : { outcome: "unavailable" });
	},
);

it("retains replacement UTF-8 decoding for a matching Host binding", async () => {
	const live = { ...request, traceId: "replacement-�" };
	const result = { outcome: "allowed", request: live };
	const raw = new TextEncoder().encode(JSON.stringify(result));
	const marker = raw.indexOf(0xef);
	const bytes = new Uint8Array([
		...raw.slice(0, marker),
		0xff,
		...raw.slice(marker + 3),
	]);
	const client = createRuntimeNativeMetadataCurrentClientV1({
		baseUrl: "http://worker",
		serviceToken: "token",
		fetch: async () => new Response(bytes),
	});
	await expect(
		client.check({
			request: live,
			apiRequestSourceRef: "source",
			signal: new AbortController().signal,
		}),
	).resolves.toEqual(result);
});
