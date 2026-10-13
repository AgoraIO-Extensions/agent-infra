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
});
