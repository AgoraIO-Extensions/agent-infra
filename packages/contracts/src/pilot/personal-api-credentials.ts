import { z } from "zod";
import { OpaqueIdV1Schema, Rfc3339TimestampV1Schema } from "../index.ts";

const scopes = z
	.array(z.enum(["agent:create", "agent:manage", "agent:use", "agent:read"]))
	.min(1)
	.max(4)
	.refine((values) => new Set(values).size === values.length)
	.meta({ uniqueItems: true });
const issuanceExpiry = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
	.refine((value) => z.iso.datetime({ offset: false }).safeParse(value).success)
	.meta({ format: "date-time" });

export const PersonalApiCredentialIssueRequestV1Schema = z.strictObject({
	scopes,
	expiresAt: issuanceExpiry.nullable(),
});
export const PersonalApiCredentialMetadataV1Schema = z.strictObject({
	credentialId: OpaqueIdV1Schema,
	scopes,
	expiresAt: Rfc3339TimestampV1Schema.nullable(),
	revokedAt: Rfc3339TimestampV1Schema.nullable(),
	createdAt: Rfc3339TimestampV1Schema,
	lastUsedAt: Rfc3339TimestampV1Schema.nullable(),
});
export const PersonalApiCredentialIssueResponseV1Schema = z.discriminatedUnion(
	"replayed",
	[
		z.strictObject({
			metadata: PersonalApiCredentialMetadataV1Schema,
			credential: z
				.string()
				.regex(/^papi_[A-Za-z0-9_-]{43}$/)
				.meta({
					description:
						"First committed delivery only; never persisted or replayed.",
					format: "password",
				}),
			replayed: z.literal(false),
		}),
		z.strictObject({
			metadata: PersonalApiCredentialMetadataV1Schema,
			credential: z.null(),
			replayed: z.literal(true),
		}),
	],
);
export const PersonalApiCredentialRevokeResponseV1Schema = z.strictObject({
	metadata: PersonalApiCredentialMetadataV1Schema,
	replayed: z.boolean(),
});

export const PersonalApiCredentialNarrowRequestV1Schema = z
	.strictObject({
		scopes: scopes.optional(),
		expiresAt: issuanceExpiry.optional(),
	})
	.refine((value) => Object.keys(value).length > 0)
	.meta({ minProperties: 1 });
export const PersonalApiCredentialNarrowResponseV1Schema =
	PersonalApiCredentialRevokeResponseV1Schema;
export const PersonalApiCredentialListQueryV1Schema = z.strictObject({
	limit: z.coerce.number().int().min(1).max(100).optional(),
	cursor: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,4096}$/)
		.optional(),
});
export const PersonalApiCredentialPageV1Schema = z.strictObject({
	items: z.array(PersonalApiCredentialMetadataV1Schema).max(100),
	nextCursor: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,4096}$/)
		.nullable(),
});
