import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import { ApplicationMaterialGrantPrincipalTypeV1Schema } from "./application-material-grants.ts";
import {
	PersonalApiCredentialIssueRequestV1Schema,
	PersonalApiCredentialMetadataV1Schema,
} from "./personal-api-credentials.ts";

export const ApplicationCredentialRecipientV1Schema = z.strictObject({
	principalType: ApplicationMaterialGrantPrincipalTypeV1Schema,
	principalId: OpaqueIdV1Schema,
});
const issuance = PersonalApiCredentialIssueRequestV1Schema.extend({
	recipient: ApplicationCredentialRecipientV1Schema,
});
export const ApplicationApiCredentialRequestV1Schema = z.discriminatedUnion(
	"operation",
	[
		issuance.extend({ operation: z.literal("issue") }),
		issuance.extend({
			operation: z.literal("rotate"),
			credentialId: OpaqueIdV1Schema,
		}),
	],
);
export const ApplicationApiCredentialMetadataV1Schema =
	PersonalApiCredentialMetadataV1Schema.extend({
		applicationId: OpaqueIdV1Schema,
	});
export const ApplicationCredentialDeliveryReceiptV1Schema = z.strictObject({
	attemptId: OpaqueIdV1Schema,
	recipient: ApplicationCredentialRecipientV1Schema,
	grantRevision: OpaqueIdV1Schema,
	status: z.enum([
		"delivery_pending",
		"delivery_in_flight",
		"accepted",
		"failed",
		"unknown",
	]),
});
/** Management and replay responses never carry credential material. */
export const ApplicationApiCredentialResponseV1Schema = z.strictObject({
	metadata: ApplicationApiCredentialMetadataV1Schema,
	delivery: ApplicationCredentialDeliveryReceiptV1Schema,
	replayed: z.boolean(),
});

export const ApplicationApiCredentialListQueryV1Schema = z.strictObject({
	limit: z.coerce.number().int().min(1).max(100).default(20),
	cursor: OpaqueIdV1Schema.optional(),
});
export const ApplicationApiCredentialPageV1Schema = z.strictObject({
	items: z.array(ApplicationApiCredentialMetadataV1Schema).max(100),
	nextCursor: OpaqueIdV1Schema.nullable(),
});
export const ApplicationApiCredentialRevocationV1Schema = z.strictObject({
	metadata: ApplicationApiCredentialMetadataV1Schema,
	replayed: z.boolean(),
});
