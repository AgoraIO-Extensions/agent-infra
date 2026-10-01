import { describe, expect, it, vi } from "vitest";
import { catalogFixture } from "./catalog.fixture.js";
import {
	type AgentDefaultModelAdmissionPortsV1,
	admitAgentDefaultModelsV1,
} from "./index.js";

function admissionInput(overrides: Record<string, unknown> = {}) {
	const catalog = catalogFixture();
	const ports: AgentDefaultModelAdmissionPortsV1 = {
		loadCatalog: vi.fn(async () => catalog),
		listVisibleModelIds: vi.fn(async () => ["model-a"]),
	};
	return {
		requested: {
			catalogRevision: "catalog-a",
			defaultOptionId: "option-a",
			defaultReasoningLevel: "medium",
			options: [
				{
					optionId: "option-a",
					endpointId: "endpoint-a",
					modelId: "model-a",
					reasoningLevels: ["medium"],
				},
			],
		},
		keyBinding: { agentId: "agent-a", keyVersion: 2 },
		admittedSource: {
			kind: "standard" as const,
			templateId: "template-a",
			imageDigest: "sha256:a",
		},
		template: {
			templateId: "template-a",
			imageDigest: "sha256:a",
			driver: "codex" as const,
			protocol: "openai-responses-v1" as const,
			reasoningLevels: ["medium", "high"],
		},
		relayEndpointId: "endpoint-a",
		relayBaseUrl: catalog.endpoints[0]?.baseUrl ?? "",
		ports,
		signal: AbortSignal.timeout(1000),
		...overrides,
	};
}

describe("Agent default Key model admission", () => {
	it("returns a credential-free V4 configuration from one approved catalog and visible model set", async () => {
		const input = admissionInput();
		const result = await admitAgentDefaultModelsV1(input);
		expect(result).toEqual({
			catalogRevision: "catalog-a",
			runtime: {
				schemaVersion: 4,
				configVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
				defaultModelOptionId: "option-a",
				defaultReasoningLevel: "medium",
				modelOptions: [
					{
						modelOptionId: "option-a",
						endpoint: "https://models.example.test/team-a/v1",
						model: "model-a",
						reasoningLevels: ["medium"],
						protocol: "openai-responses-v1",
						authentication: "bearer",
					},
				],
			},
		});
		expect(input.ports.loadCatalog).toHaveBeenCalledOnce();
		expect(input.ports.listVisibleModelIds).toHaveBeenCalledOnce();
		expect(input.ports.listVisibleModelIds).toHaveBeenCalledWith(
			{ agentId: "agent-a", keyVersion: 2 },
			input.signal,
		);
		expect(JSON.stringify(result)).not.toMatch(/credential|secret|keyId/i);
	});

	it.each([
		[
			"stale catalog",
			{
				ports: {
					loadCatalog: async () => ({ ...catalogFixture(), validUntil: 1 }),
					listVisibleModelIds: async () => ["model-a"],
				},
			},
		],
		[
			"catalog revision drift",
			{
				requested: {
					...admissionInput().requested,
					catalogRevision: "catalog-b",
				},
			},
		],
		[
			"unseen model",
			{
				ports: {
					loadCatalog: async () => catalogFixture(),
					listVisibleModelIds: async () => ["model-b"],
				},
			},
		],
		[
			"unapproved Relay route",
			{ relayBaseUrl: "https://other.example.test/v1" },
		],
		[
			"wrong template",
			{ template: { ...admissionInput().template, imageDigest: "sha256:b" } },
		],
		[
			"unsupported Driver",
			{
				template: {
					...admissionInput().template,
					protocol: "anthropic-messages-v1" as const,
				},
			},
		],
		[
			"unsupported reasoning",
			{
				requested: {
					...admissionInput().requested,
					options: [
						{
							...admissionInput().requested.options[0],
							reasoningLevels: ["low"],
						},
					],
				},
			},
		],
		[
			"unsupported template reasoning",
			{
				template: {
					...admissionInput().template,
					reasoningLevels: ["high"],
				},
			},
		],
		[
			"invalid default",
			{
				requested: {
					...admissionInput().requested,
					defaultOptionId: "missing",
				},
			},
		],
		[
			"legacy per-model credential",
			{
				requested: {
					...admissionInput().requested,
					options: [
						{
							...admissionInput().requested.options[0],
							credential: "synthetic-secret",
						},
					],
				},
			},
		],
		[
			"duplicate model option",
			{
				requested: {
					...admissionInput().requested,
					options: [
						...admissionInput().requested.options,
						...admissionInput().requested.options,
					],
				},
			},
		],
	])(
		"rejects %s without disclosing admission material",
		async (_name, overrides) => {
			await expect(
				admitAgentDefaultModelsV1(admissionInput(overrides)),
			).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
		},
	);

	it("rejects a model excluded by the approved endpoint", async () => {
		const snapshot = catalogFixture();
		const endpoint = snapshot.endpoints[0];
		if (!endpoint) throw new Error("fixture endpoint missing");
		await expect(
			admitAgentDefaultModelsV1(
				admissionInput({
					ports: {
						loadCatalog: async () => ({
							...snapshot,
							endpoints: [{ ...endpoint, allowedModels: ["model-b"] }],
						}),
						listVisibleModelIds: async () => ["model-a"],
					},
				}),
			),
		).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	});

	it("changes the configuration version with admitted content, not Key replacement", async () => {
		const original = await admitAgentDefaultModelsV1(admissionInput());
		const newKey = await admitAgentDefaultModelsV1(
			admissionInput({
				keyBinding: { agentId: "agent-a", keyVersion: 3 },
			}),
		);
		const changedDefault = await admitAgentDefaultModelsV1(
			admissionInput({
				requested: {
					...admissionInput().requested,
					defaultReasoningLevel: "high",
					options: [
						{
							...admissionInput().requested.options[0],
							reasoningLevels: ["medium", "high"],
						},
					],
				},
			}),
		);
		expect(newKey.runtime.configVersion).toBe(original.runtime.configVersion);
		expect(changedDefault.runtime.configVersion).not.toBe(
			original.runtime.configVersion,
		);
	});

	it("uses the same configuration version for reordered options and reasoning levels", async () => {
		const firstOption = {
			...admissionInput().requested.options[0],
			reasoningLevels: ["medium", "high"],
		};
		const secondOption = { ...firstOption, optionId: "option-B" };
		const first = await admitAgentDefaultModelsV1(
			admissionInput({
				requested: {
					...admissionInput().requested,
					options: [firstOption, secondOption],
				},
			}),
		);
		const reordered = await admitAgentDefaultModelsV1(
			admissionInput({
				requested: {
					...admissionInput().requested,
					options: [
						{ ...secondOption, reasoningLevels: ["high", "medium"] },
						{ ...firstOption, reasoningLevels: ["high", "medium"] },
					],
				},
			}),
		);
		expect(reordered.runtime).toEqual(first.runtime);
	});

	it("redacts Relay visibility failures", async () => {
		await expect(
			admitAgentDefaultModelsV1(
				admissionInput({
					ports: {
						loadCatalog: async () => catalogFixture(),
						listVisibleModelIds: async () => {
							throw new Error("synthetic-secret");
						},
					},
				}),
			),
		).rejects.toMatchObject({
			message: "MODEL_CONFIGURATION_UNAVAILABLE",
			retryable: true,
		});
	});
});
