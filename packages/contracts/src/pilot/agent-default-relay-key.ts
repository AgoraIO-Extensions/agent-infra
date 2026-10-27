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
export const AgentApplicationModelCandidatesRequestV2Schema = z.strictObject({
	templateId: id,
	defaultRelayKey: z
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

const candidateSchema = z.strictObject({
	endpointId: id,
	modelId: id,
	reasoningLevels: z.array(id).min(1).max(32),
});

export const AgentApplicationModelCandidatesResponseV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	candidates: z.array(candidateSchema).max(32768),
});

export const AgentDefaultRelayKeyCandidatesV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	configurationRevision: version,
	candidates: z.array(candidateSchema).max(32768),
});

/** Read-only projection for an already persisted Agent default Relay Key. */
export const AgentDefaultRelayKeySavedCandidatesV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	configurationRevision: version,
	keyVersion: version,
	candidates: z.array(candidateSchema).max(32768),
});

const displayCandidateSchema = candidateSchema.extend({
	displayName: z
		.string()
		.min(1)
		.max(128)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: 负字符类明确拒绝 C0/C1 控制字符。
		.regex(/^[^\u0000-\u001f\u007f-\u009f]+$/)
		.refine((value) => value.trim() === value),
});

export const AgentDefaultRelayKeyDisplayCandidatesV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	configurationRevision: version,
	candidates: z.array(displayCandidateSchema).max(32768),
});

export const AgentDefaultRelayKeySavedDisplayCandidatesV2Schema =
	z.strictObject({
		schemaVersion: z.literal(2),
		configurationRevision: version,
		keyVersion: version,
		candidates: z.array(displayCandidateSchema).max(32768),
	});
