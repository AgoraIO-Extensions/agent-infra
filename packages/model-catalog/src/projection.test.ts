import { createHash } from "node:crypto";
import { RuntimeModelConfigurationV3Schema } from "@agent-infra/contracts/runtime";
import type {
	AgentConfigurationRecordV1,
	AgentConfigurationRecordV2,
} from "@agent-infra/platform-core";
import { expect, it } from "vitest";
import { catalogFixture } from "./catalog.fixture.js";
import {
	createFakeModelAccessValidatorV1,
	createFakeModelCatalogAdapterV1,
	projectRuntimeModelConfigurationV1,
	runtimeModelInjectionV1,
	validateRuntimeModelProjectionV1,
} from "./index.js";

const hash = (s: string) =>
	createHash("sha256").update(s).digest("hex").toUpperCase();
const configurationV2: AgentConfigurationRecordV2 = {
	schemaVersion: 2,
	agentId: "agent-a",
	revision: 1,
	source: {
		kind: "standard",
		templateId: "claude",
		imageDigest: `sha256:${"a".repeat(64)}`,
		admissionRevision: "admission-a",
		allowedEnvironmentKeys: [],
		allowedSecretKeys: [],
		platformManagedKeys: [],
		connectionEnabled: false,
	},
	modelConfiguration: null,
	environment: [],
	secrets: [],
	channels: [],
	channelRevision: "channels-a",
};
async function projection(
	protocol: "anthropic-messages-v1" | "openai-responses-v1",
	templateProtocol = protocol,
	configuration:
		| AgentConfigurationRecordV1
		| AgentConfigurationRecordV2 = configurationV2,
) {
	return projectRuntimeModelConfigurationV1({
		configuration: {
			...configuration,
			environment: [],
			secrets: [],
			modelConfiguration: {
				catalogRevision: "catalog-a",
				defaultOptionId: "primary",
				defaultReasoningLevel: "high",
				options: [
					{
						optionId: "primary",
						modelId: "model-a",
						endpointId: "endpoint-a",
						reasoningLevels: ["high"],
						credential: { secretId: "secret-a", version: 1, isSet: true },
					},
				],
			},
		},
		protocol: templateProtocol,
		catalog: createFakeModelCatalogAdapterV1({
			...catalogFixture(),
			endpoints: [
				{
					...catalogFixture().endpoints[0],
					protocol,
					...(protocol === "anthropic-messages-v1"
						? { authentication: "api-key" }
						: {}),
				},
			],
		}),
		access: createFakeModelAccessValidatorV1([
			{
				endpointId: "endpoint-a",
				modelId: "model-a",
				reasoningLevels: ["high"],
				credential: "synthetic-credential-a",
			},
		]),
		signal: AbortSignal.timeout(1000),
		credentialFor: async () => ({
			reference: {
				secretId: "secret-a",
				secretVersion: 1,
				configRevision: 1,
				name: "model-secret-a",
			},
			key: `MODEL_CREDENTIAL_${hash("model:primary")}`,
			plaintext: new TextEncoder().encode("synthetic-credential-a"),
		}),
	});
}

it("preserves model projection while configuration records migrate from V1 to V2", async () => {
	const historical: AgentConfigurationRecordV1 = {
		...configurationV2,
		schemaVersion: 1,
		actions: [],
		actionSetRevision: "historical-actions",
	};
	expect(
		await projection(
			"anthropic-messages-v1",
			"anthropic-messages-v1",
			historical,
		),
	).toEqual(await projection("anthropic-messages-v1"));
});

it("projects Messages as V3 with its per-option credential and refuses a template/profile mismatch", async () => {
	const projected = await projection("anthropic-messages-v1");
	const injected = RuntimeModelConfigurationV3Schema.parse(
		JSON.parse(runtimeModelInjectionV1(projected).configuration),
	);
	expect(injected.modelOptions[0]).toMatchObject({
		protocol: "anthropic-messages-v1",
		authentication: "api-key",
		credentialEnvironmentVariable: `AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_${hash("primary")}`,
	});
	await expect(
		projection("anthropic-messages-v1", "openai-responses-v1"),
	).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	const legacy = await projection("openai-responses-v1");
	const bytes = JSON.stringify(legacy);
	expect(
		JSON.stringify(validateRuntimeModelProjectionV1(JSON.parse(bytes))),
	).toBe(bytes);
	expect(
		JSON.parse(runtimeModelInjectionV1(legacy).configuration).schemaVersion,
	).toBe(2);
});
