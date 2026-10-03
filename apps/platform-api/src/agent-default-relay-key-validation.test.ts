import { describe, expect, it, vi } from "vitest";
import { agentConfigurationConformanceRecordV1 as configuration } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import { createAgentDefaultRelayKeyCandidatesV1 } from "./agent-default-relay-key-validation.ts";

const key = "SYNTHETIC_DEFAULT_RELAY_KEY";
const binding = {
	templateId: "template_01",
	imageDigest: `sha256:${"a".repeat(64)}`,
	driver: "codex" as const,
	protocol: "openai-responses-v1" as const,
};
function fixture(mode = "valid") {
	const fetcher = vi.fn<typeof fetch>(async (url, options) => {
		expect(options?.redirect).toBe("error");
		if (String(url).endsWith("/billing"))
			return Response.json(
				{
					object: "sub2api.key_billing",
					schema_version: 1,
					billing_scope: "token",
				},
				{ status: mode === "invalid key" ? 401 : 200 },
			);
		if (mode === "redirect") return new Response(null, { status: 302 });
		if (mode === "unavailable") throw new Error(key);
		return Response.json(
			mode === "malformed"
				? { data: [{ id: key + "!" }] }
				: { data: [{ id: "gpt-5" }, { id: "hidden" }] },
		);
	});
	const candidates = createAgentDefaultRelayKeyCandidatesV1({
		validation: {
			profile: "sub2api-key-billing-v1",
			billingUrl: "https://sub2api.la3.agoralab.co/v1/sub2api/billing",
			fetch: fetcher,
		},
		templateBindings: [binding],
		modelCatalog: {
			revision: "catalog_3",
			load: async () => ({
				schemaVersion: 1,
				revision: "catalog_3",
				validUntil: mode === "stale" ? 1 : Date.now() + 60000,
				endpoints: [
					{
						endpointId: "endpoint_01",
						baseUrl: "https://relay.example.test/v1",
						origin: "https://relay.example.test",
						protocol:
							mode === "incompatible"
								? "anthropic-messages-v1"
								: "openai-responses-v1",
						authentication: "bearer",
						security: { tls: "verify-peer", redirects: "reject" },
						capabilities: {
							streaming: true,
							tools: true,
							reasoningLevels: ["low"],
						},
						allowedModels: ["gpt-5"],
						available: true,
					},
				],
			}),
		},
	});
	return { candidates, fetcher };
}
describe("default Key visibility with controlled Relay responses", () => {
	it("intersects Key-visible models, catalog policy and exact template protocol", async () => {
		expect(await fixture().candidates(key, configuration)).toEqual([
			{ endpointId: "endpoint_01", modelId: "gpt-5", reasoningLevels: ["low"] },
		]);
		expect(
			await fixture("incompatible").candidates(key, configuration),
		).toEqual([]);
	});
	it.each(["invalid key", "redirect", "unavailable", "malformed", "stale"])(
		"rejects %s with sanitized errors",
		async (mode) => {
			await expect(
				fixture(mode).candidates(key, configuration),
			).rejects.toThrow("Agent default Relay Key operation failed");
		},
	);
	it("revalidates the exact template and image rather than keeping old compatible choices", async () => {
		for (const source of [
			{ ...configuration.source, templateId: "changed" },
			{ ...configuration.source, imageDigest: `sha256:${"b".repeat(64)}` },
		]) {
			const f = fixture();
			await expect(
				f.candidates(key, { ...configuration, source }),
			).rejects.toThrow("Agent default Relay Key operation failed");
			expect(f.fetcher.mock.calls).toHaveLength(1);
		}
	});
});
