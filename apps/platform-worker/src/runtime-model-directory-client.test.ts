import { describe, expect, it, vi } from "vitest";
import { createWorkerRuntimeModelDirectoryClientV1 } from "./runtime-model-directory-client.js";

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
	grant: {
		schemaVersion: 1 as const,
		format: "compact-jws" as const,
		token: "header.payload.signature",
	},
};

function client(fetcher: typeof fetch) {
	return createWorkerRuntimeModelDirectoryClientV1({
		baseUrl: "http://runtime.local",
		serviceToken: "worker-service-token",
		fetch: fetcher,
	});
}

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

describe("Worker Runtime model-directory client", () => {
	it("posts the bound request to the authenticated RuntimeHost route", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify(response), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(client(fetcher).read(request)).resolves.toEqual(response);
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"http://runtime.local/internal/runtime/v1/model-directory",
		);
		expect(init?.headers).toMatchObject({
			authorization: "Bearer worker-service-token",
		});
		expect(JSON.parse(init?.body as string)).toEqual(request);
	});

	it.each([
		{ hostSessionRef: "foreign-host" },
		{ executionId: "foreign-execution" },
	])(
		"rejects a response that crosses the Session binding: %j",
		async (patch) => {
			const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
				new Response(JSON.stringify({ ...response, ...patch }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
			await expect(client(fetcher).read(request)).rejects.toThrow(
				"RUNTIME_MODEL_DIRECTORY_UNAVAILABLE",
			);
		},
	);

	it("fails closed on non-JSON or oversized responses", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("not-json", {
				status: 200,
				headers: { "content-type": "text/plain" },
			}),
		);
		await expect(client(fetcher).read(request)).rejects.toThrow(
			"RUNTIME_MODEL_DIRECTORY_UNAVAILABLE",
		);
	});
});
