import type { NativeMetadataCurrentRequestV1 } from "@agent-infra/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeNativeMetadataCurrentClientV1 } from "./native-metadata-current-client.js";

function request(): NativeMetadataCurrentRequestV1 {
	const now = Date.now();
	return {
		schemaVersion: 1,
		readId: "read-a/b",
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
		phase: "read_metadata",
		originalHostScopeRef: "a".repeat(64),
	};
}
function client(fetcher: typeof fetch) {
	return createRuntimeNativeMetadataCurrentClientV1({
		baseUrl: "https://worker.example.test:3052/",
		serviceToken: "synthetic-host-to-worker-token",
		expectedWorkerId: "worker-a",
		fetch: fetcher,
	});
}

describe("Host current confirmation transport", () => {
	it("calls the exact Worker origin with the original signal on every confirmation and preserves tri-state outcomes", async () => {
		const input = request();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({ outcome: "allowed", request: input }),
			)
			.mockResolvedValueOnce(
				Response.json({ outcome: "denied" }, { status: 403 }),
			)
			.mockResolvedValueOnce(
				Response.json({ outcome: "unavailable" }, { status: 503 }),
			);
		const current = client(fetcher);
		const signal = new AbortController().signal;
		for (const outcome of ["allowed", "denied", "unavailable"] as const) {
			expect(await current(input, "worker-a", signal)).toEqual(
				outcome === "allowed" ? { outcome, request: input } : { outcome },
			);
		}
		expect(fetcher).toHaveBeenCalledTimes(3);
		for (const [url, init] of fetcher.mock.calls) {
			expect(String(url)).toBe(
				"https://worker.example.test:3052/internal/platform-worker/v1/native-metadata/reads/read-a%2Fb/current",
			);
			expect(init).toMatchObject({
				method: "POST",
				redirect: "error",
				credentials: "omit",
				cache: "no-store",
				signal,
				headers: { authorization: "Bearer synthetic-host-to-worker-token" },
				body: JSON.stringify(input),
			});
		}
	});

	it("retains the original Worker identity and token after caller configuration mutation", async () => {
		const input = request();
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({ outcome: "allowed", request: input }),
		);
		const options = {
			baseUrl: "https://worker.example.test:3052/",
			serviceToken: "synthetic-original-token",
			expectedWorkerId: "worker-a",
			fetch: fetcher,
		};
		const current = createRuntimeNativeMetadataCurrentClientV1(options);
		Object.assign(options, {
			baseUrl: "https://replacement.test",
			serviceToken: "synthetic-replacement-token",
			expectedWorkerId: "replacement-worker",
		});
		const signal = new AbortController().signal;
		expect(await current(input, "worker-a", signal)).toEqual({
			outcome: "allowed",
			request: input,
		});
		expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
			authorization: "Bearer synthetic-original-token",
		});
		expect(String(fetcher.mock.calls[0]?.[0])).toContain(
			"worker.example.test:3052",
		);
		expect(await current(input, "replacement-worker", signal)).toEqual({
			outcome: "denied",
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("foreign Worker, invalid identity, expiry and caller cancellation perform zero network I/O", async () => {
		const input = request();
		const fetcher = vi.fn<typeof fetch>();
		const current = client(fetcher);
		const signal = new AbortController().signal;
		expect(await current(input, "foreign-worker", signal)).toEqual({
			outcome: "denied",
		});
		expect(
			await current(
				{ ...input, expiresAt: input.readStartedAt + 30_001 },
				"worker-a",
				signal,
			),
		).toEqual({ outcome: "unavailable" });
		const now = Date.now();
		expect(
			await current(
				{ ...input, readStartedAt: now - 100, expiresAt: now - 1 },
				"worker-a",
				signal,
			),
		).toEqual({ outcome: "unavailable" });
		const abort = new AbortController();
		abort.abort();
		expect(await current(input, "worker-a", abort.signal)).toEqual({
			outcome: "unavailable",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each([
		[200, "denied"],
		[200, "unavailable"],
		[403, "allowed"],
		[403, "unavailable"],
		[503, "allowed"],
		[503, "denied"],
	] as const)("rejects HTTP %s paired with %s", async (status, outcome) => {
		const input = request();
		const body =
			outcome === "allowed" ? { outcome, request: input } : { outcome };
		const current = client(
			vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status })),
		);
		expect(
			await current(input, "worker-a", new AbortController().signal),
		).toEqual({ outcome: "unavailable" });
	});

	it.each([
		"changed-scope",
		"changed-phase",
		"extra-field",
		"oversize",
		"media-type",
		"network",
	])("rejects %s without returning upstream data", async (fault) => {
		const input = request();
		const fetcher = vi.fn<typeof fetch>(async () => {
			if (fault === "network") throw new Error("private-upstream-canary");
			if (fault === "oversize")
				return Response.json({ privateData: "x".repeat(65_537) });
			if (fault === "media-type")
				return new Response(
					JSON.stringify({ outcome: "allowed", request: input }),
				);
			const changed =
				fault === "changed-scope"
					? { ...input, scope: { ...input.scope, agentId: "other-agent" } }
					: fault === "changed-phase"
						? {
								...input,
								phase: "resolve_original_binding",
								originalHostScopeRef: null,
							}
						: input;
			return Response.json({
				outcome: "allowed",
				request: changed,
				...(fault === "extra-field"
					? { privateData: "private-upstream-canary" }
					: {}),
			});
		});
		expect(
			await client(fetcher)(input, "worker-a", new AbortController().signal),
		).toEqual({ outcome: "unavailable" });
	});

	it.each(["response", "body"] as const)(
		"cancels the upstream body and drops allowed when abort arrives during %s",
		async (phase) => {
			const input = request();
			const abort = new AbortController();
			const cancel = vi.fn();
			const fetcher = vi.fn<typeof fetch>(async () => {
				const body = new ReadableStream<Uint8Array>(
					{
						pull(stream) {
							stream.enqueue(
								new TextEncoder().encode(
									JSON.stringify({ outcome: "allowed", request: input }),
								),
							);
							abort.abort();
						},
						cancel,
					},
					{ highWaterMark: 0 },
				);
				if (phase === "response") abort.abort();
				return new Response(body, {
					headers: { "content-type": "application/json" },
				});
			});
			expect(await client(fetcher)(input, "worker-a", abort.signal)).toEqual({
				outcome: "unavailable",
			});
			expect(cancel).toHaveBeenCalledOnce();
		},
	);

	it.each([
		"https://worker.example.test/internal",
		"https://user:private-token@worker.example.test/",
		"https://worker.example.test/?token=private-token",
		"https://worker.example.test/#fragment",
		"file:///worker",
	])(
		"rejects a Worker source that is not a fixed credential-free origin",
		(baseUrl) => {
			const fetcher = vi.fn<typeof fetch>();
			expect(() =>
				createRuntimeNativeMetadataCurrentClientV1({
					baseUrl,
					serviceToken: "synthetic-host-token",
					expectedWorkerId: "worker-a",
					fetch: fetcher,
				}),
			).toThrow("Metadata Worker instance configuration is invalid");
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
});
