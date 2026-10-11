import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	RuntimeModelConfigurationV3Schema,
	RuntimeModelConfigurationV4Schema,
	type RuntimeModelProtocolV1,
	RuntimeModelProtocolV1Schema,
} from "@agent-infra/contracts/runtime";
import type {
	AgentConfigurationModelOptionV1,
	AgentConfigurationRecord,
	AgentConfigurationRecordV2,
	AgentConfigurationSourceV1,
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
export interface StandardTemplateModelBindingV1 {
	readonly templateId: string;
	readonly imageDigest: string;
	readonly driver: "codex" | "claude" | "acp" | "pi";
	readonly protocol: RuntimeModelProtocolV1;
}

const standardTemplateProtocol: Readonly<
	Record<StandardTemplateModelBindingV1["driver"], RuntimeModelProtocolV1>
> = {
	codex: "openai-responses-v1",
	claude: "anthropic-messages-v1",
	acp: "anthropic-messages-v1",
	pi: "anthropic-messages-v1",
};

const templateBindingSchema = z
	.strictObject({
		templateId: z
			.string()
			.min(1)
			.max(256)
			.refine((value) =>
				[...value].every(
					(character) =>
						character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
				),
			),
		imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		driver: z.enum(["codex", "claude", "acp", "pi"]),
		protocol: RuntimeModelProtocolV1Schema,
	})
	.refine(
		(binding) => binding.protocol === standardTemplateProtocol[binding.driver],
	);

const projectionContentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	agentId: z.string().min(1).max(256),
	configurationRevision: z.number().int().positive(),
	catalogRevision: modelIdentifier,
	defaultOptionId: modelIdentifier,
	defaultReasoningLevel: reasoningLevel,
	standardTemplateBinding: templateBindingSchema.optional(),
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
const keylessProjectionContentSchema = projectionContentSchema.extend({
	schemaVersion: z.literal(4),
	standardTemplateBinding: templateBindingSchema,
	options: z
		.array(
			z.strictObject({
				optionId: modelIdentifier,
				endpoint: ModelEndpointV1Schema,
				modelId: modelIdentifier,
				reasoningLevels: z.array(reasoningLevel).min(1).max(32),
			}),
		)
		.min(1)
		.max(128),
});
const keylessProjectionSchema = keylessProjectionContentSchema.extend({
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RuntimeModelProjectionV4 = z.infer<typeof keylessProjectionSchema>;
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const credentialVariable = (optionId: string) =>
	`AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_${hash(optionId).toUpperCase()}`;
export const runtimeModelConfigurationVariableV1 =
	"AGENT_INFRA_RUNTIME_MODEL_CONFIG";

/** Snapshot the trusted deployment tuples before any Store or Kubernetes operation. */
export function validateStandardTemplateModelBindingsV1(
	value: unknown,
): readonly StandardTemplateModelBindingV1[] {
	try {
		const bindings = z.array(templateBindingSchema).parse(value);
		const pairs = new Set(
			bindings.map(({ templateId, imageDigest }) =>
				JSON.stringify([templateId, imageDigest]),
			),
		);
		if (pairs.size !== bindings.length) throw new Error();
		return Object.freeze(bindings.map((binding) => Object.freeze(binding)));
	} catch {
		throw new ModelConfigurationErrorV1();
	}
}

// Projection reads admitted model fields, not the configuration write schema.
type ModelProjectionConfiguration = Pick<
	AgentConfigurationRecordV2,
	| "agentId"
	| "revision"
	| "source"
	| "modelConfiguration"
	| "environment"
	| "secrets"
>;

// V4 consumes the credential-free fields of both historical V2 and admitted V3.
type KeylessModelProjectionConfiguration = Pick<
	AgentConfigurationRecord,
	keyof ModelProjectionConfiguration
>;

/** Immutable image admission and the deployment's fixed Driver binding must agree. */
export function standardTemplateModelBindingV1(
	source: AgentConfigurationSourceV1,
	bindings: readonly StandardTemplateModelBindingV1[],
) {
	const matches = validateStandardTemplateModelBindingsV1(bindings).filter(
		(binding) =>
			source.kind === "standard" &&
			binding.templateId === source.templateId &&
			binding.imageDigest === source.imageDigest,
	);
	const match = matches[0];
	if (matches.length !== 1 || !match) throw new ModelConfigurationErrorV1();
	return match;
}

/** Preserve the existing protocol-only caller contract. */
export function standardTemplateModelProtocolV1(
	source: AgentConfigurationSourceV1,
	bindings: readonly StandardTemplateModelBindingV1[],
) {
	return standardTemplateModelBindingV1(source, bindings).protocol;
}

function validV4ModelEndpoint(
	endpoint: z.infer<typeof ModelEndpointV1Schema>,
	binding: StandardTemplateModelBindingV1,
) {
	return (
		endpoint.available &&
		endpoint.protocol === binding.protocol &&
		(endpoint.protocol === "anthropic-messages-v1"
			? endpoint.authentication !== undefined
			: endpoint.authentication === undefined ||
				endpoint.authentication === "bearer")
	);
}

/** A Worker-owned, credential-free snapshot. Never append this to Workload desired annotations. */
export async function projectRuntimeModelConfigurationV1(input: {
	readonly configuration: ModelProjectionConfiguration;
	readonly catalog: ModelCatalogAdapterV1;
	readonly access: ModelAccessValidatorV1;
	/** Bound to the admitted template image by deployment assembly, never an Owner field. */
	readonly standardTemplateBinding: StandardTemplateModelBindingV1;
	readonly signal: AbortSignal;
	readonly credentialFor: (option: AgentConfigurationModelOptionV1) => Promise<{
		readonly reference: z.infer<typeof secretReferenceSchema>;
		readonly key: string;
		readonly plaintext: Uint8Array;
	}>;
}): Promise<RuntimeModelProjectionV1> {
	return modelOperationV1(input.signal, async () => {
		const { configuration } = input;
		const standardTemplateBinding = standardTemplateModelBindingV1(
			configuration.source,
			[input.standardTemplateBinding],
		);
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
			if (
				endpoint.endpointId !== option.endpointId ||
				!endpoint.available ||
				endpoint.protocol !== standardTemplateBinding.protocol
			)
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
			standardTemplateBinding,
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
	configuration?: ModelProjectionConfiguration,
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
					(content.standardTemplateBinding !== undefined &&
						option.endpoint.protocol !==
							content.standardTemplateBinding.protocol) ||
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
				(content.standardTemplateBinding !== undefined &&
					(content.standardTemplateBinding.templateId !==
						configuration.source.templateId ||
						content.standardTemplateBinding.imageDigest !==
							configuration.source.imageDigest)) ||
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
	const messages = projection.options.some(
		(option) => option.endpoint.protocol === "anthropic-messages-v1",
	);
	const content = {
		schemaVersion: messages ? 3 : 2,
		configVersion: `configuration-${projection.configurationRevision}-${projection.fingerprint}`,
		defaultModelOptionId: projection.defaultOptionId,
		defaultReasoningLevel: projection.defaultReasoningLevel,
		modelOptions: projection.options.map((option) => ({
			modelOptionId: option.optionId,
			...(messages
				? {
						protocol: option.endpoint.protocol,
						authentication: option.endpoint.authentication ?? "bearer",
					}
				: {}),
			endpoint: option.endpoint.baseUrl,
			model: option.modelId,
			reasoningLevels: option.reasoningLevels,
			credentialEnvironmentVariable: credentialVariable(option.optionId),
		})),
	};
	const configuration = JSON.stringify(
		messages ? RuntimeModelConfigurationV3Schema.parse(content) : content,
	);
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

/** V4 admission resolves only catalog and Driver facts; no model Key is read. */
export async function projectRuntimeModelConfigurationV4(input: {
	readonly configuration: KeylessModelProjectionConfiguration;
	readonly catalog: ModelCatalogAdapterV1;
	readonly standardTemplateBinding: StandardTemplateModelBindingV1;
	readonly signal: AbortSignal;
}): Promise<RuntimeModelProjectionV4> {
	return modelOperationV1(input.signal, async () => {
		const { configuration } = input;
		const source = configuration.source;
		const standardTemplateBinding = standardTemplateModelBindingV1(source, [
			input.standardTemplateBinding,
		]);
		const model = configuration.modelConfiguration;
		if (
			source.kind !== "standard" ||
			standardTemplateBinding.protocol !==
				standardTemplateProtocol[standardTemplateBinding.driver] ||
			!model ||
			[...configuration.environment, ...configuration.secrets].some(
				({ name }) =>
					name.startsWith("AGENT_INFRA_") ||
					source.platformManagedKeys.includes(name),
			)
		)
			throw new ModelConfigurationErrorV1();
		const options: RuntimeModelProjectionV4["options"] = [];
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
			if (
				endpoint.endpointId !== option.endpointId ||
				!validV4ModelEndpoint(endpoint, standardTemplateBinding)
			)
				throw new ModelConfigurationErrorV1();
			options.push({
				optionId: option.optionId,
				endpoint,
				modelId: option.modelId,
				reasoningLevels: [...option.reasoningLevels],
			});
		}
		const content = keylessProjectionContentSchema.parse({
			schemaVersion: 4,
			agentId: configuration.agentId,
			configurationRevision: configuration.revision,
			catalogRevision: model.catalogRevision,
			defaultOptionId: model.defaultOptionId,
			defaultReasoningLevel: model.defaultReasoningLevel,
			standardTemplateBinding,
			options,
		});
		return validateRuntimeModelProjectionV4(
			{
				...content,
				fingerprint: hash(JSON.stringify(content)),
			},
			configuration,
		);
	});
}

export function validateRuntimeModelProjectionV4(
	value: unknown,
	configuration?: KeylessModelProjectionConfiguration,
): RuntimeModelProjectionV4 {
	try {
		const projection = keylessProjectionSchema.parse(value);
		runtimeModelConfigurationV4(projection);
		const { fingerprint, ...content } = projection;
		if (
			fingerprint !== hash(JSON.stringify(content)) ||
			content.standardTemplateBinding.protocol !==
				standardTemplateProtocol[content.standardTemplateBinding.driver] ||
			new Set(content.options.map(({ optionId }) => optionId)).size !==
				content.options.length ||
			!content.options.some(
				({ optionId, reasoningLevels }) =>
					optionId === content.defaultOptionId &&
					reasoningLevels.includes(content.defaultReasoningLevel),
			) ||
			content.options.some(
				({ endpoint, modelId, reasoningLevels }) =>
					!validV4ModelEndpoint(endpoint, content.standardTemplateBinding) ||
					new Set(reasoningLevels).size !== reasoningLevels.length ||
					reasoningLevels.some(
						(level) => !endpoint.capabilities.reasoningLevels.includes(level),
					) ||
					(endpoint.allowedModels !== null &&
						!endpoint.allowedModels.includes(modelId)),
			)
		)
			throw new ModelConfigurationErrorV1();
		if (configuration) {
			const model = configuration.modelConfiguration;
			if (
				configuration.source.kind !== "standard" ||
				!model ||
				content.standardTemplateBinding.templateId !==
					configuration.source.templateId ||
				content.standardTemplateBinding.imageDigest !==
					configuration.source.imageDigest ||
				configuration.agentId !== content.agentId ||
				configuration.revision !== content.configurationRevision ||
				model.catalogRevision !== content.catalogRevision ||
				model.defaultOptionId !== content.defaultOptionId ||
				model.defaultReasoningLevel !== content.defaultReasoningLevel ||
				!isDeepStrictEqual(
					model.options.map(
						({ optionId, endpointId, modelId, reasoningLevels }) => ({
							optionId,
							endpointId,
							modelId,
							reasoningLevels: [...reasoningLevels],
						}),
					),
					content.options.map(
						({ optionId, endpoint, modelId, reasoningLevels }) => ({
							optionId,
							endpointId: endpoint.endpointId,
							modelId,
							reasoningLevels,
						}),
					),
				)
			)
				throw new ModelConfigurationErrorV1();
		}
		return projection;
	} catch {
		throw new ModelConfigurationErrorV1();
	}
}

export async function revalidateRuntimeModelCatalogV4(
	projection: RuntimeModelProjectionV4,
	catalog: ModelCatalogAdapterV1,
	signal: AbortSignal,
): Promise<void> {
	await modelOperationV1(signal, async () => {
		for (const option of validateRuntimeModelProjectionV4(projection).options) {
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

export function runtimeModelInjectionV4(value: RuntimeModelProjectionV4) {
	const projection = validateRuntimeModelProjectionV4(value);
	const secretName = `model-config-${projection.fingerprint.slice(0, 48)}`;
	const configuration = JSON.stringify(runtimeModelConfigurationV4(projection));
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
		],
	};
}

function runtimeModelConfigurationV4(projection: RuntimeModelProjectionV4) {
	return RuntimeModelConfigurationV4Schema.parse({
		schemaVersion: 4,
		configVersion: `configuration-${projection.configurationRevision}-${projection.fingerprint}`,
		defaultModelOptionId: projection.defaultOptionId,
		defaultReasoningLevel: projection.defaultReasoningLevel,
		modelOptions: projection.options.map(
			({ optionId, endpoint, modelId, reasoningLevels }) => ({
				modelOptionId: optionId,
				protocol: endpoint.protocol,
				authentication: endpoint.authentication ?? "bearer",
				endpoint: endpoint.baseUrl,
				model: modelId,
				reasoningLevels,
			}),
		),
	});
}
