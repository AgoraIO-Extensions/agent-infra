CREATE TABLE "platform"."evaluation_derived_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"metadata_expires_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."evaluation_experiments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"principal" jsonb NOT NULL,
	"status" text NOT NULL,
	"revision" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"metadata_expires_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."evaluation_sample_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"experiment_id" uuid NOT NULL,
	"sample_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"execution_id" text,
	"conversation_id" text,
	"binding" jsonb NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."evaluation_score_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sample_task_id" uuid NOT NULL,
	"result_version" text NOT NULL,
	"rubric_id" text NOT NULL,
	"scorer_id" text NOT NULL,
	"scorer_version" text NOT NULL,
	"status" text NOT NULL,
	"revision" bigint NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."evaluation_score_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"score_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" DROP CONSTRAINT "conversation_execution_principal_type_valid";--> statement-breakpoint
ALTER TABLE "platform"."conversations" DROP CONSTRAINT "conversation_principal_type_valid";--> statement-breakpoint
ALTER TABLE "platform"."evaluation_derived_objects" ADD CONSTRAINT "evaluation_derived_objects_dataset_id_evaluation_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "platform"."evaluation_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."evaluation_derived_objects" ADD CONSTRAINT "evaluation_derived_objects_version_id_evaluation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "platform"."evaluation_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."evaluation_experiments" ADD CONSTRAINT "evaluation_experiments_dataset_id_evaluation_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "platform"."evaluation_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."evaluation_experiments" ADD CONSTRAINT "evaluation_experiments_version_id_evaluation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "platform"."evaluation_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."evaluation_sample_tasks" ADD CONSTRAINT "evaluation_sample_tasks_experiment_id_evaluation_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "platform"."evaluation_experiments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."evaluation_score_intents" ADD CONSTRAINT "evaluation_score_intents_sample_task_id_evaluation_sample_tasks_id_fk" FOREIGN KEY ("sample_task_id") REFERENCES "platform"."evaluation_sample_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."evaluation_score_reviews" ADD CONSTRAINT "evaluation_score_reviews_score_id_evaluation_score_intents_id_fk" FOREIGN KEY ("score_id") REFERENCES "platform"."evaluation_score_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluation_derived_expiry" ON "platform"."evaluation_derived_objects" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "evaluation_experiments_principal" ON "platform"."evaluation_experiments" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_sample_variant_unique" ON "platform"."evaluation_sample_tasks" USING btree ("experiment_id","sample_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_sample_execution_unique" ON "platform"."evaluation_sample_tasks" USING btree ("execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_score_intent_unique" ON "platform"."evaluation_score_intents" USING btree ("sample_task_id","result_version","rubric_id","scorer_id","scorer_version");--> statement-breakpoint
CREATE INDEX "evaluation_score_reviews_score" ON "platform"."evaluation_score_reviews" USING btree ("score_id","id");--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_principal_type_valid" CHECK (("platform"."conversation_executions"."principal_type" = 'user' AND "platform"."conversation_executions"."channel_id" <> 'api:application') OR ("platform"."conversation_executions"."principal_type" = 'application' AND "platform"."conversation_executions"."channel_id" in ('api', 'api:application', 'eval')));--> statement-breakpoint
ALTER TABLE "platform"."conversations" ADD CONSTRAINT "conversation_principal_type_valid" CHECK (("platform"."conversations"."principal_type" = 'user' AND "platform"."conversations"."channel_id" <> 'api:application') OR ("platform"."conversations"."principal_type" = 'application' AND "platform"."conversations"."channel_id" in ('api', 'api:application', 'eval')));