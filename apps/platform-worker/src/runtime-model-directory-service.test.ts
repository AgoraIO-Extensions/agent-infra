import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	createWorkerRuntimeModelDirectoryApp,
	createWorkerRuntimeModelDirectoryGrantSignerV1,
	createWorkerRuntimeModelDirectoryReaderV1,
} from "./index.js";

const request = {
	schemaVersion: 1 as const,
	requestId: "request-model-directory",
	traceId: "trace-model-directory",
	actorId: "user-1",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 2,
	deliveryFence: 7,
	hostSessionRef: "host-session-1",
};

const response = {
	schemaVersion: 1 as const,
	hostSessionRef: request.hostSessionRef,
	executionId: request.executionId,
	options: [
		{
			schemaVersion: 1 as const,
			modelOptionId: "model-primary",
			modelId: "provider/model-primary",
			displayName: "Primary",
			reasoningLevels: ["low", "medium"],
		},
	],
	current: { modelOptionId: "model-primary", reasoningLevel: "medium" },
};

describe("Worker model-directory service", () => {
	it("authenticates API dispatch and signs only at the Worker boundary", async () => {
		const keys = generateKeyPairSync("ed25519");
		const signGrant = createWorkerRuntimeModelDirectoryGrantSignerV1({
			issuer: "platform",
			keyId: "worker-key",
			privateKey: keys.privateKey,
			now: () => 1_800_000_000_000,
			id: () => "grant-model-directory",
		});
		const client = {
			modelDirectory: vi.fn().mockResolvedValue(response),
		};
		const reader = createWorkerRuntimeModelDirectoryReaderV1({
			resolveRuntimeHost: async () => client as never,
			signGrant,
		});
		const app = createWorkerRuntimeModelDirectoryApp({
			serviceToken: "worker-service-token",
			reader,
		});
		const denied = await app.request(
			new URL("http://worker.local/internal/worker/v1/model-directory"),
			{
				method: "POST",
				body: JSON.stringify(request),
			},
		);
		expect(denied.status).toBe(401);
		const accepted = await app.request(
			new URL("http://worker.local/internal/worker/v1/model-directory"),
			{
				method: "POST",
				headers: {
					authorization: "Bearer worker-service-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
			},
		);
		expect(accepted.status).toBe(200);
		expect(client.modelDirectory).toHaveBeenCalledOnce();
		const forwarded = client.modelDirectory.mock.calls[0]?.[0];
		expect(forwarded).toMatchObject({
			...request,
			grant: { format: "compact-jws" },
		});
	});

	it("rejects malformed dispatch before the reader", async () => {
		const reader = { read: vi.fn() };
		const app = createWorkerRuntimeModelDirectoryApp({
			serviceToken: "worker-service-token",
			reader,
		});
		const response = await app.request(
			new URL("http://worker.local/internal/worker/v1/model-directory"),
			{
				method: "POST",
				headers: {
					authorization: "Bearer worker-service-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ ...request, actorId: "" }),
			},
		);
		expect(response.status).toBe(400);
		expect(reader.read).not.toHaveBeenCalled();
	});
});
