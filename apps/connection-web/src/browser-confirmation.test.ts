// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
	const NativeRequest = globalThis.Request;
	vi.stubGlobal(
		"Request",
		class extends NativeRequest {
			constructor(input: RequestInfo | URL, init?: RequestInit) {
				super(
					input instanceof NativeRequest
						? input
						: new URL(String(input), window.location.origin),
					init,
				);
			}
		},
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("browser request confirmation", () => {
	it("coalesces bootstrap and puts proof only in headers, never retries a rejected mutation", async () => {
		const calls: Request[] = [];
		let bootstraps = 0;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request =
					input instanceof Request
						? new Request(input, init)
						: new Request(new URL(String(input), window.location.origin), init);
				calls.push(request);
				if (new URL(request.url).pathname.endsWith("browser-confirmation")) {
					bootstraps++;
					return Response.json({
						csrfToken: `proof-${bootstraps}`,
						expiresAt: new Date(Date.now() + 300_000).toISOString(),
					});
				}
				return Response.json(
					{
						error: {
							code: "INVALID_REQUEST",
							messageKey: "connection.error.browser_confirmation_required",
							retryable: false,
							traceId: "test",
						},
					},
					{ status: 403 },
				);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		const { connectionApi } = await import("./api");
		await Promise.allSettled([
			connectionApi.login({ username: "alice", password: "test-password" }),
			connectionApi.login({ username: "bob", password: "test-password" }),
		]);
		expect(bootstraps).toBe(1);
		const writes = calls.filter((r) => r.method === "POST");
		expect(writes).toHaveLength(2);
		for (const request of writes) {
			expect(request.headers.get("X-Connection-CSRF")).toBe("proof-1");
			expect(request.url).not.toContain("proof");
		}
		await expect(
			connectionApi.login({ username: "alice", password: "test-password" }),
		).rejects.toThrow("页面安全校验");
		expect(bootstraps).toBe(2);
		expect(calls.filter((r) => r.method === "POST")).toHaveLength(3);
	});
	it("does not submit credentials if bootstrap is malformed or unavailable", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({ csrfToken: "", expiresAt: "invalid" }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { connectionApi } = await import("./api");
		await expect(
			connectionApi.login({ username: "alice", password: "test-password" }),
		).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const request = fetchMock.mock.calls[0]?.[0] as Request | undefined;
		expect(request?.method).toBe("GET");
	});
});
