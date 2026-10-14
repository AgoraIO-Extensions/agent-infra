import { describe, expect, it } from "vitest";
import {
	createProductionNativeMetadataReaderFromWorkerV1,
	createProductionNativeMetadataReaderV1,
} from "./deployment.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-production",
	displayName: "Production User",
	accountStatus: "active" as const,
	organizationIds: [],
	roles: ["employee" as const],
	authorizationRevision: "auth-production",
};

const binding = {
	schemaVersion: 1 as const,
	readId: "read-production",
	selector: "commands" as const,
	scope: {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: identity.userId },
		agentId: "agent-production",
		channelId: "web",
		conversationId: "conversation-production",
		executionId: "execution-production",
		sessionGeneration: 1,
		authorizationRevision: identity.authorizationRevision,
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "request-production",
	traceId: "trace-production",
	originalHostScopeRef: "host-production",
};

const response = {
	...binding,
	projection: {
		selector: "commands" as const,
		revision: "a".repeat(64),
		capabilities: [],
	},
};

describe("production native metadata assembly", () => {
	it("composes the scope resolver with the Worker gateway", async () => {
		let called = false;
		const reader = createProductionNativeMetadataReaderV1({
			resolveRequest: async () => binding,
			gateway: {
				read: async (request) => {
					called = true;
					expect(request).not.toHaveProperty("proof");
					return response;
				},
			},
		});
		await expect(
			reader.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"commands",
			),
		).resolves.toEqual(response.projection);
		expect(called).toBe(true);
	});

	it("keeps the production projection unavailable when scope resolution fails", async () => {
		const reader = createProductionNativeMetadataReaderV1({
			resolveRequest: async () => null,
			gateway: { read: async () => response },
		});
		await expect(
			reader.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"commands",
			),
		).resolves.toBeNull();
	});

	it("assembles the fixed Worker ingress without exposing a Runtime target", async () => {
		let called = false;
		const reader = createProductionNativeMetadataReaderFromWorkerV1({
			resolveRequest: async () => binding,
			worker: {
				baseUrl: "http://worker.example.test",
				serviceToken: "worker-service-token",
				fetch: async (input, init) => {
					called = true;
					expect(String(input)).toBe(
						"http://worker.example.test/internal/platform-worker/v1/native-metadata",
					);
					expect(String(init?.body)).not.toContain("runtime");
					return new Response(JSON.stringify(response), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				},
			},
		});
		await expect(
			reader.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"commands",
			),
		).resolves.toEqual(response.projection);
		expect(called).toBe(true);
	});
});
