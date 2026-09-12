import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	AgentConfigurationModelOptionV1,
	AgentConfigurationRecordV1,
} from "@agent-infra/platform-core";
import { z } from "zod";
import type { ModelAccessValidatorV1 } from "./access.js";
import {
	type ModelCatalogAdapterV1,
	ModelConfigurationErrorV1,
	ModelEndpointV1Schema,
	modelIdentifier,
	modelOperationV1,
	reasoningLevel,
} from "./catalog.js";

const secretReferenceSchema = z.strictObject({
	secretId: z.string().min(1).max(256),
	secretVersion: z.number().int().positive(),
	configRevision: z.number().int().positive(),
	name: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/),
});
const projectionContentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	agentId: z.string().min(1).max(256),
	configurationRevision: z.number().int().positive(),
	catalogRevision: modelIdentifier,
	defaultOptionId: modelIdentifier,
	defaultReasoningLevel: reasoningLevel,
	options: z
		.array(
			z.strictObject({
				optionId: modelIdentifier,
				endpoint: ModelEndpointV1Schema,
				modelId: modelIdentifier,
				reasoningLevels: z.array(reasoningLevel).min(1).max(32),
				secretRef: secretReferenceSchema,
				secretKey: z.string().regex(/^MODEL_CREDENTIAL_[A-F0-9]{64}$/),
			}),
		)
		.min(1)
		.max(128),
});
const projectionSchema = projectionContentSchema.extend({
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RuntimeModelProjectionV1 = z.infer<typeof projectionSchema>;
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const credentialVariable = (optionId: string) =>
	`AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_${hash(optionId).toUpperCase()}`;
export const runtimeModelConfigurationVariableV1 =
	"AGENT_INFRA_RUNTIME_MODEL_CONFIG";

/** A Worker-owned, credential-free snapshot. Never append this to Workload desired annotations. */
export async function projectRuntimeModelConfigurationV1(input: {
	readonly configuration: AgentConfigurationRecordV1;
	readonly catalog: ModelCatalogAdapterV1;
	readonly access: ModelAccessValidatorV1;
	readonly signal: AbortSignal;
	readonly credentialFor: (option: AgentConfigurationModelOptionV1) => Promise<{
		readonly reference: z.infer<typeof secretReferenceSchema>;
		readonly key: string;
		readonly plaintext: Uint8Array;
	}>;
}): Promise<RuntimeModelProjectionV1> {
	return modelOperationV1(input.signal, async () => {
		const { configuration } = input;
		const model = configuration.modelConfiguration;
		if (
			configuration.source.kind !== "standard" ||
			!model ||
			[...configuration.environment, ...configuration.secrets].some(
				({ name }) =>
					name.startsWith("AGENT_INFRA_") ||
					(configuration.source.kind === "standard" &&
						configuration.source.platformManagedKeys.includes(name)),
			)
		)
			throw new ModelConfigurationErrorV1();
		const options: RuntimeModelProjectionV1["options"] = [];
		for (const option of model.options) {
			input.signal.throwIfAborted();
			const endpoint = ModelEndpointV1Schema.parse(
				await input.catalog.resolve(
					{
						endpointId: option.endpointId,
						catalogRevision: model.catalogRevision,
					},
					{ signal: input.signal },
				),
			);
			if (endpoint.endpointId !== option.endpointId || !endpoint.available)
				throw new ModelConfigurationErrorV1();
			const credential = await input.credentialFor(option);
			try {
				if (
					credential.reference.secretId !== option.credential.secretId ||
					credential.reference.secretVersion !== option.credential.version ||
					!option.credential.isSet
				)
					throw new ModelConfigurationErrorV1();
				await modelOperationV1(input.signal, () =>
					input.access.validate(
						{
							endpoint,
							modelId: option.modelId,
							reasoningLevels: option.reasoningLevels,
							credential: credential.plaintext,
						},
						{ signal: input.signal },
					),
				);
				options.push({
					optionId: option.optionId,
					endpoint,
					modelId: option.modelId,
					reasoningLevels: [...option.reasoningLevels],
					secretRef: credential.reference,
					secretKey: credential.key,
				});
			} finally {
				credential.plaintext.fill(0);
			}
		}
		const content = projectionContentSchema.parse({
			schemaVersion: 1,
			agentId: configuration.agentId,
			configurationRevision: configuration.revision,
			catalogRevision: model.catalogRevision,
			defaultOptionId: model.defaultOptionId,
			defaultReasoningLevel: model.defaultReasoningLevel,
			options,
		});
		return validateRuntimeModelProjectionV1(
			{ ...content, fingerprint: hash(JSON.stringify(content)) },
			configuration,
		);
	});
}

export function validateRuntimeModelProjectionV1(
	value: unknown,
	configuration?: AgentConfigurationRecordV1,
): RuntimeModelProjectionV1 {
	try {
		const projection = projectionSchema.parse(value);
		const { fingerprint, ...content } = projection;
		if (
			fingerprint !== hash(JSON.stringify(content)) ||
			new Set(content.options.map((option) => option.optionId)).size !==
				content.options.length ||
			new Set(content.options.map((option) => option.secretRef.name)).size !==
				content.options.length ||
			!content.options.some(
				(option) =>
					option.optionId === content.defaultOptionId &&
					option.reasoningLevels.includes(content.defaultReasoningLevel),
			) ||
			content.options.some(
				(option) =>
					!option.endpoint.available ||
					option.secretRef.configRevision > content.configurationRevision ||
					new Set(option.reasoningLevels).size !==
						option.reasoningLevels.length ||
					option.secretKey !==
						`MODEL_CREDENTIAL_${hash(`model:${option.optionId}`).toUpperCase()}` ||
					option.reasoningLevels.some(
						(level) =>
							!option.endpoint.capabilities.reasoningLevels.includes(level),
					) ||
					(option.endpoint.allowedModels !== null &&
						!option.endpoint.allowedModels.includes(option.modelId)),
			)
		)
			throw new ModelConfigurationErrorV1();
		if (configuration) {
			const model = configuration.modelConfiguration;
			if (
				configuration.source.kind !== "standard" ||
				!model ||
				configuration.agentId !== content.agentId ||
				configuration.revision !== content.configurationRevision ||
				model.catalogRevision !== content.catalogRevision ||
				model.defaultOptionId !== content.defaultOptionId ||
				model.defaultReasoningLevel !== content.defaultReasoningLevel ||
				!isDeepStrictEqual(
					model.options.map((option) => ({
						optionId: option.optionId,
						endpointId: option.endpointId,
						modelId: option.modelId,
						reasoningLevels: [...option.reasoningLevels],
						secretId: option.credential.secretId,
						version: option.credential.version,
					})),
					content.options.map((option) => ({
						optionId: option.optionId,
						endpointId: option.endpoint.endpointId,
						modelId: option.modelId,
						reasoningLevels: option.reasoningLevels,
						secretId: option.secretRef.secretId,
						version: option.secretRef.secretVersion,
					})),
				)
			)
				throw new ModelConfigurationErrorV1();
		}
		return projection;
	} catch {
		throw new ModelConfigurationErrorV1();
	}
}

/** Candidate authorization is refreshed at each durable activation boundary. */
export async function revalidateRuntimeModelCatalogV1(
	projection: RuntimeModelProjectionV1,
	catalog: ModelCatalogAdapterV1,
	signal: AbortSignal,
): Promise<void> {
	await modelOperationV1(signal, async () => {
		for (const option of validateRuntimeModelProjectionV1(projection).options) {
			const endpoint = await catalog.resolve(
				{
					endpointId: option.endpoint.endpointId,
					catalogRevision: projection.catalogRevision,
				},
				{ signal },
			);
			if (!isDeepStrictEqual(endpoint, option.endpoint))
				throw new ModelConfigurationErrorV1();
		}
	});
}

export function runtimeModelInjectionV1(value: RuntimeModelProjectionV1) {
	const projection = validateRuntimeModelProjectionV1(value);
	const secretName = `model-config-${projection.fingerprint.slice(0, 48)}`;
	const configuration = JSON.stringify({
		schemaVersion: 2,
		configVersion: `configuration-${projection.configurationRevision}-${projection.fingerprint}`,
		defaultModelOptionId: projection.defaultOptionId,
		defaultReasoningLevel: projection.defaultReasoningLevel,
		modelOptions: projection.options.map((option) => ({
			modelOptionId: option.optionId,
			endpoint: option.endpoint.baseUrl,
			model: option.modelId,
			reasoningLevels: option.reasoningLevels,
			credentialEnvironmentVariable: credentialVariable(option.optionId),
		})),
	});
	return {
		secretName,
		configuration,
		env: [
			{
				name: runtimeModelConfigurationVariableV1,
				valueFrom: {
					secretKeyRef: {
						name: secretName,
						key: "configuration",
						optional: false,
					},
				},
			},
			...projection.options.map((option) => ({
				name: credentialVariable(option.optionId),
				valueFrom: {
					secretKeyRef: {
						name: option.secretRef.name,
						key: option.secretKey,
						optional: false,
					},
				},
			})),
		],
	};
}
