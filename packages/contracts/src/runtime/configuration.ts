import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const reasoning = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const RuntimeModelProtocolV1Schema = z.enum([
	"openai-responses-v1",
	"anthropic-messages-v1",
]);
export type RuntimeModelProtocolV1 = z.infer<
	typeof RuntimeModelProtocolV1Schema
>;

const option = {
	modelOptionId: identifier,
	endpoint: z.string().min(1).max(2048),
	model: identifier,
	reasoningLevels: z.array(reasoning).min(1).max(32),
	credentialEnvironmentVariable: z
		.string()
		.regex(/^AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_[A-Z0-9_]{1,96}$/),
};

/** Deployment-only configuration. Credentials and provider types never enter submit commands. */
export const RuntimeModelConfigurationV3Schema = z
	.strictObject({
		schemaVersion: z.literal(3),
		configVersion: identifier,
		defaultModelOptionId: identifier,
		defaultReasoningLevel: reasoning,
		modelOptions: z
			.array(
				z.discriminatedUnion("protocol", [
					z.strictObject({
						...option,
						protocol: z.literal("openai-responses-v1"),
						authentication: z.literal("bearer"),
					}),
					z.strictObject({
						...option,
						protocol: z.literal("anthropic-messages-v1"),
						authentication: z.enum(["bearer", "api-key"]),
					}),
				]),
			)
			.min(1)
			.max(128),
	})
	.refine(
		(value) =>
			new Set(value.modelOptions.map((entry) => entry.modelOptionId)).size ===
				value.modelOptions.length &&
			value.modelOptions.every(
				(entry) =>
					new Set(entry.reasoningLevels).size === entry.reasoningLevels.length,
			) &&
			value.modelOptions.some(
				(entry) =>
					entry.modelOptionId === value.defaultModelOptionId &&
					entry.reasoningLevels.includes(value.defaultReasoningLevel),
			),
	);
export type RuntimeModelConfigurationV3 = z.infer<
	typeof RuntimeModelConfigurationV3Schema
>;
