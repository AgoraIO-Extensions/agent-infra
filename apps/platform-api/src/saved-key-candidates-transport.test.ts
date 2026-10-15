import { describe, expect, it } from "vitest";
import { createWorkerSavedKeyCandidatesTransportV1 } from "./saved-key-candidates-transport.js";

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
	agentId: "agent-1",
	configurationRevision: 7,
	keyVersion: 2,
	candidates: [
		{ endpointId: "relay", modelId: "model-a", reasoningLevels: ["high"] },
	],
};

describe("API saved-Key candidates transport", () => {
	it("uses the authenticated Worker endpoint and projects no plaintext", async () => {
		let capturedUrl: string | undefined;
		let capturedHeaders: Headers | undefined;
		let capturedBody: string | undefined;
		const transport = createWorkerSavedKeyCandidatesTransportV1({
			baseUrl: "http://platform-worker:3005",
			serviceToken: "worker-token",
			fetch: async (input, init) => {
				const request = new Request(input, init);
				capturedUrl = request.url;
				capturedHeaders = request.headers;
				capturedBody = await request.text();
				return Response.json(response);
			},
		});
		await expect(transport.read(request)).resolves.toEqual(response);
		expect(capturedUrl).toBe(
			"http://platform-worker:3005/internal/worker/v1/saved-key-candidates",
		);
		expect(capturedHeaders?.get("authorization")).toBe("Bearer worker-token");
		expect(JSON.parse(capturedBody ?? "null")).toEqual(request);
	});
});
