import { describe, expect, it, vi } from "vitest";
import { agentConfigurationConformanceRecordV1 as configuration } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import { createAgentDefaultRelayKeyCandidatesV1 } from "./agent-default-relay-key-validation.ts";

const key = "SYNTHETIC_DEFAULT_RELAY_KEY";
const binding = {
	templateId: "template_01",
	imageDigest: `sha256:${"a".repeat(64)}`,
	driver: "codex" as const,
	// ADR-0029 之前要求的模板级档位：兼容读取，但不再收窄候选。
	reasoningLevels: ["low"],
	protocol: "openai-responses-v1" as const,
};
const completedToolCall = [
	`data: ${JSON.stringify({ type: "response.created" })}`,
	"",
	`data: ${JSON.stringify({
		type: "response.completed",
		response: {
			output: [
				{
					type: "function_call",
					name: "agent_infra_conformance",
					arguments: "{}",
					status: "completed",
				},
			],
		},
	})}`,
	"",
	"",
].join("\n");
function fixture(
	mode = "valid",
	options: {
		allowedModels?: readonly string[] | null;
		responses?: (body: Record<string, unknown>) => Response;
	} = {},
) {
	const fetcher = vi.fn<typeof fetch>(async (url, init) => {
		expect(init?.redirect).toBe("error");
		if (String(url).endsWith("/billing"))
			return Response.json(
				{
					object: "sub2api.key_billing",
					schema_version: 1,
					billing_scope: "token",
				},
				{ status: mode === "invalid key" ? 401 : 200 },
			);
		if (String(url).endsWith("/responses")) {
			const body = JSON.parse(String(init?.body));
			if (options.responses) return options.responses(body);
			return new Response(completedToolCall, {
				headers: { "content-type": "text/event-stream" },
			});
		}
		if (mode === "redirect") return new Response(null, { status: 302 });
		if (mode === "unavailable") throw new Error(key);
		return Response.json(
			mode === "malformed"
				? { data: [{ id: `${key}!` }] }
				: { data: [{ id: "gpt-5" }, { id: "hidden" }] },
		);
	});
	const relay = createAgentDefaultRelayKeyCandidatesV1({
		relayEndpointId: "endpoint_01",
		relayBaseUrl: "https://relay.example.test/v1",
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
						baseUrl:
							mode === "different route"
								? "https://relay.example.test/other"
								: "https://relay.example.test/v1",
						origin: "https://relay.example.test",
						protocol:
							mode === "incompatible"
								? "anthropic-messages-v1"
								: "openai-responses-v1",
						...(mode === "incompatible" ? { authentication: "bearer" } : {}),
						security: { tls: "verify-peer", redirects: "reject" },
						capabilities: {
							streaming: true,
							tools: true,
							reasoningLevels: ["low", "high"],
						},
						allowedModels:
							options.allowedModels === undefined
								? ["gpt-5"]
								: options.allowedModels,
						available: true,
					},
				],
			}),
		},
	});
	return { candidates: relay.candidates, verify: relay.verify, fetcher };
}
const fixedLevels = ["low", "medium", "high"];
describe("default Key visibility with controlled Relay responses", () => {
	it("offers the fixed levels for every Key-visible model in the exact template protocol (ADR-0029)", async () => {
		expect(await fixture().candidates(key, configuration)).toEqual([
			{
				endpointId: "endpoint_01",
				modelId: "gpt-5",
				reasoningLevels: fixedLevels,
			},
		]);
		expect(
			await fixture("incompatible").candidates(key, configuration),
		).toEqual([]);
	});
	it("does not narrow candidates when the deployment sets no allowedModels (ADR-0029)", async () => {
		expect(
			await fixture("valid", { allowedModels: null }).candidates(
				key,
				configuration,
			),
		).toEqual([
			{
				endpointId: "endpoint_01",
				modelId: "gpt-5",
				reasoningLevels: fixedLevels,
			},
			{
				endpointId: "endpoint_01",
				modelId: "hidden",
				reasoningLevels: fixedLevels,
			},
		]);
	});
	it("never sends the submitted Key to another catalog route", async () => {
		const f = fixture("different route");
		expect(await f.candidates(key, configuration)).toEqual([]);
		expect(f.fetcher.mock.calls).toHaveLength(1);
	});

	it.each(["invalid key", "redirect", "unavailable", "malformed", "stale"])(
		"rejects %s with sanitized errors",
		async (mode) => {
			await expect(
				fixture(mode).candidates(key, configuration),
			).rejects.toThrow("Agent default Relay Key operation failed");
		},
	);
	it("preserves invalid Key classification for the API write path", async () => {
		await expect(
			fixture("invalid key").candidates(key, configuration),
		).rejects.toMatchObject({ code: "invalid_input" });
	});
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

describe("save-time verification with the default Key (ADR-0029)", () => {
	const combo = (reasoningLevel: string, modelId = "gpt-5") => ({
		endpointId: "endpoint_01",
		modelId,
		reasoningLevel,
	});
	it("sends one bounded Responses request per pair to the approved endpoint only", async () => {
		const f = fixture();
		await expect(
			f.verify(key, configuration, [combo("low"), combo("medium")]),
		).resolves.toBeUndefined();
		const probes = f.fetcher.mock.calls.filter(([url]) =>
			String(url).endsWith("/responses"),
		);
		expect(probes.map(([url]) => String(url))).toEqual([
			"https://relay.example.test/v1/responses",
			"https://relay.example.test/v1/responses",
		]);
		expect(
			probes.map(([, init]) => {
				const body = JSON.parse(String(init?.body));
				return [body.model, body.reasoning.effort, body.store, body.stream];
			}),
		).toEqual([
			["gpt-5", "low", false, true],
			["gpt-5", "medium", false, true],
		]);
		expect(new Headers(probes[0]?.[1]?.headers).get("authorization")).toBe(
			`Bearer ${key}`,
		);
	});
	it("does not require the Relay to echo the model or effort", async () => {
		await expect(
			fixture().verify(key, configuration, [combo("high", "alias-model")]),
		).resolves.toBeUndefined();
	});
	it.each([
		[400, "model_unsupported"],
		[404, "model_unsupported"],
		[401, "invalid_input"],
		[403, "invalid_input"],
		[429, "unavailable"],
		[503, "unavailable"],
	] as const)("maps HTTP %s to %s", async (status, code) => {
		const f = fixture("valid", {
			responses: () => Response.json({ error: { message: key } }, { status }),
		});
		const failure = await f
			.verify(key, configuration, [combo("high")])
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({ code });
		expect(String(failure)).not.toContain(key);
	});
	it.each([
		[
			"a failed stream",
			`data: ${JSON.stringify({ type: "response.failed" })}\n\n`,
		],
		[
			"a completion without the conformance tool call",
			`data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
		],
	])("rejects %s as an incompatible model", async (_name, stream) => {
		const f = fixture("valid", {
			responses: () =>
				new Response(stream, {
					headers: { "content-type": "text/event-stream" },
				}),
		});
		await expect(
			f.verify(key, configuration, [combo("high")]),
		).rejects.toMatchObject({ code: "model_unsupported" });
	});
	it("rejects a pair on an endpoint the deployment did not approve", async () => {
		const f = fixture();
		await expect(
			f.verify(key, configuration, [
				{ endpointId: "other", modelId: "gpt-5", reasoningLevel: "high" },
			]),
		).rejects.toMatchObject({ code: "model_unsupported" });
		expect(
			f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/responses")),
		).toBe(false);
	});
	it("stops at the first failing pair and probes each pair once", async () => {
		let calls = 0;
		const f = fixture("valid", {
			responses: (body) => {
				calls += 1;
				return (body.reasoning as { effort: string }).effort === "medium"
					? Response.json({}, { status: 400 })
					: new Response(completedToolCall, {
							headers: { "content-type": "text/event-stream" },
						});
			},
		});
		await expect(
			f.verify(key, configuration, [
				combo("low"),
				combo("low"),
				combo("medium"),
				combo("high"),
			]),
		).rejects.toMatchObject({ code: "model_unsupported" });
		expect(calls).toBe(2);
	});
});
