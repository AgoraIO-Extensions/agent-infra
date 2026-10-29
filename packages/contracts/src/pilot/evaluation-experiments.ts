import { z } from "zod";
import { Rfc3339TimestampV1Schema } from "../index.ts";
import { EvaluationPrincipalV1Schema } from "./evaluation-data.ts";

const id = z.uuid();
const ref = z.string().min(1).max(256);
const revision = z.number().int().positive();
export const EvaluationComparisonTargetsV1Schema = z
	.array(z.enum(["model", "configuration", "template"]))
	.min(1)
	.max(3);
export const EvaluationRequestedEvidenceV1Schema = z.strictObject({
	configurationRevision: revision,
	configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
	imageDigest: ref,
	templateId: ref.nullable(),
	model: z
		.strictObject({
			configVersion: ref,
			modelOptionId: ref,
			modelId: ref,
			reasoningLevel: ref.nullable(),
		})
		.nullable(),
});
export const EvaluationExperimentCreateV1Schema = z.strictObject({
	comparisonTargets: EvaluationComparisonTargetsV1Schema.optional(),
	datasetId: id,
	versionId: id,
	variantIds: z.array(ref).min(2).max(100),
	scorerRefs: z
		.array(z.strictObject({ scorerId: ref, version: ref }))
		.min(1)
		.max(100),
});
export const EvaluationExperimentV1Schema = z.strictObject({
	comparisonTargets: EvaluationComparisonTargetsV1Schema.optional(),
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
	source: z.enum(["rule", "human", "model"]).optional(),
	scoringModel: ref.nullable().optional(),
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
export const EvaluationScoringContextV1Schema = z.strictObject({
	scoreId: id,
	revision,
	sampleTaskId: id,
	experimentId: id,
	executionId: ref,
	status: EvaluationScoreMetadataV1Schema.shape.status,
	resultVersion: ref.nullable(),
	sample: z.strictObject({
		id: ref,
		input: z.string().max(65536),
		context: z.string().max(65536).nullable(),
		expectedResult: z.string().max(65536).nullable(),
		taskType: ref,
	}),
	rubric: z.strictObject({ id: ref, description: z.string().max(8192) }),
	scorer: z.strictObject({
		source: z.enum(["rule", "human", "model"]).optional(),
		scoringModel: ref.nullable().optional(),
		scorerId: ref,
		version: ref,
		minimum: z.number().finite(),
		maximum: z.number().finite(),
		passThreshold: z.number().finite(),
	}),
	output: z
		.strictObject({
			text: z.string().max(1048576),
			executionId: ref,
			resultVersion: ref,
		})
		.nullable(),
	score: EvaluationScoreSubmitV1Schema.shape.result.nullable(),
});
export const EvaluationReviewPageV1Schema = z.strictObject({
	items: z
		.array(
			z.discriminatedUnion("contentStatus", [
				EvaluationReviewV1Schema.extend({
					contentStatus: z.literal("available"),
					result: EvaluationScoreSubmitV1Schema.shape.result,
				}),
				EvaluationReviewV1Schema.extend({
					contentStatus: z.literal("expired"),
					result: z.null(),
				}),
				EvaluationReviewV1Schema.extend({
					contentStatus: z.literal("deleting"),
					result: z.null(),
				}),
				EvaluationReviewV1Schema.extend({
					contentStatus: z.literal("deleted"),
					result: z.null(),
				}),
			]),
		)
		.max(100),
	nextCursor: id.nullable(),
});
export const EvaluationScorePageV1Schema = z.strictObject({
	items: z.array(EvaluationScoreMetadataV1Schema).max(100),
	nextCursor: id.nullable(),
});

const factBase = {
	operationRef: ref,
	attemptRef: ref,
	sequence: z.number().int().nonnegative(),
	phase: z.enum(["intent", "started", "completed", "failed", "unknown"]),
	durationMs: z.number().nonnegative().nullable(),
};
const actual = z.strictObject({
	status: z.enum([
		"waiting",
		"submitted",
		"processing",
		"unknown",
		"completed",
		"failed",
		"cancelled",
	]),
	billing: z
		.strictObject({
			purpose: z.literal("agent-default"),
			subjectId: ref,
			keyVersion: revision,
		})
		.nullable(),
	lastSequence: z.number().int().nonnegative(),
	runtimeObserved: z.boolean(),
	preparedRuntime: z
		.strictObject({
			configurationRevision: revision,
			imageDigest: ref,
			resourceConfigurationHash: ref,
		})
		.nullable(),
	facts: z.strictObject({
		actualModelObserved: z.boolean(),
		models: z
			.array(
				z.strictObject({
					...factBase,
					observed: z.boolean(),
					model: z.strictObject({
						configVersion: ref,
						modelOptionId: ref,
						modelId: ref,
						reasoningLevel: ref.optional(),
					}),
					usage: z
						.strictObject({
							inputTokens: z.number().nonnegative().optional(),
							outputTokens: z.number().nonnegative().optional(),
							cachedInputTokens: z.number().nonnegative().optional(),
						})
						.nullable(),
				}),
			)
			.max(100),
		tools: z.array(z.strictObject({ ...factBase, toolId: ref })).max(100),
	}),
	factsTruncated: z.boolean(),
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
				actual: actual.nullable(),
				requestedEvidence: EvaluationRequestedEvidenceV1Schema.optional(),
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
