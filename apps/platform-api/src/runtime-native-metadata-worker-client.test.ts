import { describe, expect, it } from "vitest";
import { createPlatformWorkerNativeMetadataGatewayClientV1 } from "./runtime-native-metadata-worker-client.js";

const request = {
	schemaVersion: 1 as const,
	readId: "read-client",
	selector: "status" as const,
	scope: {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: "user-client" },
		agentId: "agent-client",
		channelId: "web",
		conversationId: "conversation-client",
		executionId: "execution-client",
		sessionGeneration: 1,
		authorizationRevision: "authorization-client",
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "request-client",
	traceId: "trace-client",
	apiRequestSourceRef: "api-client",
};

const response = {
	schemaVersion: request.schemaVersion,
	readId: request.readId,
	selector: request.selector,
	scope: request.scope,
	readStartedAt: request.readStartedAt,
	expiresAt: request.expiresAt,
	requestId: request.requestId,
	traceId: request.traceId,
	originalHostScopeRef: "host-client",
	projection: {
		selector: "status" as const,
		status: "active" as const,
		readAt: "2026-10-14T00:00:00.000Z",
	},
};

describe("Platform Worker native metadata gateway client", () => {
	it("posts Platform request data to the fixed Worker gateway", async () => {
		let received: Request | undefined;
		const client = createPlatformWorkerNativeMetadataGatewayClientV1({
			baseUrl: "http://worker",
			serviceToken: "worker-token",
			fetch: async (input, init) => {
				received = new Request(String(input), init);
				return new Response(JSON.stringify(response), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});
		await expect(client.read(request)).resolves.toEqual(response);
		expect(received?.url).toBe(
			"http://worker/internal/platform-worker/v1/native-metadata",
		);
		expect(received?.headers.get("authorization")).toBe("Bearer worker-token");
	});

	it("fails closed on a non-success Worker response", async () => {
		const client = createPlatformWorkerNativeMetadataGatewayClientV1({
			baseUrl: "http://worker",
			serviceToken: "worker-token",
			fetch: async () => new Response("unavailable", { status: 503 }),
		});
		await expect(client.read(request)).rejects.toThrow(
			"PLATFORM_WORKER_UNAVAILABLE",
		);
	});

	it("allows current-confirmation round trips beyond ten seconds within the original request deadline", async () => {
		const startedAt = Date.now();
		const liveRequest = {
			...request,
			readStartedAt: startedAt,
			expiresAt: startedAt + 30_000,
		};
		const liveResponse = {
			...response,
			readStartedAt: liveRequest.readStartedAt,
			expiresAt: liveRequest.expiresAt,
		};
		const client = createPlatformWorkerNativeMetadataGatewayClientV1({
			baseUrl: "http://worker",
			serviceToken: "worker-token",
			fetch: async (_input, init) =>
				new Promise<Response>((resolve, reject) => {
					const abort = () => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					};
					const timer = setTimeout(() => {
						init?.signal?.removeEventListener("abort", abort);
						resolve(
							new Response(JSON.stringify(liveResponse), {
								headers: { "content-type": "application/json" },
							}),
						);
					}, 11_000);
					init?.signal?.addEventListener("abort", abort, { once: true });
					if (init?.signal?.aborted) abort();
				}),
		});
		await expect(
			client.read(liveRequest, AbortSignal.timeout(30_000)),
		).resolves.toEqual(liveResponse);
	}, 15_000);

	it("applies a transport deadline when Worker fetch stalls", async () => {
		const client = createPlatformWorkerNativeMetadataGatewayClientV1({
			baseUrl: "http://worker",
			serviceToken: "worker-token",
			transportTimeoutMs: 25,
			fetch: async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error("aborted")),
						{ once: true },
					);
				}),
		});
		const started = Date.now();
		await expect(client.read(request)).rejects.toThrow(
			"PLATFORM_WORKER_UNAVAILABLE",
		);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

it("retains permissive media and UTF-8 decoding at the Worker gateway", async () => {
	const changed = { ...response, traceId: "replacement-�" };
	const raw = new TextEncoder().encode(JSON.stringify(changed));
	const marker = raw.indexOf(0xef);
	const bytes = new Uint8Array([
		...raw.slice(0, marker),
		0xff,
		...raw.slice(marker + 3),
	]);
	const client = createPlatformWorkerNativeMetadataGatewayClientV1({
		baseUrl: "http://worker",
		serviceToken: "token",
		fetch: async () =>
			new Response(bytes, { headers: { "content-type": "text/plain" } }),
	});
	await expect(client.read(request)).resolves.toEqual(changed);
});

it.each([1_048_576, 1_048_577])(
	"bounds the streamed Worker response at %i bytes",
	async (size) => {
		let canceled = false;
		const json = JSON.stringify(response);
		const bytes = new TextEncoder().encode(
			json + " ".repeat(size - json.length),
		);
		const client = createPlatformWorkerNativeMetadataGatewayClientV1({
			baseUrl: "http://worker",
			serviceToken: "token",
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(bytes);
							if (size === 1_048_576) controller.close();
						},
						cancel() {
							canceled = true;
						},
					}),
				),
		});
		if (size === 1_048_576)
			await expect(client.read(request)).resolves.toEqual(response);
		else {
			await expect(client.read(request)).rejects.toThrow(
				"PLATFORM_WORKER_UNAVAILABLE",
			);
			expect(canceled).toBe(true);
		}
	},
);
