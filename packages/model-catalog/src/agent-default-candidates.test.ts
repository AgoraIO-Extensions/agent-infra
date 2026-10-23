import { describe, expect, it, vi } from "vitest";
import {
	createAgentDefaultRelayKeyCandidateReaderV1,
	createAgentDefaultRelayKeyModelVerifierV1,
	standardTemplateReasoningLevelsV1,
} from "./agent-default-candidates.js";
import { messagesStreamFixture } from "./messages-stream.fixture.js";

// ADR-0030：保存时按模板协议对每个模型与档位做一次真实请求。
const source = {
	kind: "standard" as const,
	templateId: "template-claude",
	imageDigest: `sha256:${"c".repeat(64)}`,
	admissionRevision: "image-policy-1",
	allowedEnvironmentKeys: [],
	allowedSecretKeys: [],
	platformManagedKeys: [],
	connectionEnabled: false,
};
const binding = {
	templateId: source.templateId,
	imageDigest: source.imageDigest,
	driver: "claude" as const,
	protocol: "anthropic-messages-v1" as const,
};
function verifier(fetcher: typeof fetch) {
	return createAgentDefaultRelayKeyModelVerifierV1({
		relayEndpointId: "relay",
		relayBaseUrl: "https://relay.example.test/anthropic",
		templateBindings: [binding],
		fetch: fetcher,
		modelCatalog: {
			revision: "catalog-a",
			load: async () => ({
				schemaVersion: 1,
				revision: "catalog-a",
				validUntil: Date.now() + 60_000,
				endpoints: [
					{
						endpointId: "relay",
						baseUrl: "https://relay.example.test/anthropic",
						origin: "https://relay.example.test",
						protocol: "anthropic-messages-v1",
						authentication: "bearer",
						security: { tls: "verify-peer", redirects: "reject" },
						capabilities: {
							streaming: true,
							tools: true,
							reasoningLevels: ["high"],
						},
						allowedModels: null,
						available: true,
					},
				],
			}),
		},
	});
}
const combo = (reasoningLevel: string) => ({
	endpointId: "relay",
	modelId: "claude-opus-5",
	reasoningLevel,
});

function candidateReader(
	fetcher: typeof fetch,
	allowedModels: readonly string[] | null,
) {
	return createAgentDefaultRelayKeyCandidateReaderV1({
		modelCatalog: {
			revision: "catalog-a",
			load: async () => ({
				schemaVersion: 1,
				revision: "catalog-a",
				validUntil: Date.now() + 60_000,
				endpoints: [
					{
						endpointId: "relay",
						baseUrl: "https://relay.example.test/anthropic",
						origin: "https://relay.example.test",
						protocol: "anthropic-messages-v1",
						authentication: "bearer",
						security: { tls: "verify-peer", redirects: "reject" },
						capabilities: {
							streaming: true,
							tools: true,
							reasoningLevels: ["high"],
						},
						allowedModels,
						available: true,
					},
				],
			}),
		},
		templateBindings: [binding],
		relayEndpointId: "relay",
		relayBaseUrl: "https://relay.example.test/anthropic",
		fetch: fetcher,
		validateKey: async () => "valid",
	});
}

describe("Agent default Relay Key model verification (ADR-0030)", () => {
	it("fixes the offered reasoning levels for every model", () => {
		expect(standardTemplateReasoningLevelsV1).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(Object.isFrozen(standardTemplateReasoningLevelsV1)).toBe(true);
	});

	it("uses the Messages protocol for a Claude-profile template", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(messagesStreamFixture(), {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		await expect(
			verifier(fetcher)(
				"synthetic-key",
				{ source },
				standardTemplateReasoningLevelsV1.map(combo),
				AbortSignal.timeout(1000),
			),
		).resolves.toBe("verified");
		expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
			"https://relay.example.test/anthropic/v1/messages?beta=true",
			"https://relay.example.test/anthropic/v1/messages?beta=true",
			"https://relay.example.test/anthropic/v1/messages?beta=true",
			"https://relay.example.test/anthropic/v1/messages?beta=true",
			"https://relay.example.test/anthropic/v1/messages?beta=true",
		]);
		expect(
			fetcher.mock.calls.map(
				([, init]) => JSON.parse(String(init?.body)).output_config.effort,
			),
		).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it.each(["xhigh", "max"])(
		"rejects %s when the upstream rejects the model/effort pair",
		async (level) => {
			const fetcher = vi.fn<typeof fetch>(
				async () => new Response(null, { status: 400 }),
			);
			await expect(
				verifier(fetcher)(
					"synthetic-key",
					{ source },
					[combo(level)],
					AbortSignal.timeout(1000),
				),
			).resolves.toBe("incompatible");
			expect(fetcher).toHaveBeenCalledOnce();
			expect(
				JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).output_config
					.effort,
			).toBe(level);
		},
	);

	it("keeps all upstream models and exposes the five standard effort levels", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "claude-opus-5" },
							{ id: "gpt-5.6-sol" },
							{ id: "deepseek-chat" },
						],
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const reader = candidateReader(fetcher, null);
		await expect(
			reader("synthetic-key", { source }, AbortSignal.timeout(1000)),
		).resolves.toEqual([
			{
				endpointId: "relay",
				modelId: "claude-opus-5",
				reasoningLevels: [...standardTemplateReasoningLevelsV1],
			},
			{
				endpointId: "relay",
				modelId: "gpt-5.6-sol",
				reasoningLevels: [...standardTemplateReasoningLevelsV1],
			},
			{
				endpointId: "relay",
				modelId: "deepseek-chat",
				reasoningLevels: [...standardTemplateReasoningLevelsV1],
			},
		]);
	});

	it("still applies a non-null deployment model allowlist", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(
					JSON.stringify({
						data: [{ id: "claude-opus-5" }, { id: "gpt-5.6-sol" }],
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const reader = candidateReader(fetcher, ["claude-opus-5"]);
		await expect(
			reader("synthetic-key", { source }, AbortSignal.timeout(1000)),
		).resolves.toEqual([
			{
				endpointId: "relay",
				modelId: "claude-opus-5",
				reasoningLevels: [...standardTemplateReasoningLevelsV1],
			},
		]);
	});

	it("does not probe a different template or image", async () => {
		const fetcher = vi.fn<typeof fetch>();
		await expect(
			verifier(fetcher)(
				"synthetic-key",
				{ source: { ...source, imageDigest: `sha256:${"d".repeat(64)}` } },
				[combo("low")],
				AbortSignal.timeout(1000),
			),
		).resolves.toBe("unavailable");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects more pairs than the bounded verification allows without a request", async () => {
		const fetcher = vi.fn<typeof fetch>();
		await expect(
			verifier(fetcher)(
				"synthetic-key",
				{ source },
				Array.from({ length: 385 }, (_, index) => ({
					endpointId: "relay",
					modelId: `model-${index}`,
					reasoningLevel: "low",
				})),
				AbortSignal.timeout(1000),
			),
		).resolves.toBe("incompatible");
		expect(fetcher).not.toHaveBeenCalled();
	});
});
