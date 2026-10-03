import { describe, expect, it } from "vitest";
import {
	createFakeModelAccessValidatorV1,
	createResponsesModelAccessValidatorV1,
} from "./access.js";
import { catalogFixture } from "./catalog.fixture.js";
import { ModelEndpointV1Schema } from "./index.js";

describe.each(["fake", "deployment"])("%s model access conformance", (kind) => {
	it("verifies the exact endpoint credential, model, streaming, tools and each reasoning level", async () => {
		const input = {
			endpoint: ModelEndpointV1Schema.parse(catalogFixture().endpoints[0]),
			modelId: "model-a",
			reasoningLevels: ["medium", "high"],
			credential: new TextEncoder().encode("synthetic-credential-a"),
		};
		const validator =
			kind === "fake"
				? createFakeModelAccessValidatorV1([
						{
							endpointId: "endpoint-a",
							modelId: "model-a",
							credential: "synthetic-credential-a",
							reasoningLevels: ["medium", "high"],
						},
					])
				: createResponsesModelAccessValidatorV1({
						fetch: async (url, init) => {
							expect(url).toBe(
								"https://models.example.test/team-a/v1/responses",
							);
							expect(new Headers(init?.headers).get("Authorization")).toBe(
								"Bearer synthetic-credential-a",
							);
							expect(init?.redirect).toBe("error");
							const request = JSON.parse(String(init?.body));
							return new Response(
								`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", model: request.model, reasoning: request.reasoning, output: [{ type: "function_call", name: "agent_infra_conformance", arguments: "{}", status: "completed" }] } })}\n\n`,
								{ headers: { "content-type": "text/event-stream" } },
							);
						},
					});
		await expect(
			validator.validate(input, { signal: AbortSignal.timeout(1000) }),
		).resolves.toBeUndefined();
	});
	it.each(["credential", "model", "reasoning", "capability"])(
		"fails closed for rejected %s without returning endpoint or credential material",
		async (failure) => {
			const endpoint = ModelEndpointV1Schema.parse(
				catalogFixture().endpoints[0],
			);
			const input = {
				endpoint:
					failure === "capability"
						? {
								...endpoint,
								capabilities: {
									...endpoint.capabilities,
									tools: false as unknown as true,
								},
							}
						: endpoint,
				modelId: failure === "model" ? "forbidden" : "model-a",
				reasoningLevels: [failure === "reasoning" ? "extreme" : "medium"],
				credential: new TextEncoder().encode(
					failure === "credential"
						? "synthetic-invalid-credential"
						: "synthetic-credential-a",
				),
			};
			const validator =
				kind === "fake"
					? createFakeModelAccessValidatorV1([
							{
								endpointId: "endpoint-a",
								modelId: "model-a",
								credential: "synthetic-credential-a",
								reasoningLevels: ["medium"],
							},
						])
					: createResponsesModelAccessValidatorV1({
							fetch: async () =>
								new Response(
									"synthetic-invalid-credential https://models.example.test",
									{ status: 403 },
								),
						});
			await expect(
				validator.validate(input, { signal: AbortSignal.timeout(1000) }),
			).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
		},
	);
});

it.each([
	"wrong model",
	"ignored reasoning",
	"no tool",
	"invalid stream",
	"redirect",
	"stalled",
	"oversized",
])("rejects a deployment response with %s", async (failure) => {
	const input = {
		endpoint: ModelEndpointV1Schema.parse(catalogFixture().endpoints[0]),
		modelId: "model-a",
		reasoningLevels: ["medium"],
		credential: new TextEncoder().encode("synthetic-credential-a"),
	};
	const validator = createResponsesModelAccessValidatorV1({
		fetch: async () => {
			if (failure === "redirect")
				return new Response(null, {
					status: 302,
					headers: { location: "https://unapproved.example.test" },
				});
			if (failure === "stalled")
				return new Response(new ReadableStream(), {
					headers: { "content-type": "text/event-stream" },
				});
			if (failure === "oversized")
				return new Response("x".repeat(1_048_577), {
					headers: { "content-type": "text/event-stream" },
				});
			const response = {
				status: "completed",
				model: failure === "wrong model" ? "wrong" : "model-a",
				reasoning: {
					effort: failure === "ignored reasoning" ? "low" : "medium",
				},
				output:
					failure === "no tool"
						? []
						: [
								{
									type: "function_call",
									name: "agent_infra_conformance",
									arguments: "{}",
									status: "completed",
								},
							],
			};
			return new Response(
				failure === "invalid stream"
					? "data: [DONE]\n\n"
					: `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	await expect(
		validator.validate(input, { signal: AbortSignal.timeout(30) }),
	).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
});
