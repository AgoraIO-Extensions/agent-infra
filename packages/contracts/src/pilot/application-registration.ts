import { z } from "zod";
import { OpaqueIdV1Schema, Rfc3339TimestampV1Schema } from "../index.ts";

const name = z
	.string()
	.min(1)
	.max(200)
	.refine(
		(value) =>
			value.trim().length > 0 && !value.includes("\0") && value.isWellFormed(),
	);
export const ApplicationRegistrationRequestV1Schema = z.strictObject({ name });
export const ApplicationMetadataV1Schema = z.strictObject({
	applicationId: OpaqueIdV1Schema,
	name,
	responsibleUserId: OpaqueIdV1Schema,
	status: z.enum(["active", "disabled"]),
	authorizationRevision: OpaqueIdV1Schema,
	createdAt: Rfc3339TimestampV1Schema,
	updatedAt: Rfc3339TimestampV1Schema,
});
export const ApplicationRegistrationResponseV1Schema = z.strictObject({
	metadata: ApplicationMetadataV1Schema,
	replayed: z.boolean(),
});

export const ApplicationDisableRequestV1Schema = z.strictObject({
	status: z.literal("disabled"),
});
