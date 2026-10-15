import { describe, expect, it, vi } from "vitest";
import {
	createWorkerSavedKeyCandidatesApp,
	type WorkerSavedKeyCandidatesReaderV1,
} from "./saved-key-candidates-service.js";

const request = {
	schemaVersion: 1 as const,
	requestId: "request-saved-key",
	traceId: "trace-saved-key",
	actorId: "user-owner",
	agentId: "agent-1",
	configurationRevision: 7,
	keyVersion: 2,
};
const response = {
	schemaVersion: 1 as const,
	agentId: request.agentId,
	configurationRevision: request.configurationRevision,
	keyVersion: request.keyVersion,
	candidates: [
		{ endpointId: "relay", modelId: "model-a", reasoningLevels: ["high"] },
	],
};

describe("Worker saved-Key candidates app", () => {
	it("authenticates the API and returns only candidate metadata", async () => {
		const reader: WorkerSavedKeyCandidatesReaderV1 = {
			read: vi.fn().mockResolvedValue(response),
		};
		const app = createWorkerSavedKeyCandidatesApp({
			serviceToken: "worker-token",
			reader,
		});
		const result = await app.fetch(
			new Request("http://worker/internal/worker/v1/saved-key-candidates", {
				method: "POST",
				headers: {
					authorization: "Bearer worker-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
			}),
		);
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual(response);
		expect(reader.read).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: request.agentId }),
			expect.any(AbortSignal),
		);
	});

	it("rejects a caller that has no matching service token", async () => {
		const reader = { read: vi.fn() };
		const app = createWorkerSavedKeyCandidatesApp({
			serviceToken: "worker-token",
			reader,
		});
		const result = await app.fetch(
			new Request("http://worker/internal/worker/v1/saved-key-candidates", {
				method: "POST",
				headers: { authorization: "Bearer wrong" },
				body: JSON.stringify(request),
			}),
		);
		expect(result.status).toBe(401);
		expect(reader.read).not.toHaveBeenCalled();
	});

	it("rejects a response bound to another Agent or revision", async () => {
		const app = createWorkerSavedKeyCandidatesApp({
			serviceToken: "worker-token",
			reader: {
				read: vi.fn().mockResolvedValue({ ...response, agentId: "other" }),
			},
		});
		const result = await app.fetch(
			new Request("http://worker/internal/worker/v1/saved-key-candidates", {
				method: "POST",
				headers: {
					authorization: "Bearer worker-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
			}),
		);
		expect(result.status).toBe(503);
	});
});
