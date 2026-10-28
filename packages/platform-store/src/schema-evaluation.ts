import {
	bigint,
	foreignKey,
	index,
	jsonb,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { platformSchema as platform } from "./schema-common.js";
import { conversationExecutions } from "./schema-conversations.js";

export const evaluationPolicies = platform.table("evaluation_policies", {
	id: text("id").primaryKey(),
	revision: bigint("revision", { mode: "number" }).notNull(),
	digest: text("digest").notNull(),
});
export const evaluationDatasets = platform.table("evaluation_datasets", {
	id: uuid("id").primaryKey(),
	scope: text("scope").notNull(),
	data: jsonb("data").notNull(),
});
export const evaluationVersions = platform.table(
	"evaluation_versions",
	{
		id: uuid("id").primaryKey(),
		datasetId: uuid("dataset_id")
			.notNull()
			.references(() => evaluationDatasets.id),
		status: text("status").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		metadataExpiresAt: timestamp("metadata_expires_at", {
			withTimezone: true,
		}).notNull(),
		data: jsonb("data").notNull(),
	},
	(table) => [
		index("evaluation_versions_expiry").on(table.expiresAt, table.id),
		index("evaluation_versions_dataset").on(table.datasetId, table.id),
	],
);
export const evaluationGrants = platform.table(
	"evaluation_grants",
	{
		id: uuid("id").primaryKey(),
		datasetId: uuid("dataset_id")
			.notNull()
			.references(() => evaluationDatasets.id),
		data: jsonb("data").notNull(),
	},
	(table) => [index("evaluation_grants_dataset").on(table.datasetId, table.id)],
);

export const evaluationExperiments = platform.table(
	"evaluation_experiments",
	{
		id: uuid("id").primaryKey(),
		datasetId: uuid("dataset_id")
			.notNull()
			.references(() => evaluationDatasets.id),
		versionId: uuid("version_id")
			.notNull()
			.references(() => evaluationVersions.id),
		principal: jsonb("principal").notNull(),
		status: text("status").notNull(),
		revision: bigint("revision", { mode: "number" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		metadataExpiresAt: timestamp("metadata_expires_at", {
			withTimezone: true,
		}).notNull(),
		data: jsonb("data").notNull(),
	},
	(t) => [index("evaluation_experiments_principal").on(t.createdAt, t.id)],
);
export const evaluationSampleTasks = platform.table(
	"evaluation_sample_tasks",
	{
		id: uuid("id").primaryKey(),
		experimentId: uuid("experiment_id").notNull(),
		sampleId: text("sample_id").notNull(),
		variantId: text("variant_id").notNull(),
		executionId: text("execution_id"),
		conversationId: text("conversation_id"),
		binding: jsonb("binding").notNull(),
		data: jsonb("data").notNull(),
	},
	(t) => [
		foreignKey({
			name: "evaluation_sample_experiment_fk",
			columns: [t.experimentId],
			foreignColumns: [evaluationExperiments.id],
		}),
		uniqueIndex("evaluation_sample_variant_unique").on(
			t.experimentId,
			t.sampleId,
			t.variantId,
		),
		uniqueIndex("evaluation_sample_execution_unique").on(t.executionId),
	],
);
export const evaluationScoreIntents = platform.table(
	"evaluation_score_intents",
	{
		id: uuid("id").primaryKey(),
		sampleTaskId: uuid("sample_task_id").notNull(),
		resultVersion: text("result_version").notNull(),
		rubricId: text("rubric_id").notNull(),
		scorerId: text("scorer_id").notNull(),
		scorerVersion: text("scorer_version").notNull(),
		status: text("status").notNull(),
		revision: bigint("revision", { mode: "number" }).notNull(),
		data: jsonb("data").notNull(),
	},
	(t) => [
		foreignKey({
			name: "evaluation_score_sample_fk",
			columns: [t.sampleTaskId],
			foreignColumns: [evaluationSampleTasks.id],
		}),
		uniqueIndex("evaluation_score_intent_unique").on(
			t.sampleTaskId,
			t.resultVersion,
			t.rubricId,
			t.scorerId,
			t.scorerVersion,
		),
	],
);
export const evaluationScoreReviews = platform.table(
	"evaluation_score_reviews",
	{
		id: uuid("id").primaryKey(),
		scoreId: uuid("score_id").notNull(),
		revision: bigint("revision", { mode: "number" }).notNull(),
		data: jsonb("data").notNull(),
	},
	(t) => [
		foreignKey({
			name: "evaluation_review_score_fk",
			columns: [t.scoreId],
			foreignColumns: [evaluationScoreIntents.id],
		}),
		index("evaluation_score_reviews_score").on(t.scoreId, t.id),
	],
);
export const evaluationDerivedObjects = platform.table(
	"evaluation_derived_objects",
	{
		id: uuid("id").primaryKey(),
		datasetId: uuid("dataset_id")
			.notNull()
			.references(() => evaluationDatasets.id),
		versionId: uuid("version_id")
			.notNull()
			.references(() => evaluationVersions.id),
		kind: text("kind").notNull(),
		status: text("status").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		metadataExpiresAt: timestamp("metadata_expires_at", {
			withTimezone: true,
		}).notNull(),
		data: jsonb("data").notNull(),
	},
	(t) => [index("evaluation_derived_expiry").on(t.expiresAt, t.id)],
);

export const taskFeedback = platform.table(
	"task_feedback",
	{
		executionId: text("execution_id").primaryKey(),
		principalType: text("principal_type").notNull(),
		principalId: text("principal_id").notNull(),
		agentId: text("agent_id").notNull(),
		revision: bigint("revision", { mode: "number" }).notNull(),
		metadataExpiresAt: timestamp("metadata_expires_at", {
			withTimezone: true,
		}).notNull(),
		data: jsonb("data").notNull(),
	},
	(t) => [
		foreignKey({
			name: "task_feedback_execution_fk",
			columns: [t.executionId],
			foreignColumns: [conversationExecutions.executionId],
		}),
		index("task_feedback_metadata_expiry_idx").on(
			t.metadataExpiresAt,
			t.executionId,
		),
	],
);
