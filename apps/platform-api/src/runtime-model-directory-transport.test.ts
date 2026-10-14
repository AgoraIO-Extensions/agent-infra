import { describe, expect, it, vi } from "vitest";
import { createWorkerRuntimeModelDirectoryTransportV1 } from "./runtime-model-directory-transport.js";

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
	schemaVersion: 1,
	hostSessionRef: request.hostSessionRef,
	executionId: request.executionId,
	options: [
		{
			schemaVersion: 1,
			modelOptionId: "model-primary",
			modelId: "provider/model-primary",
			displayName: "Primary",
			reasoningLevels: ["low", "medium"],
		},
	],
	current: { modelOptionId: "model-primary", reasoningLevel: "medium" },
};

describe("API → Worker model-directory transport", () => {
	it("sends only the bound dispatch and authenticates the Worker", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify(response), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const transport = createWorkerRuntimeModelDirectoryTransportV1({
			baseUrl: "http://platform-worker.local",
			serviceToken: "worker-service-token",
			fetch: fetcher,
		});
		await expect(
			transport.read(request, new AbortController().signal),
		).resolves.toEqual(response);
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"http://platform-worker.local/internal/worker/v1/model-directory",
		);
		expect(init?.headers).toMatchObject({
			authorization: "Bearer worker-service-token",
		});
		expect(JSON.parse(init?.body as string)).toEqual(request);
	});

	it("rejects redirects, non-JSON and binding drift", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ ...response, executionId: "foreign" }), {
				status: 200,
				headers: { "content-type": "text/plain" },
			}),
		);
		const transport = createWorkerRuntimeModelDirectoryTransportV1({
			baseUrl: "http://platform-worker.local",
			serviceToken: "worker-service-token",
			fetch: fetcher,
		});
		await expect(
			transport.read(request, new AbortController().signal),
		).rejects.toThrow("PLATFORM_WORKER_MODEL_DIRECTORY_UNAVAILABLE");
	});
});
