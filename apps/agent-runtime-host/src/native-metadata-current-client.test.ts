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
