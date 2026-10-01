import { z } from "zod";

const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const PersonalRelayKeyStateV1Schema = z.discriminatedUnion("isSet", [
	z.strictObject({
		schemaVersion: z.literal(1),
		isSet: z.literal(false),
		keyVersion: z.null(),
	}),
	z.strictObject({
		schemaVersion: z.literal(1),
		isSet: z.literal(true),
		keyVersion: version,
	}),
]);
export const PersonalRelayKeyReplaceRequestV1Schema = z.strictObject({
	expectedVersion: version.nullable(),
	keyValue: z
		.string()
		.min(16)
		.max(8192)
		.regex(/^[\x21-\x7e]+$/)
		.meta({
			format: "password",
			description:
				"Write-only personal Relay Key; never returned or persisted as plaintext.",
		}),
});
export const PersonalRelayKeyRevokeRequestV1Schema = z.strictObject({
	expectedVersion: version,
});
