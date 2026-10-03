import { createHash } from "node:crypto";
import {
	RuntimeModelConfigurationV3Schema,
	RuntimeModelConfigurationV4Schema,
} from "@agent-infra/contracts/runtime";
import type {
	AgentConfigurationRecordV1,
	AgentConfigurationRecordV2,
} from "@agent-infra/platform-core";
import { expect, it } from "vitest";
import { catalogFixture } from "./catalog.fixture.js";
import {
	createDeploymentModelCatalogAdapterV1,
	createFakeModelAccessValidatorV1,
	createFakeModelCatalogAdapterV1,
	projectRuntimeModelConfigurationV1,
	projectRuntimeModelConfigurationV4,
	revalidateRuntimeModelCatalogV4,
	runtimeModelInjectionV1,
	runtimeModelInjectionV4,
	type StandardTemplateModelBindingV1,
	standardTemplateModelBindingV1,
	standardTemplateModelProtocolV1,
	validateRuntimeModelProjectionV1,
	validateRuntimeModelProjectionV4,
	validateStandardTemplateModelBindingsV1,
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
const standardBinding = {
	templateId: "arbitrary-template-a",
	imageDigest: `sha256:${"a".repeat(64)}`,
	driver: "claude" as const,
	protocol: "anthropic-messages-v1" as const,
};

it("selects protocols from exact trusted pairs with distinct Drivers sharing a protocol", () => {
	const standardSource = configurationV2.source;
	if (standardSource.kind !== "standard") {
		throw new Error("Expected the admitted standard source fixture");
	}
	const bindings = [
		{ ...standardBinding },
		{
			...standardBinding,
			templateId: "arbitrary-template-b",
			imageDigest: `sha256:${"b".repeat(64)}`,
			driver: "acp" as const,
		},
	];
	for (const binding of bindings) {
		const source = {
			...standardSource,
			templateId: binding.templateId,
			imageDigest: binding.imageDigest,
		};
		expect(standardTemplateModelBindingV1(source, bindings)).toEqual(binding);
		expect(standardTemplateModelProtocolV1(source, bindings)).toBe(
			"anthropic-messages-v1",
		);
		expect(() =>
			standardTemplateModelProtocolV1(
				{ ...source, imageDigest: `sha256:${"c".repeat(64)}` },
				bindings,
			),
		).toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	}
	expect(() =>
		standardTemplateModelProtocolV1(
			{ ...standardSource, templateId: "unadmitted-template" },
			bindings,
		),
	).toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	const snapshot = validateStandardTemplateModelBindingsV1(bindings);
	const originalBinding = bindings[0];
	if (!originalBinding) throw new Error("Expected the first trusted binding");
	Object.assign(originalBinding, { driver: "pi" });
	expect(snapshot[0]?.driver).toBe("claude");
	expect(Object.isFrozen(snapshot)).toBe(true);
	expect(Object.isFrozen(snapshot[0])).toBe(true);
});

it.each([
	undefined,
	{},
	[
		{
			templateId: standardBinding.templateId,
			imageDigest: standardBinding.imageDigest,
			protocol: standardBinding.protocol,
		},
	],
	[{ ...standardBinding, driver: "fake" }],
	[{ ...standardBinding, driver: "unknown" }],
	[{ ...standardBinding, driver: "codex" }],
	[{ ...standardBinding, protocol: "openai-responses-v1" }],
	[{ ...standardBinding, imageDigest: "latest" }],
	[{ ...standardBinding, ownerDriver: "claude" }],
	[standardBinding, standardBinding],
	[standardBinding, { ...standardBinding, driver: "acp" }],
])(
	"rejects missing, invalid or ambiguous trusted Driver tuples (%#)",
	(bindings) => {
		expect(() => validateStandardTemplateModelBindingsV1(bindings)).toThrow(
			/^MODEL_CONFIGURATION_UNAVAILABLE$/,
		);
	},
);

it("allows an explicitly empty custom deployment without inventing a standard Driver", () => {
	expect(validateStandardTemplateModelBindingsV1([])).toEqual([]);
	expect(() =>
		standardTemplateModelProtocolV1(configurationV2.source, []),
	).toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
});

async function projection(
	protocol: "anthropic-messages-v1" | "openai-responses-v1",
	templateProtocol = protocol,
	configuration:
		| AgentConfigurationRecordV1
		| AgentConfigurationRecordV2 = configurationV2,
	binding?: StandardTemplateModelBindingV1,
) {
	if (configuration.source.kind !== "standard") throw new Error();
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
		standardTemplateBinding: binding ?? {
			templateId: configuration.source.templateId,
			imageDigest: configuration.source.imageDigest,
			driver: templateProtocol === "openai-responses-v1" ? "codex" : "claude",
			protocol: templateProtocol,
		},
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

it("binds the exact same-protocol Driver into the durable fingerprint and runtime version", async () => {
	if (configurationV2.source.kind !== "standard") throw new Error();
	const binding = {
		...standardBinding,
		templateId: configurationV2.source.templateId,
	};
	const claude = await projection(
		"anthropic-messages-v1",
		undefined,
		undefined,
		binding,
	);
	const acp = await projection("anthropic-messages-v1", undefined, undefined, {
		...binding,
		driver: "acp",
	});
	expect(claude.standardTemplateBinding).toEqual(binding);
	expect(acp.fingerprint).not.toBe(claude.fingerprint);
	expect(runtimeModelInjectionV1(acp).secretName).not.toBe(
		runtimeModelInjectionV1(claude).secretName,
	);
	expect(
		JSON.parse(runtimeModelInjectionV1(acp).configuration).configVersion,
	).not.toBe(
		JSON.parse(runtimeModelInjectionV1(claude).configuration).configVersion,
	);
	const bytes = JSON.stringify(claude);
	expect(
		JSON.stringify(validateRuntimeModelProjectionV1(JSON.parse(bytes))),
	).toBe(bytes);
	expect(() =>
		validateRuntimeModelProjectionV1({
			...claude,
			standardTemplateBinding: acp.standardTemplateBinding,
		}),
	).toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
});

it("rejects rehashed tuples inconsistent with the persisted source or endpoint profile", async () => {
	const projected = await projection("anthropic-messages-v1");
	const configuration = {
		...configurationV2,
		modelConfiguration: {
			catalogRevision: projected.catalogRevision,
			defaultOptionId: projected.defaultOptionId,
			defaultReasoningLevel: projected.defaultReasoningLevel,
			options: projected.options.map((option) => ({
				optionId: option.optionId,
				endpointId: option.endpoint.endpointId,
				modelId: option.modelId,
				reasoningLevels: option.reasoningLevels,
				credential: {
					secretId: option.secretRef.secretId,
					version: option.secretRef.secretVersion,
					isSet: true as const,
				},
			})),
		},
	};
	expect(projected.standardTemplateBinding).toBeDefined();
	for (const override of [
		{ templateId: "different-template" },
		{ imageDigest: `sha256:${"b".repeat(64)}` },
		{ driver: "codex", protocol: "openai-responses-v1" },
	]) {
		const { fingerprint: _, ...content } = projected;
		const changed = {
			...content,
			standardTemplateBinding: {
				...projected.standardTemplateBinding,
				...override,
			},
		};
		expect(() =>
			validateRuntimeModelProjectionV1(
				{
					...changed,
					fingerprint: hash(JSON.stringify(changed)).toLowerCase(),
				},
				configuration,
			),
		).toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	}
	expect(validateRuntimeModelProjectionV1(projected, configuration)).toEqual(
		projected,
	);
});

it("reads historical tuple-free bytes without rebinding or changing their runtime version", async () => {
	const {
		standardTemplateBinding: _,
		fingerprint: _fingerprint,
		...content
	} = await projection("openai-responses-v1");
	const fingerprint = hash(JSON.stringify(content)).toLowerCase();
	const bytes = JSON.stringify({ ...content, fingerprint });
	const historical = validateRuntimeModelProjectionV1(JSON.parse(bytes));
	expect(JSON.stringify(historical)).toBe(bytes);
	expect(historical.standardTemplateBinding).toBeUndefined();
	expect(
		JSON.parse(runtimeModelInjectionV1(historical).configuration).configVersion,
	).toBe(`configuration-${content.configurationRevision}-${fingerprint}`);
});

async function keylessProjectionFixture() {
	const configuration: AgentConfigurationRecordV2 = {
		...configurationV2,
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
					credential: {
						secretId: "old-model-secret-not-read",
						version: 9,
						isSet: true,
					},
				},
			],
		},
	};
	if (configuration.source.kind !== "standard")
		throw new Error("Expected standard configuration");
	const binding: StandardTemplateModelBindingV1 = {
		templateId: configuration.source.templateId,
		imageDigest: configuration.source.imageDigest,
		driver: "codex",
		protocol: "openai-responses-v1",
	};
	const projected = await projectRuntimeModelConfigurationV4({
		configuration,
		standardTemplateBinding: binding,
		catalog: createFakeModelCatalogAdapterV1(catalogFixture()),
		signal: new AbortController().signal,
	});
	return { configuration, binding, projected };
}
it("produces V4 model configuration with the trusted image/Driver tuple and no static Key references", async () => {
	const { projected, binding } = await keylessProjectionFixture();
	expect(projected.standardTemplateBinding).toEqual(binding);
	const injection = runtimeModelInjectionV4(projected);
	const parsedConfiguration = RuntimeModelConfigurationV4Schema.parse(
		JSON.parse(injection.configuration),
	);
	expect(parsedConfiguration).toMatchObject({
		schemaVersion: 4,
		modelOptions: [
			{
				modelOptionId: "primary",
				endpoint: "https://models.example.test/team-a/v1",
			},
		],
	});
	expect(injection.env).toEqual([
		{
			name: "AGENT_INFRA_RUNTIME_MODEL_CONFIG",
			valueFrom: {
				secretKeyRef: {
					name: injection.secretName,
					key: "configuration",
					optional: false,
				},
			},
		},
	]);
	const safeProjection = JSON.stringify({
		projected,
		configuration: parsedConfiguration,
	});
	for (const forbidden of [
		"old-model-secret-not-read",
		"credentialEnvironmentVariable",
		"secretRef",
		"secretKey",
	]) {
		expect(safeProjection).not.toContain(forbidden);
	}
	expect(safeProjection).not.toContain("AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_");
});
it("rejects rehashed V4 projection source/Driver drift and static credentials", async () => {
	const { configuration, projected } = await keylessProjectionFixture();
	const { fingerprint: _fingerprint, ...original } = projected;
	const { standardTemplateBinding: _binding, ...tupleFree } = original;
	for (const content of [
		tupleFree,
		{ ...original, agentId: "another-agent" },
		{
			...original,
			standardTemplateBinding: {
				...original.standardTemplateBinding,
				templateId: "another-template",
			},
		},
		{
			...original,
			standardTemplateBinding: {
				...original.standardTemplateBinding,
				imageDigest: `sha256:${"b".repeat(64)}`,
			},
		},
		{
			...original,
			standardTemplateBinding: {
				...original.standardTemplateBinding,
				driver: "claude",
				protocol: "anthropic-messages-v1",
			},
		},
		{
			...original,
			options: original.options.map((option) => ({
				...option,
				secretKey: "STATIC_KEY",
			})),
		},
	]) {
		expect(() =>
			validateRuntimeModelProjectionV4(
				{
					...content,
					fingerprint: hash(JSON.stringify(content)).toLowerCase(),
				},
				configuration,
			),
		).toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	}
});
it.each(["changed", "removed", "expired"])(
	"revalidates V4 catalog facts before use after %s",
	async (change) => {
		const { projected } = await keylessProjectionFixture();
		const catalog = catalogFixture();
		const endpoint = catalog.endpoints[0];
		if (!endpoint) throw new Error("Missing endpoint fixture");
		if (change === "changed")
			endpoint.baseUrl = "https://models.example.test/changed/v1";
		else if (change === "removed") catalog.endpoints = [];
		else catalog.validUntil = Date.now() - 1;
		await expect(
			revalidateRuntimeModelCatalogV4(
				projected,
				createDeploymentModelCatalogAdapterV1({ load: async () => catalog }),
				new AbortController().signal,
			),
		).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	},
);

it.each(["https://127.0.0.1/v1", "https://localhost/v1", "https://[::1]/v1"])(
	"rejects V4 non-DNS endpoint in the producer before injection: %s",
	async (baseUrl) => {
		const { configuration, binding } = await keylessProjectionFixture();
		const catalog = catalogFixture();
		const endpoint = catalog.endpoints[0];
		if (!endpoint) throw new Error("Missing endpoint fixture");
		const fakeCatalog = createFakeModelCatalogAdapterV1(catalog);
		await expect(
			projectRuntimeModelConfigurationV4({
				configuration,
				standardTemplateBinding: binding,
				catalog: {
					async resolve(input, options) {
						const typedEndpoint = await fakeCatalog.resolve(input, options);
						return {
							...typedEndpoint,
							baseUrl,
							origin: new URL(baseUrl).origin,
						};
					},
				},
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	},
);
