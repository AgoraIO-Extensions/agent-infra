CREATE TABLE "platform"."session_sandbox_allocations" (
	"sandbox_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"principal_type" varchar(16) NOT NULL,
	"channel_id" text NOT NULL,
	"session_generation" bigint NOT NULL,
	"resource_name" text NOT NULL,
	"workspace_scope" text NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"resource_fence" bigint DEFAULT 0 NOT NULL,
	"desired_state" varchar(16) DEFAULT 'running' NOT NULL,
	"resource_policy" jsonb,
	"resource_observation" jsonb,
	CONSTRAINT "session_sandbox_id_uuid" CHECK ("platform"."session_sandbox_allocations"."sandbox_id" ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
	CONSTRAINT "session_sandbox_generation_safe" CHECK ("platform"."session_sandbox_allocations"."session_generation" between 1 and 9007199254740991),
	CONSTRAINT "session_sandbox_resource_binding" CHECK ("platform"."session_sandbox_allocations"."resource_name" = 'sandbox-' || "platform"."session_sandbox_allocations"."sandbox_id"),
	CONSTRAINT "session_sandbox_workspace_binding" CHECK ("platform"."session_sandbox_allocations"."workspace_scope" = "platform"."session_sandbox_allocations"."sandbox_id"),
	CONSTRAINT "session_sandbox_status_valid" CHECK ("platform"."session_sandbox_allocations"."status" in ('allocated', 'applying', 'observed', 'ready', 'stopped', 'unknown', 'unavailable')),
	CONSTRAINT "session_sandbox_resource_fence_safe" CHECK ("platform"."session_sandbox_allocations"."resource_fence" between 0 and 9007199254740991),
	CONSTRAINT "session_sandbox_desired_state_valid" CHECK ("platform"."session_sandbox_allocations"."desired_state" in ('running', 'stopped'))
);
--> statement-breakpoint
ALTER TABLE "platform"."conversation_audit_events" DROP CONSTRAINT "conversation_audit_execution_binding";--> statement-breakpoint
ALTER TABLE "platform"."conversation_audit_events" DROP CONSTRAINT "conversation_audit_details_binding";--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "platform"."session_sandbox_allocations" ADD CONSTRAINT "session_sandbox_conversation_binding_fk" FOREIGN KEY ("conversation_id","agent_id","actor_id","principal_type","channel_id") REFERENCES "platform"."conversations"("id","agent_id","actor_id","principal_type","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_sandbox_conversation_unique" ON "platform"."session_sandbox_allocations" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_sandbox_resource_unique" ON "platform"."session_sandbox_allocations" USING btree ("resource_name");--> statement-breakpoint
CREATE UNIQUE INDEX "session_sandbox_workspace_unique" ON "platform"."session_sandbox_allocations" USING btree ("workspace_scope");--> statement-breakpoint
ALTER TABLE "platform"."conversation_audit_events" ADD CONSTRAINT "conversation_audit_execution_binding" CHECK ((
					"platform"."conversation_audit_events"."execution_id" IS NULL
					AND "platform"."conversation_audit_events"."action" in ('conversation.model_selection.updated', 'conversation.sandbox.allocated', 'conversation.sandbox.observed')
				) OR (
					"platform"."conversation_audit_events"."execution_id" IS NOT NULL
					AND "platform"."conversation_audit_events"."action" not in ('conversation.model_selection.updated', 'conversation.sandbox.allocated', 'conversation.sandbox.observed')
				));--> statement-breakpoint
ALTER TABLE "platform"."conversation_audit_events" ADD CONSTRAINT "conversation_audit_details_binding" CHECK ((
				"platform"."conversation_audit_events"."action" in (
					'conversation.sandbox.allocated',
					'conversation.sandbox.observed',
					'conversation.model_selection.updated',
					'conversation.model_selection.fell_back'
				)
			) = ("platform"."conversation_audit_events"."details" IS NOT NULL));