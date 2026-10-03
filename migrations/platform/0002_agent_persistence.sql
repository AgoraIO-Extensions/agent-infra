CREATE TYPE "platform"."agent_availability_target_type" AS ENUM('user', 'organization');--> statement-breakpoint
CREATE TYPE "platform"."agent_desired_state" AS ENUM('running', 'stopped');--> statement-breakpoint
CREATE TYPE "platform"."agent_failure_code" AS ENUM('creation_not_ready', 'health_check_failed', 'workload_unavailable', 'reconciliation_failed');--> statement-breakpoint
CREATE TYPE "platform"."agent_management_operation" AS ENUM('update_application', 'withdraw_application', 'approve_application', 'reject_application', 'stop_agent', 'restart_agent', 'retry_agent_creation', 'disable_agent', 'observe_creation_succeeded', 'observe_creation_failed', 'observe_service_starting', 'observe_service_ready', 'observe_service_updating', 'observe_service_unavailable');--> statement-breakpoint
CREATE TYPE "platform"."agent_management_status" AS ENUM('pending_approval', 'withdrawn', 'rejected', 'creating', 'available', 'stopped', 'creation_failed', 'disabled');--> statement-breakpoint
CREATE TYPE "platform"."agent_management_subject_type" AS ENUM('agent_application', 'agent');--> statement-breakpoint
CREATE TYPE "platform"."agent_service_availability" AS ENUM('ready', 'starting', 'updating', 'unavailable');--> statement-breakpoint
CREATE TABLE "platform"."agent_availability" (
	"agent_id" text NOT NULL,
	"target_type" "platform"."agent_availability_target_type" NOT NULL,
	"target_id" text NOT NULL,
	CONSTRAINT "agent_availability_agent_id_target_type_target_id_pk" PRIMARY KEY("agent_id","target_type","target_id"),
	CONSTRAINT "agent_availability_target_id_non_empty" CHECK (char_length("platform"."agent_availability"."target_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."agent_management_history" (
	"agent_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"application_id" text NOT NULL,
	"subject_type" "platform"."agent_management_subject_type" NOT NULL,
	"subject_id" text NOT NULL,
	"operation" "platform"."agent_management_operation" NOT NULL,
	"from_status" "platform"."agent_management_status" NOT NULL,
	"to_status" "platform"."agent_management_status" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_management_history_agent_id_revision_pk" PRIMARY KEY("agent_id","revision"),
	CONSTRAINT "agent_management_history_revision_safe" CHECK ("platform"."agent_management_history"."revision" between 1 and 9007199254740991),
	CONSTRAINT "agent_management_history_subject_id_non_empty" CHECK (char_length("platform"."agent_management_history"."subject_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "platform"."agent_configuration_revisions" DROP CONSTRAINT "agent_configuration_revision_number_positive";--> statement-breakpoint
ALTER TABLE "platform"."agents" DROP CONSTRAINT "agent_configuration_revision_positive";--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ALTER COLUMN "status" SET DATA TYPE "platform"."agent_management_status" USING "status"::"platform"."agent_management_status";--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ALTER COLUMN "status" SET DEFAULT 'pending_approval'::"platform"."agent_management_status";--> statement-breakpoint
ALTER TABLE "platform"."agent_configuration_revisions" ALTER COLUMN "revision" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "platform"."agents" ALTER COLUMN "current_configuration_revision" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "platform"."agents" ALTER COLUMN "current_configuration_revision" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD COLUMN "management_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD COLUMN "approval_revision" bigint;--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD COLUMN "decision_reason" text;--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD COLUMN "service_availability" "platform"."agent_service_availability";--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD COLUMN "desired_state" "platform"."agent_desired_state" DEFAULT 'stopped' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD COLUMN "workload_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD COLUMN "fence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD COLUMN "failure_code" "platform"."agent_failure_code";--> statement-breakpoint
ALTER TABLE "platform"."agent_configuration_revisions" ADD COLUMN "configuration" jsonb;--> statement-breakpoint
ALTER TABLE "platform"."agents" ADD COLUMN "authorization_revision" text;--> statement-breakpoint
ALTER TABLE "platform"."audit_events" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "platform"."agent_availability" ADD CONSTRAINT "agent_availability_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."agent_management_history" ADD CONSTRAINT "agent_management_history_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."agent_management_history" ADD CONSTRAINT "agent_management_history_application_fk" FOREIGN KEY ("application_id") REFERENCES "platform"."agent_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_availability_target_lookup_idx" ON "platform"."agent_availability" USING btree ("target_type","target_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_management_history_application_idx" ON "platform"."agent_management_history" USING btree ("application_id","revision");--> statement-breakpoint
CREATE INDEX "agent_application_applicant_status_idx" ON "platform"."agent_applications" USING btree ("applicant_id","status");--> statement-breakpoint
CREATE INDEX "agent_application_agent_status_idx" ON "platform"."agent_applications" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_owner_lookup_idx" ON "platform"."agent_owners" USING btree ("owner_id","agent_id");--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_application_management_revision_safe" CHECK ("platform"."agent_applications"."management_revision" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_application_approval_revision_safe" CHECK ("platform"."agent_applications"."approval_revision" IS NULL OR "platform"."agent_applications"."approval_revision" between 1 and least("platform"."agent_applications"."management_revision", 9007199254740991));--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_application_workload_revision_safe" CHECK ("platform"."agent_applications"."workload_revision" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_application_fence_safe" CHECK ("platform"."agent_applications"."fence" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_application_decision_reason_bounded" CHECK ("platform"."agent_applications"."decision_reason" IS NULL OR (char_length("platform"."agent_applications"."decision_reason") > 0 AND octet_length("platform"."agent_applications"."decision_reason") <= 4096));--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_application_management_state_valid" CHECK ((
				"platform"."agent_applications"."status" in ('pending_approval', 'withdrawn', 'rejected')
				and "platform"."agent_applications"."approval_revision" is null
				and "platform"."agent_applications"."desired_state" = 'stopped'
				and "platform"."agent_applications"."service_availability" is null
				and "platform"."agent_applications"."workload_revision" = 0
				and "platform"."agent_applications"."fence" = 0
				and "platform"."agent_applications"."failure_code" is null
			) or (
				"platform"."agent_applications"."status" not in ('pending_approval', 'withdrawn', 'rejected')
				and "platform"."agent_applications"."approval_revision" is not null
				and "platform"."agent_applications"."workload_revision" >= 1
				and "platform"."agent_applications"."fence" >= 1
				and (
					("platform"."agent_applications"."status" in ('creating', 'creation_failed') and "platform"."agent_applications"."desired_state" = 'running' and "platform"."agent_applications"."service_availability" is null)
					or ("platform"."agent_applications"."status" = 'available' and "platform"."agent_applications"."desired_state" = 'running' and "platform"."agent_applications"."service_availability" is not null)
					or ("platform"."agent_applications"."status" in ('stopped', 'disabled') and "platform"."agent_applications"."desired_state" = 'stopped' and "platform"."agent_applications"."service_availability" is null)
				)
			));--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_application_decision_reason_state" CHECK (("platform"."agent_applications"."status" = 'rejected') = ("platform"."agent_applications"."decision_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_application_failure_code_state" CHECK (("platform"."agent_applications"."status" <> 'creation_failed' OR "platform"."agent_applications"."failure_code" IS NOT NULL)
				AND ("platform"."agent_applications"."status" <> 'available' OR "platform"."agent_applications"."service_availability" <> 'unavailable' OR "platform"."agent_applications"."failure_code" IS NOT NULL)
				AND ("platform"."agent_applications"."status" <> 'available' OR "platform"."agent_applications"."service_availability" <> 'ready' OR "platform"."agent_applications"."failure_code" IS NULL));--> statement-breakpoint
ALTER TABLE "platform"."agent_configuration_revisions" ADD CONSTRAINT "agent_configuration_revision_number_safe" CHECK ("platform"."agent_configuration_revisions"."revision" between 1 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "platform"."agent_configuration_revisions" ADD CONSTRAINT "agent_configuration_identity_matches" CHECK ("platform"."agent_configuration_revisions"."configuration" IS NULL OR (
				jsonb_typeof("platform"."agent_configuration_revisions"."configuration") = 'object'
				and "platform"."agent_configuration_revisions"."configuration" @> jsonb_build_object(
					'schemaVersion', 1,
					'agentId', "platform"."agent_configuration_revisions"."agent_id",
					'revision', "platform"."agent_configuration_revisions"."revision"
				)
			));--> statement-breakpoint
ALTER TABLE "platform"."agents" ADD CONSTRAINT "agent_configuration_revision_safe" CHECK ("platform"."agents"."current_configuration_revision" between 1 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "platform"."agents" ADD CONSTRAINT "agent_authorization_revision_non_empty" CHECK ("platform"."agents"."authorization_revision" IS NULL OR char_length("platform"."agents"."authorization_revision") > 0);
