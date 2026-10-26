import { describe, expect, it, vi } from "vitest";
import {
	createAgentDefaultRelayKeyCandidateReaderV1,
	createAgentDefaultRelayKeyModelVerifierV1,
} from "./agent-default-candidates.js";
import { messagesStreamFixture } from "./messages-stream.fixture.js";

const endpoints = [
	{
		endpointId: "responses",
		baseUrl: "https://relay.example.test/v1",
		protocol: "openai-responses-v1" as const,
	},
	{
		endpointId: "messages",
		baseUrl: "https://relay.example.test",
		protocol: "anthropic-messages-v1" as const,
	},
];
const bindings = (["codex", "claude", "acp", "pi"] as const).map((driver) => ({
	templateId: driver,
	imageDigest: `sha256:${"a".repeat(64)}`,
	driver,
	protocol:
		driver === "codex"
			? ("openai-responses-v1" as const)
			: ("anthropic-messages-v1" as const),
}));
const source = (templateId: string) => ({
	kind: "standard" as const,
	templateId,
	imageDigest: bindings[0].imageDigest,
});
function fixture(relayEndpoints = endpoints) {
	const fetcher = vi.fn<typeof fetch>(async (url) => {
		if (String(url).endsWith("/models"))
			return Response.json({ data: [{ id: "claude-opus-5" }] });
		const stream = String(url).endsWith("/responses")
			? `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "function_call", name: "agent_infra_conformance", arguments: "{}", status: "completed" }] } })}\n\n`
			: messagesStreamFixture();
		return new Response(stream, {
			headers: { "content-type": "text/event-stream" },
		});
	});
	const input = {
		relayEndpoints,
		templateBindings: bindings,
		fetch: fetcher,
		modelCatalog: {
			revision: "catalog-a",
			load: async () => ({
				schemaVersion: 1,
				revision: "catalog-a",
				validUntil: Date.now() + 60000,
				endpoints: [
					...endpoints,
					{ ...endpoints[0], endpointId: "unapproved" },
				].map((endpoint) => ({
					...endpoint,
					origin: "https://relay.example.test",
					authentication: "bearer",
					security: { tls: "verify-peer", redirects: "reject" },
					capabilities: {
						streaming: true,
						tools: true,
						reasoningLevels: ["low"],
					},
					allowedModels: null,
					available: true,
				})),
			}),
		},
	};
	return {
		fetcher,
		read: createAgentDefaultRelayKeyCandidateReaderV1({
			...input,
			validateKey: async () => "valid",
		}),
		verify: createAgentDefaultRelayKeyModelVerifierV1(input),
	};
}
const combo = (endpointId: string) => ({
	endpointId,
	modelId: "claude-opus-5",
	reasoningLevel: "low",
});

describe("deployment-approved Relay endpoints", () => {
	it.each(bindings)(
		"discovers and verifies $driver with its approved protocol",
		async (binding) => {
			const f = fixture();
			const configuration = { source: source(binding.templateId) };
			const endpoint = endpoints[binding.driver === "codex" ? 0 : 1];
			await expect(
				f.read("synthetic-key", configuration, AbortSignal.timeout(1000)),
			).resolves.toMatchObject([{ endpointId: endpoint.endpointId }]);
			await expect(
				f.verify(
					"synthetic-key",
					configuration,
					[combo(endpoint.endpointId)],
					AbortSignal.timeout(1000),
				),
			).resolves.toBe("verified");
			expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([
				`${endpoint.baseUrl}/models`,
				`${endpoint.baseUrl}${binding.driver === "codex" ? "/responses" : "/v1/messages?beta=true"}`,
			]);
		},
	);

	it.each(["endpointId", "baseUrl", "protocol"] as const)(
		"fails closed when approved %s differs from Catalog",
		async (field) => {
			const endpoint = { ...endpoints[0] };
			if (field === "endpointId") endpoint.endpointId = "missing";
			if (field === "baseUrl")
				endpoint.baseUrl = "https://other.example.test/v1";
			if (field === "protocol") endpoint.protocol = "anthropic-messages-v1";
			const f = fixture([endpoint]);
			await expect(
				f.read(
					"synthetic-key",
					{ source: source("codex") },
					AbortSignal.timeout(1000),
				),
			).resolves.toEqual([]);
			await expect(
				f.verify(
					"synthetic-key",
					{ source: source("codex") },
					[combo("responses")],
					AbortSignal.timeout(1000),
				),
			).resolves.toBe("incompatible");
			expect(f.fetcher).not.toHaveBeenCalled();
		},
	);

	it("never probes an unapproved Catalog endpoint or an unknown image", async () => {
		const f = fixture();
		await expect(
			f.verify(
				"synthetic-key",
				{ source: source("codex") },
				[combo("unapproved")],
				AbortSignal.timeout(1000),
			),
		).resolves.toBe("incompatible");
		const changed = {
			source: { ...source("codex"), imageDigest: `sha256:${"b".repeat(64)}` },
		};
		await expect(
			f.read("synthetic-key", changed, AbortSignal.timeout(1000)),
		).rejects.toThrow();
		await expect(
			f.verify(
				"synthetic-key",
				changed,
				[combo("responses")],
				AbortSignal.timeout(1000),
			),
		).resolves.toBe("unavailable");
		expect(f.fetcher).not.toHaveBeenCalled();
	});
});
