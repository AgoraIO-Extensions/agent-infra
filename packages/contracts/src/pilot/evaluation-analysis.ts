import { z } from "zod";
import { Rfc3339TimestampV1Schema } from "../index.ts";
import { EvaluationPrincipalV1Schema } from "./evaluation-data.ts";
import {
	EvaluationExperimentV1Schema,
	EvaluationRequestedEvidenceV1Schema,
	EvaluationScoreMetadataV1Schema,
} from "./evaluation-experiments.ts";

const ref = z.string().min(1).max(256);
const count = z.number().int().nonnegative();
const instant = Rfc3339TimestampV1Schema;
export const TaskFeedbackCategoryV1Schema = z.enum([
	"correctness",
	"relevance",
	"instruction_following",
	"format",
	"tool_use",
	"incomplete",
	"performance",
	"other",
]);
export const EvaluationModelConditionV1Schema = z.strictObject({
	configVersion: ref,
	modelOptionId: ref,
	modelId: ref,
	reasoningLevel: ref.nullable(),
});
const measure = z.strictObject({
	value: count.nullable(),
	observed: count,
	total: count,
});
export const EvaluationModelFactsV1Schema = z.strictObject({
	attempts: z.array(
		z.strictObject({
			operationRef: ref,
			attemptRef: ref,
			sequence: count,
			phase: z.enum(["intent", "started", "completed", "failed", "unknown"]),
			observed: z.boolean(),
			condition: EvaluationModelConditionV1Schema,
			inputTokens: count.nullable(),
			outputTokens: count.nullable(),
			cachedInputTokens: count.nullable(),
			durationMs: count.nullable(),
		}),
	),
	observedAttempts: count,
	conditions: z.array(EvaluationModelConditionV1Schema),
	conditionStatus: z.enum(["missing", "single", "mixed"]),
	inputTokens: measure,
	outputTokens: measure,
	cachedInputTokens: measure,
	modelDurationMs: measure,
});
export const TaskFeedbackSubmitV1Schema = z.strictObject({
	expectedRevision: count,
	expectedCondition: z.string().regex(/^[a-f0-9]{64}$/),
	useful: z.boolean(),
	categories: z.array(TaskFeedbackCategoryV1Schema).max(8),
});
export const TaskFeedbackRecordV1Schema = z.strictObject({
	executionId: ref,
	principal: EvaluationPrincipalV1Schema,
	agentId: ref,
	revision: count,
	conditionDigest: z.string().regex(/^[a-f0-9]{64}$/),
	useful: z.boolean(),
	categories: z.array(TaskFeedbackCategoryV1Schema).max(8),
	policyId: ref,
	policyRevision: count,
	createdAt: instant,
	updatedAt: instant,
	metadataExpiresAt: instant,
});
export const TaskFeedbackContextV1Schema = z.strictObject({
	executionId: ref,
	eligibility: z.enum(["eligible", "not_terminal", "offline_evaluation"]),
	terminalObservedAt: instant.nullable(),
	conditions: z.array(EvaluationModelConditionV1Schema),
	conditionDigest: z.string().regex(/^[a-f0-9]{64}$/),
	revision: count,
	feedback: TaskFeedbackRecordV1Schema.nullable(),
	feedbackCurrent: z.boolean(),
	categories: z.array(TaskFeedbackCategoryV1Schema).max(8),
});
export const TaskFeedbackSummaryQueryV1Schema = z.strictObject({
	from: instant,
	to: instant,
	modelId: ref.optional(),
	configVersion: ref.optional(),
});
export const TaskFeedbackSummaryV1Schema = z.strictObject({
	query: TaskFeedbackSummaryQueryV1Schema,
	agentId: ref,
	view: z.enum(["self", "owner"]),
	observedAt: instant,
	eligibleTasks: count,
	feedbackTasks: count,
	unfeedbackTasks: count,
	usefulTasks: count,
	notUsefulTasks: count,
	conditionChangedTasks: count,
	missingActualTasks: count,
	terminalTimeMissingTasks: count,
	feedbackRate: z.number().min(0).max(1).nullable(),
	classification: z.strictObject({
		correctness: count,
		relevance: count,
		instruction_following: count,
		format: count,
		tool_use: count,
		incomplete: count,
		performance: count,
		other: count,
	}),
	conditions: z.array(
		z.strictObject({
			conditions: z.array(EvaluationModelConditionV1Schema),
			tasks: count,
			feedbackTasks: count,
		}),
	),
});
const counts = z.strictObject({
	fixedSamples: count,
	scored: count,
	passed: count,
	notPassed: count,
	unscored: count,
	scoreError: count,
	notApplicable: count,
	businessFailed: count,
	missing: count,
});
const requested = z.strictObject({
	variantId: ref,
	agentId: ref,
	configurationRevision: count,
	modelOptionId: ref.nullable(),
	reasoningLevel: ref.nullable(),
	toolEnvironment: ref,
});
const score = z.strictObject({
	scoreId: z.uuid(),
	scorerId: ref,
	scorerVersion: ref,
	source: z.enum(["rule", "human", "model"]),
	scoringModel: ref.nullable(),
	status: EvaluationScoreMetadataV1Schema.shape.status,
	value: z.number().nullable(),
	passed: z.boolean().nullable(),
	failureCode: ref.nullable(),
});
export const EvaluationAnalysisSummaryV1Schema = z.strictObject({
	experimentId: z.uuid(),
	datasetId: z.uuid(),
	versionId: z.uuid(),
	fixedSamples: count,
	observedAt: instant,
	contentAvailable: z.boolean(),
	taskTypesAvailable: z.boolean(),
	groups: z.array(
		z.strictObject({
			variantId: ref,
			scorerId: ref,
			scorerVersion: ref,
			counts,
			taskTypes: z.array(z.strictObject({ taskType: ref.nullable(), counts })),
			passRate: z.number().min(0).max(1).nullable(),
		}),
	),
	pairs: z.array(
		z.strictObject({
			baselineId: ref,
			candidateId: ref,
			counts: z.strictObject({
				fixedSamples: count,
				comparable: count,
				missingConditions: count,
				differentEnvironment: count,
				mixedConditions: count,
				unknownTarget: count,
				actualDrift: count,
				nonTargetDrift: count,
				conditionsChanged: count,
			}),
			samples: z.array(
				z.strictObject({
					sampleId: ref,
					taskType: ref.nullable(),
					status: z.enum([
						"comparable",
						"missing_conditions",
						"different_environment",
						"mixed_conditions",
						"unknown_target",
						"actual_drift",
						"non_target_drift",
					]),
					conditionsChanged: z.boolean(),
					baseline: z.uuid().nullable(),
					candidate: z.uuid().nullable(),
				}),
			),
		}),
	),
	items: z
		.array(
			z.strictObject({
				sampleTaskId: z.uuid(),
				sampleId: ref,
				variantId: ref,
				executionId: ref,
				status: z.enum([
					"waiting",
					"submitted",
					"processing",
					"completed",
					"failed",
					"cancelled",
					"unknown",
				]),
				requested,
				requestedEvidence: EvaluationRequestedEvidenceV1Schema.nullable(),
				preparedRuntime: z
					.strictObject({
						configurationRevision: count,
						imageDigest: ref,
						resourceConfigurationHash: ref,
					})
					.nullable(),
				actual: EvaluationModelFactsV1Schema,
				taskElapsedMs: count.nullable(),
				scores: z.array(score),
			}),
		)
		.max(1000),
});
const retained = <T extends z.ZodType>(value: T) =>
	z.union([
		z.strictObject({ contentStatus: z.literal("available"), value }),
		z.strictObject({
			contentStatus: z.enum(["expired", "deleting", "deleted"]),
			value: z.null(),
		}),
	]);
const retainedOutput = retained(
	z.strictObject({
		text: z.string().max(1048576),
		executionId: ref,
		resultVersion: ref,
	}),
);
const retainedScore = retained(
	z.union([
		z.strictObject({
			status: z.literal("scored"),
			value: z.number().finite(),
			reason: z.string().max(1048576),
			passed: z.boolean().optional(),
		}),
		z.strictObject({
			status: z.literal("not_applicable"),
			value: z.null(),
			reason: z.string().max(1048576),
			passed: z.null().optional(),
		}),
	]),
);
export const EvaluationAnalysisReviewV1Schema = z.strictObject({
	reviewId: z.uuid(),
	scoreId: z.uuid(),
	scoreRevision: count,
	reviewer: EvaluationPrincipalV1Schema,
	result: retainedScore,
});
export const EvaluationAnalysisDetailV1Schema = z.strictObject({
	nextCursor: z.uuid().nullable(),
	experimentId: z.uuid(),
	sampleTaskId: z.uuid(),
	sample: z.strictObject({
		id: ref,
		input: z.string().max(65536),
		context: z.string().max(65536).nullable(),
		taskType: ref,
		expectedResult: z.string().max(65536).nullable(),
	}),
	scores: z.array(
		score.omit({ failureCode: true }).extend({
			output: retainedOutput.nullable(),
			reason: retainedScore.nullable(),
			reviews: z.array(EvaluationAnalysisReviewV1Schema).max(100),
			nextReviewCursor: z.uuid().nullable(),
		}),
	),
});
export const EvaluationHistoryV1Schema = z.strictObject({
	items: z.array(EvaluationExperimentV1Schema).max(100),
	nextCursor: z.uuid().nullable(),
});
export const EvaluationChoiceCatalogV1Schema = z.strictObject({
	datasetId: z.uuid(),
	versionId: z.uuid(),
	policyId: ref,
	policyRevision: count,
	maximumTasks: count,
	variants: z
		.array(
			requested.extend({
				billing: z.strictObject({
					purpose: z.literal("agent-default"),
					subjectId: ref,
				}),
				name: ref,
			}),
		)
		.max(100),
	scorers: z
		.array(
			z.strictObject({
				scorerId: ref,
				version: ref,
				rubricId: ref,
				source: z.enum(["rule", "human", "model"]),
				scoringModel: ref.nullable(),
				minimum: z.number(),
				maximum: z.number(),
				passThreshold: z.number(),
			}),
		)
		.max(100),
});
export const EvaluationWorklistV1Schema = z.strictObject({
	purpose: z.enum(["score", "review"]),
	items: z.array(EvaluationScoreMetadataV1Schema).max(100),
	nextCursor: z.uuid().nullable(),
});

export const EvaluationQueryTooLargeV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	code: z.literal("EVALUATION_QUERY_TOO_LARGE"),
	message: z.literal(
		"Query range is too large. Narrow the time window or filters.",
	),
	traceId: z.string().min(1),
	retryable: z.literal(false),
});
