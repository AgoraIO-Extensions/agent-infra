import { z } from "zod";
import { Rfc3339TimestampV1Schema } from "../index.ts";

const id = z.uuid();
const revision = z.number().int().positive();
export const EvaluationPrincipalV1Schema = z.strictObject({
	kind: z.enum(["user", "application"]),
	id: z.string().min(1).max(256),
});
export const EvaluationOperationV1Schema = z.enum([
	"create",
	"import",
	"read",
	"run",
	"score",
	"review",
	"analyze",
	"manage_grants",
	"delete",
]);
export const EvaluationDatasetCreateV1Schema = z.strictObject({
	scope: z.string().min(1).max(256),
	name: z.string().min(1).max(120),
});
export const EvaluationVersionReserveV1Schema = z.strictObject({
	expectedRevision: revision,
	sourceVersionId: id.nullable(),
});
export const EvaluationGrantCreateV1Schema = z.strictObject({
	expectedRevision: revision,
	principal: EvaluationPrincipalV1Schema,
	versionIds: z.array(id).min(1).max(100),
	operations: z.array(EvaluationOperationV1Schema).min(1).max(9),
	expiresAt: Rfc3339TimestampV1Schema,
});
export const EvaluationRevisionCommandV1Schema = z.strictObject({
	expectedRevision: revision,
});
export const EvaluationDatasetV1Schema = z.strictObject({
	datasetId: id,
	scope: z.string(),
	name: z.string(),
	revision,
	createdAt: Rfc3339TimestampV1Schema,
	metadataExpiresAt: Rfc3339TimestampV1Schema,
});
export const EvaluationVersionV1Schema = z.strictObject({
	versionId: id,
	datasetId: id,
	sourceVersionId: id.nullable(),
	revision,
	status: z.enum(["pending", "uploading", "available", "deleting", "deleted"]),
	createdAt: Rfc3339TimestampV1Schema,
	expiresAt: Rfc3339TimestampV1Schema,
	metadataExpiresAt: Rfc3339TimestampV1Schema,
	deleteBy: Rfc3339TimestampV1Schema,
	policyId: z.string(),
	policyRevision: revision,
	materialApprovalId: z.string().min(1).max(256).nullable(),
});
export const EvaluationGrantV1Schema = z.strictObject({
	grantId: id,
	datasetId: id,
	versionIds: z.array(id),
	principal: EvaluationPrincipalV1Schema,
	operations: z.array(EvaluationOperationV1Schema),
	expiresAt: Rfc3339TimestampV1Schema,
	revision,
	revoked: z.boolean(),
	issuer: EvaluationPrincipalV1Schema,
	policyId: z.string(),
	policyRevision: revision,
});
export const EvaluationDatasetPageV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	items: z
		.array(
			EvaluationDatasetV1Schema.extend({
				versions: z.array(EvaluationVersionV1Schema),
				grants: z.array(EvaluationGrantV1Schema),
			}),
		)
		.max(1000),
});
export const EvaluationDatasetContentV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	provenance: z.strictObject({ approvalId: z.string().min(1).max(256) }),
	samples: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(256),
				input: z.string().min(1).max(65536),
				context: z.string().min(1).max(65536).nullable(),
				taskType: z.string().min(1).max(256),
				expectedResult: z.string().min(1).max(65536).nullable(),
			}),
		)
		.min(1)
		.max(1000),
	rubric: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(256),
				description: z.string().min(1).max(8192),
			}),
		)
		.min(1)
		.max(100),
});
