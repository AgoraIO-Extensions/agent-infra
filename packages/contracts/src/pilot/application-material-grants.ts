import { z } from "zod";
import { OpaqueIdV1Schema, Rfc3339TimestampV1Schema } from "../index.ts";

export const ApplicationMaterialGrantPrincipalTypeV1Schema = z.enum([
	"user",
	"application",
]);
export const ApplicationMaterialGrantRequestV1Schema = z.strictObject({
	principalType: ApplicationMaterialGrantPrincipalTypeV1Schema,
	principalId: OpaqueIdV1Schema,
	expectedRevision: OpaqueIdV1Schema.optional(),
});
export const ApplicationMaterialGrantRevokeRequestV1Schema = z.strictObject({
	status: z.literal("revoked"),
	expectedRevision: OpaqueIdV1Schema,
});
export const ApplicationMaterialGrantMetadataV1Schema = z.strictObject({
	applicationId: OpaqueIdV1Schema,
	principalType: ApplicationMaterialGrantPrincipalTypeV1Schema,
	principalId: OpaqueIdV1Schema,
	authorizationRevision: OpaqueIdV1Schema,
	createdAt: Rfc3339TimestampV1Schema,
	revokedAt: Rfc3339TimestampV1Schema.nullable(),
});
export const ApplicationMaterialGrantResponseV1Schema = z.strictObject({
	metadata: ApplicationMaterialGrantMetadataV1Schema,
	replayed: z.boolean(),
});
