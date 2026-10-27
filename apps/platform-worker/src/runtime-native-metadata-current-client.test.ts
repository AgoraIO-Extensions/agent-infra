import { describe, expect, it, vi } from "vitest";
import { createPlatformApiNativeMetadataCurrentClientV1 } from "./runtime-native-metadata-current-client.js";

const request = {
	schemaVersion: 1 as const,
	readId: "read-current-client",
	selector: "status" as const,
	scope: {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: "user-current-client" },
		agentId: "agent-current-client",
		channelId: "web",
		conversationId: "conversation-current-client",
		executionId: "execution-current-client",
		sessionGeneration: 1,
		authorizationRevision: "authorization-current-client",
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "request-current-client",
	traceId: "trace-current-client",
	phase: "read_metadata" as const,
	originalHostScopeRef: "host-current-client",
};

const response = {
	outcome: "allowed" as const,
	request,
};

function client(
	fetcher: typeof fetch,
	overrides: Record<string, unknown> = {},
) {
	return createPlatformApiNativeMetadataCurrentClientV1({
		baseUrl: "http://platform-api.internal",
		serviceToken: "platform-api-service-token",
		fetch: fetcher,
		...overrides,
	});
}

describe("Platform API native metadata current client", () => {
	it.each([
		"https://platform-api.internal",
		"http://user:password@platform-api.internal",
		"http://platform-api.internal?override=1",
		"http://platform-api.internal#fragment",
	])("rejects an unsafe Platform API origin %s", (baseUrl) => {
		expect(() =>
			createPlatformApiNativeMetadataCurrentClientV1({
				baseUrl,
				serviceToken: "platform-api-service-token",
			}),
		).toThrow("Platform API base URL is invalid");
	});

	it("posts the bound request to the fixed current-confirmation route", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify(response), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(
			client(fetcher).check({
				request,
				apiRequestSourceRef: "api-instance-current-client",
			}),
		).resolves.toEqual(response);
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"http://platform-api.internal/internal/platform/v1/native-metadata/current",
		);
		expect(init?.headers).toMatchObject({
			authorization: "Bearer platform-api-service-token",
			"x-trace-id": request.traceId,
		});
		expect(JSON.parse(init?.body as string)).toEqual({
			apiRequestSourceRef: "api-instance-current-client",
			request,
		});
	});

	it("does not allow request data to select the origin or authorization", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify(response), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(
			client(fetcher).check({
				request: {
					...request,
					// Runtime input cannot carry a URL or token; strict parsing rejects
					// an attempted caller-selected destination/credential.
					origin: "http://attacker.invalid",
					authorization: "Bearer attacker-token",
				} as never,
				apiRequestSourceRef: "api-instance-current-client",
			}),
		).resolves.toEqual({ outcome: "unavailable" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("allows confirmation beyond ten seconds within the original request deadline", async () => {
		const startedAt = Date.now();
		const liveRequest = {
			...request,
			readStartedAt: startedAt,
			expiresAt: startedAt + 30_000,
		};
		const fetcher = vi.fn<typeof fetch>().mockImplementation(
			async (_input, init) =>
				new Promise<Response>((resolve, reject) => {
					const abort = () => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					};
					const timer = setTimeout(() => {
						init?.signal?.removeEventListener("abort", abort);
						resolve(
							new Response(
								JSON.stringify({ outcome: "allowed", request: liveRequest }),
								{ status: 200, headers: { "content-type": "application/json" } },
							),
						);
					}, 11_000);
					init?.signal?.addEventListener("abort", abort, { once: true });
					if (init?.signal?.aborted) abort();
				}),
		);
		await expect(
			client(fetcher).check({
				request: liveRequest,
				apiRequestSourceRef: "api-instance-current-client",
			}),
		).resolves.toEqual({ outcome: "allowed", request: liveRequest });
	}, 15_000);

	it("fails closed on timeout", async () => {
		const fetcher = vi.fn<typeof fetch>().mockImplementation(
			async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error("aborted")),
						{ once: true },
					);
				}),
		);
		const started = Date.now();
		await expect(
			client(fetcher, { transportTimeoutMs: 25 }).check({
				request,
				apiRequestSourceRef: "api-instance-current-client",
			}),
		).resolves.toEqual({ outcome: "unavailable" });
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it.each([
		"malformed JSON",
		"oversized response",
		"redirect response",
		"unauthorized response",
	])("fails closed on %s", async (failure) => {
		let responseValue: Response;
		if (failure === "malformed JSON") {
			responseValue = new Response("not-json", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		} else if (failure === "oversized response") {
			responseValue = new Response(
				JSON.stringify({ outcome: "allowed", request }) + "x".repeat(65 * 1024),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		} else if (failure === "redirect response") {
			responseValue = new Response(JSON.stringify(response), {
				status: 200,
				headers: {
					"content-type": "application/json",
					location: "http://attacker.invalid/current",
				},
			});
			Object.defineProperty(responseValue, "redirected", { value: true });
		} else {
			responseValue = new Response(JSON.stringify({ outcome: "unavailable" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		}
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(responseValue);
		await expect(
			client(fetcher).check({
				request,
				apiRequestSourceRef: "api-instance-current-client",
			}),
		).resolves.toEqual({ outcome: "unavailable" });
	});

	it("returns a denied confirmation without treating it as allowed", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ outcome: "denied" }), {
				status: 403,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(
			client(fetcher).check({
				request,
				apiRequestSourceRef: "api-instance-current-client",
			}),
		).resolves.toEqual({ outcome: "denied" });
	});

	it("fails closed when an allowed response crosses the bound request", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					outcome: "allowed",
					request: {
						...request,
						executionId: "foreign-execution",
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);
		await expect(
			client(fetcher).check({
				request,
				apiRequestSourceRef: "api-instance-current-client",
			}),
		).resolves.toEqual({ outcome: "unavailable" });
	});
});
