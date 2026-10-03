import { z } from "zod";

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(1024);
export const AgentDefaultRelayKeyStateV1Schema = z.discriminatedUnion("isSet", [
	z.strictObject({
		schemaVersion: z.literal(1),
		isSet: z.literal(false),
		keyVersion: z.null(),
		configurationRevision: version,
	}),
	z.strictObject({
		schemaVersion: z.literal(1),
		isSet: z.literal(true),
		keyVersion: version,
		configurationRevision: version,
	}),
]);
export const AgentDefaultRelayKeyCandidatesRequestV1Schema = z.strictObject({
	configurationRevision: version,
	keyValue: z
		.string()
		.min(16)
		.max(8192)
		.regex(/^[\x21-\x7e]+$/)
		.meta({ format: "password", writeOnly: true }),
});
export const AgentDefaultRelayKeyReplaceRequestV1Schema =
	AgentDefaultRelayKeyCandidatesRequestV1Schema.extend({
		expectedVersion: version.nullable(),
	});
export const AgentDefaultRelayKeyCandidatesV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	configurationRevision: version,
	candidates: z
		.array(
			z.strictObject({
				endpointId: id,
				modelId: id,
				reasoningLevels: z.array(id).min(1).max(32),
			}),
		)
		.max(32768),
});
