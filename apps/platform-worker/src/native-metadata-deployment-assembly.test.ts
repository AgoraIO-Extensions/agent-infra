import { describe, expect, it, vi } from "vitest";
import { createPlatformNativeMetadataGatewayAssemblyV1 } from "./native-metadata-deployment-assembly.js";

const ports = {
	binding: { resolve: vi.fn(async () => null) },
	current: { check: vi.fn(async () => ({ outcome: "unavailable" as const })) },
	proofIssuer: {
		issue: vi.fn(async () => ({
			schemaVersion: 1 as const,
			format: "native-metadata-jws" as const,
			token: "proof",
		})),
	},
	transport: { resolve: vi.fn(async () => null) },
	port: 3010,
};

describe("native metadata deployment assembly", () => {
	it("builds the real Worker gateway app from deployment ports", async () => {
		const options = createPlatformNativeMetadataGatewayAssemblyV1({
			serviceToken: "worker-service-token",
			ports,
		});
		expect(options.port).toBe(3010);
		const response = await options.app.fetch(
			new Request("http://worker/internal/platform-worker/v1/native-metadata", {
				method: "POST",
				headers: {
					authorization: "Bearer worker-service-token",
					"content-type": "application/json",
				},
				body: "{}",
			}),
		);
		expect(response.status).toBe(400);
	});

	it("assembles the optional Platform API current checker", async () => {
		const request = {
			schemaVersion: 1 as const,
			readId: "read-assembly-client",
			selector: "status" as const,
			scope: {
				schemaVersion: 1 as const,
				principal: { kind: "user" as const, id: "user-assembly-client" },
				agentId: "agent-assembly-client",
				channelId: "web",
				conversationId: "conversation-assembly-client",
				executionId: "execution-assembly-client",
				sessionGeneration: 1,
				authorizationRevision: "authorization-assembly-client",
			},
			readStartedAt: 1_000,
			expiresAt: 20_000,
			requestId: "request-assembly-client",
			traceId: "trace-assembly-client",
			apiRequestSourceRef: "api-assembly-client",
		};
		const { apiRequestSourceRef: _source, ...identity } = request;
		const binding = {
			...identity,
			originalHostScopeRef: "host-assembly-client",
		};
		const currentCalls: unknown[] = [];
		const options = createPlatformNativeMetadataGatewayAssemblyV1({
			serviceToken: "worker-service-token",
			ports: {
				...ports,
				current: undefined,
				binding: { resolve: async () => binding },
				proofIssuer: {
					issue: async () => ({
						schemaVersion: 1 as const,
						format: "native-metadata-jws" as const,
						token: "proof-assembly-client",
					}),
				},
				transport: {
					resolve: async () => ({
						read: async () => ({
							...binding,
							projection: {
								selector: "status" as const,
								status: "active" as const,
								readAt: "2026-10-14T00:00:00.000Z",
							},
						}),
					}),
				},
				platformApiCurrent: {
					baseUrl: "http://platform-api.internal",
					serviceToken: "platform-api-service-token",
					fetch: async (_input, init) => {
						currentCalls.push({ input: _input, init });
						return new Response(
							JSON.stringify({
								outcome: "allowed",
								request: { ...binding, phase: "read_metadata" },
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						);
					},
				},
			},
		});
		const response = await options.app.fetch(
			new Request("http://worker/internal/platform-worker/v1/native-metadata", {
				method: "POST",
				headers: {
					authorization: "Bearer worker-service-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
			}),
		);
		expect(response.status).toBe(200);
		expect(currentCalls).toHaveLength(2);
		expect(
			(currentCalls[0] as { init: RequestInit }).init.headers,
		).toMatchObject({ authorization: "Bearer platform-api-service-token" });
	});

	it("keeps the gateway fail-closed when no current checker is configured", async () => {
		const options = createPlatformNativeMetadataGatewayAssemblyV1({
			serviceToken: "worker-service-token",
			ports: { ...ports, current: undefined },
		});
		const response = await options.app.fetch(
			new Request("http://worker/internal/platform-worker/v1/native-metadata", {
				method: "POST",
				headers: {
					authorization: "Bearer worker-service-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					schemaVersion: 1,
					readId: "read-assembly",
					selector: "status",
					scope: {
						schemaVersion: 1,
						principal: { kind: "user", id: "user-assembly" },
						agentId: "agent-assembly",
						channelId: "web",
						conversationId: "conversation-assembly",
						executionId: "execution-assembly",
						sessionGeneration: 1,
						authorizationRevision: "authorization-assembly",
					},
					readStartedAt: 1_000,
					expiresAt: 20_000,
					requestId: "request-assembly",
					traceId: "trace-assembly",
					apiRequestSourceRef: "api-assembly",
				}),
			}),
		);
		expect(response.status).toBe(503);
	});

	it("rejects an invalid deployment service token", () => {
		expect(() =>
			createPlatformNativeMetadataGatewayAssemblyV1({
				serviceToken: "",
				ports,
			}),
		).toThrow("Platform Worker service token is invalid");
	});
});
