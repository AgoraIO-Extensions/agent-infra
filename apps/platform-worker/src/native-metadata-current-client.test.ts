import type { NativeMetadataCurrentRequestV1 } from "@agent-infra/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPlatformNativeMetadataCurrentClientV1 } from "./native-metadata-current-client.js";

function request(): NativeMetadataCurrentRequestV1 {
	const now = Date.now();
	return {
		schemaVersion: 1,
		readId: "read-original",
		selector: "status",
		scope: {
			schemaVersion: 1,
			principal: { kind: "user", id: "user-a" },
			agentId: "agent-a",
			channelId: "web",
			conversationId: "conversation-a",
			executionId: "execution-a",
			sessionGeneration: 1,
			authorizationRevision: "authorization-a",
		},
		readStartedAt: now,
		expiresAt: now + 30_000,
		requestId: "request-a",
		traceId: "trace-a",
		phase: "resolve_original_binding",
		originalHostScopeRef: null,
	};
}
function sources() {
	return new Map([
		[
			"api-original",
			{
				baseUrl: "http://127.0.0.1:3051/",
				serviceToken: "synthetic-worker-current-token",
			},
		],
	]);
}

describe("metadata current fixed API instance transport", () => {
	it("snapshots the instance mapping and makes fresh authenticated requests without caching allowed", async () => {
		const input = request();
		const apiSources = sources();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementationOnce(async () =>
				Response.json({ outcome: "allowed", request: input }),
			)
			.mockImplementationOnce(async () =>
				Response.json({ outcome: "denied" }, { status: 403 }),
			);
		const current = createPlatformNativeMetadataCurrentClientV1({
			apiSources,
			fetch: fetcher,
		});
		apiSources.clear();
		const signal = new AbortController().signal;
		await expect(current("api-original", input, signal)).resolves.toEqual({
			outcome: "allowed",
			request: input,
		});
		await expect(current("api-original", input, signal)).resolves.toEqual({
			outcome: "denied",
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		for (const [url, init] of fetcher.mock.calls) {
			expect(String(url)).toBe(
				"http://127.0.0.1:3051/internal/platform-api/v1/native-metadata/reads/read-original/current",
			);
			expect(init).toMatchObject({
				method: "POST",
				redirect: "error",
				signal,
				headers: { authorization: "Bearer synthetic-worker-current-token" },
				body: JSON.stringify(input),
			});
		}
	});

	it("unknown instance, expired request and caller abort perform zero network I/O", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const current = createPlatformNativeMetadataCurrentClientV1({
			apiSources: sources(),
			fetch: fetcher,
		});
		const input = request();
		const signal = new AbortController().signal;
		await expect(current("other-api", input, signal)).resolves.toEqual({
			outcome: "unavailable",
		});
		await expect(
			current(
				"api-original",
				{
					...input,
					readStartedAt: Date.now() - 100,
					expiresAt: Date.now() - 1,
				},
				signal,
			),
		).resolves.toEqual({ outcome: "unavailable" });
		const aborted = new AbortController();
		aborted.abort();
		await expect(
			current("api-original", input, aborted.signal),
		).resolves.toEqual({ outcome: "unavailable" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each([
		"wrong-request",
		"extra-field",
		"status-mismatch",
		"oversize",
		"redirect",
		"network",
	])(
		"rejects %s without returning upstream text or identity",
		async (fault) => {
			const input = request();
			const fetcher = vi.fn<typeof fetch>(async () => {
				if (fault === "network") throw new Error("private-upstream-sentinel");
				if (fault === "redirect")
					return new Response("private-upstream-sentinel", {
						status: 302,
						headers: { location: "https://untrusted.example.test/" },
					});
				if (fault === "oversize") return new Response("x".repeat(65_537));
				if (fault === "status-mismatch")
					return Response.json({ outcome: "denied" });
				return Response.json({
					outcome: "allowed",
					request:
						fault === "wrong-request"
							? { ...input, scope: { ...input.scope, agentId: "other-agent" } }
							: input,
					...(fault === "extra-field"
						? { privateValue: "private-upstream-sentinel" }
						: {}),
				});
			});
			const current = createPlatformNativeMetadataCurrentClientV1({
				apiSources: sources(),
				fetch: fetcher,
			});
			await expect(
				current("api-original", input, new AbortController().signal),
			).resolves.toEqual({ outcome: "unavailable" });
		},
	);

	it("a late response after disconnect cannot return allowed", async () => {
		const input = request();
		const controller = new AbortController();
		const fetcher = vi.fn<typeof fetch>(async () => {
			controller.abort();
			return Response.json({ outcome: "allowed", request: input });
		});
		const current = createPlatformNativeMetadataCurrentClientV1({
			apiSources: sources(),
			fetch: fetcher,
		});
		await expect(
			current("api-original", input, controller.signal),
		).resolves.toEqual({ outcome: "unavailable" });
	});

	it("abort during body streaming cannot deliver the parsed allowed result", async () => {
		const input = request();
		const controller = new AbortController();
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(
					new ReadableStream({
						pull(stream) {
							stream.enqueue(
								new TextEncoder().encode(
									JSON.stringify({ outcome: "allowed", request: input }),
								),
							);
							controller.abort();
							stream.close();
						},
					}),
				),
		);
		const current = createPlatformNativeMetadataCurrentClientV1({
			apiSources: sources(),
			fetch: fetcher,
		});
		await expect(
			current("api-original", input, controller.signal),
		).resolves.toEqual({ outcome: "unavailable" });
	});
});
