import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import {
	ApplicationApiCredentialRequestV1Schema,
	ApplicationCredentialRecipientV1Schema,
} from "./application-api-credentials.ts";
import { PersonalApiCredentialMetadataV1Schema } from "./personal-api-credentials.ts";

export const ApplicationCredentialMaterialIntentV1Schema = z.discriminatedUnion(
	"operation",
	[
		ApplicationApiCredentialRequestV1Schema.options[0].extend({
			schemaVersion: z.literal(1),
		}),
		ApplicationApiCredentialRequestV1Schema.options[1].extend({
			schemaVersion: z.literal(1),
		}),
	],
);
export const ApplicationCredentialMaterialMetadataV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	applicationId: OpaqueIdV1Schema,
	credentialId: OpaqueIdV1Schema,
	attemptId: OpaqueIdV1Schema,
	recipient: ApplicationCredentialRecipientV1Schema,
	grantRevision: OpaqueIdV1Schema,
	scopes: PersonalApiCredentialMetadataV1Schema.shape.scopes,
	credentialExpiresAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
	status: z.enum([
		"delivery_pending",
		"delivery_in_flight",
		"accepted",
		"failed",
		"unknown",
	]),
	phase: z.enum(["pending", "claimed", "generated", "transmitted", "accepted"]),
	fence: OpaqueIdV1Schema.nullable(),
	replayed: z.boolean(),
});
export const ApplicationCredentialMaterialReceiveV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
});
export const ApplicationCredentialMaterialConfirmV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	credentialId: OpaqueIdV1Schema,
	fence: OpaqueIdV1Schema,
});
export const ApplicationCredentialMaterialResponseV1Schema =
	z.discriminatedUnion("kind", [
		z.strictObject({
			schemaVersion: z.literal(1),
			kind: z.literal("material"),
			delivery: ApplicationCredentialMaterialMetadataV1Schema,
			material: z.string().regex(/^papi_[A-Za-z0-9_-]{43}$/),
		}),
		z.strictObject({
			schemaVersion: z.literal(1),
			kind: z.literal("metadata"),
			delivery: ApplicationCredentialMaterialMetadataV1Schema,
		}),
	]);
