import { z } from "zod";
import { Rfc3339TimestampV1Schema } from "../index.ts";
import { EvaluationPrincipalV1Schema } from "./evaluation-data.ts";

const id = z.uuid();
const ref = z.string().min(1).max(256);
const revision = z.number().int().positive();
export const EvaluationExperimentCreateV1Schema = z.strictObject({
	datasetId: id,
	versionId: id,
	variantIds: z.array(ref).min(2).max(100),
	scorerRefs: z
		.array(z.strictObject({ scorerId: ref, version: ref }))
		.min(1)
		.max(100),
});
export const EvaluationExperimentV1Schema = z.strictObject({
	experimentId: id,
	datasetId: id,
	versionId: id,
	principal: EvaluationPrincipalV1Schema,
	policyId: ref,
	policyRevision: revision,
	sampleIds: z.array(ref).max(1000),
	variantIds: z.array(ref).max(100),
	scorerRefs: z.array(z.strictObject({ scorerId: ref, version: ref })),
	status: z.enum(["active", "cancelled"]),
	revision,
	createdAt: Rfc3339TimestampV1Schema,
	metadataExpiresAt: Rfc3339TimestampV1Schema,
});
export const EvaluationScoreSubmitV1Schema = z.strictObject({
	expectedRevision: revision,
	result: z.discriminatedUnion("status", [
		z.strictObject({
			status: z.literal("scored"),
			value: z.number().finite(),
			reason: z.string().max(1048576),
		}),
		z.strictObject({
			status: z.literal("not_applicable"),
			value: z.null(),
			reason: z.string().max(1048576),
		}),
	]),
});
export const EvaluationScoreMetadataV1Schema = z.strictObject({
	scoreId: id,
	sampleTaskId: id,
	experimentId: id,
	executionId: ref,
	scorerId: ref,
	scorerVersion: ref,
	status: z.enum([
		"waiting_output",
		"pending",
		"result_ready",
		"awaiting_human",
		"scored",
		"not_applicable",
		"failed",
		"unknown",
	]),
	revision,
	value: z.number().finite().nullable(),
	passed: z.boolean().nullable(),
	failureCode: ref.nullable(),
	scoreActor: EvaluationPrincipalV1Schema.nullable(),
});
export const EvaluationReviewV1Schema = z.strictObject({
	reviewId: id,
	scoreId: id,
	scoreRevision: revision,
	reviewer: EvaluationPrincipalV1Schema,
});
export const EvaluationScorePageV1Schema = z.strictObject({
	items: z.array(EvaluationScoreMetadataV1Schema).max(100),
	nextCursor: id.nullable(),
});

export const EvaluationExperimentPageV1Schema = z.strictObject({
	experiment: EvaluationExperimentV1Schema,
	items: z
		.array(
			z.strictObject({
				sampleTaskId: id,
				scoreIds: z.array(id).max(100),
				sampleId: ref,
				variantId: ref,
				conversationId: ref,
				executionId: ref,
				requested: z.strictObject({
					variantId: ref,
					agentId: ref,
					configurationRevision: revision,
					modelOptionId: ref.nullable(),
					reasoningLevel: ref.nullable(),
					toolEnvironment: ref,
				}),
			}),
		)
		.max(100),
	nextCursor: id.nullable(),
});
