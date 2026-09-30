ALTER TYPE "platform"."conversation_execution_status" ADD VALUE 'waiting' BEFORE 'submitted';--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "task_wait_order" bigint;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "task_wait_deadline" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_execution_task_wait_order_unique" ON "platform"."conversation_executions" USING btree ("agent_id","task_wait_order") WHERE "platform"."conversation_executions"."task_wait_order" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_execution_agent_wait_idx" ON "platform"."conversation_executions" USING btree ("agent_id","task_wait_order");--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_task_wait_binding" CHECK (("platform"."conversation_executions"."task_wait_order" IS NULL AND "platform"."conversation_executions"."task_wait_deadline" IS NULL AND "platform"."conversation_executions"."status"::text <> 'waiting') OR ("platform"."conversation_executions"."task_wait_order" IS NOT NULL AND "platform"."conversation_executions"."task_wait_order" between 1 and 9007199254740991 AND "platform"."conversation_executions"."task_wait_deadline" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" DROP CONSTRAINT "conversation_event_source_binding";--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" ADD CONSTRAINT "conversation_event_source_binding" CHECK ((source = 'runtime' AND runtime_cursor IS NOT NULL AND char_length(runtime_cursor) > 0 AND event_type NOT IN ('model.selection.fell_back', 'task.status')) OR (source = 'platform' AND runtime_cursor IS NULL AND event_type IN ('model.selection.fell_back', 'task.status')));
--> statement-breakpoint
ALTER TABLE "platform"."conversation_generation_tombstones" DROP CONSTRAINT "conversation_generation_tombstone_principal_valid";--> statement-breakpoint
ALTER TABLE "platform"."conversation_generation_tombstones" ADD CONSTRAINT "conversation_generation_tombstone_principal_valid" CHECK (jsonb_typeof("platform"."conversation_generation_tombstones"."original_principal") = 'object'
				and coalesce(jsonb_typeof("platform"."conversation_generation_tombstones"."original_principal"->'kind') = 'string', false)
				and coalesce("platform"."conversation_generation_tombstones"."original_principal"->>'kind' in ('user', 'application'), false)
				and coalesce(jsonb_typeof("platform"."conversation_generation_tombstones"."original_principal"->'id') = 'string', false)
				and char_length(coalesce("platform"."conversation_generation_tombstones"."original_principal"->>'id', '')) > 0);
--> statement-breakpoint
ALTER TABLE "platform"."conversation_stops" ADD COLUMN "confirmation_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."conversation_stops" ADD COLUMN "confirmation_timed_out_at" timestamp with time zone;--> statement-breakpoint
-- Derive historical deadlines from first acceptance, never migration/retry time.
UPDATE "platform"."conversation_stops" SET "confirmation_deadline" = "created_at" + interval '60 seconds';--> statement-breakpoint
ALTER TABLE "platform"."conversation_stops" ALTER COLUMN "confirmation_deadline" SET DEFAULT clock_timestamp() + interval '60 seconds';--> statement-breakpoint
ALTER TABLE "platform"."conversation_stops" ALTER COLUMN "confirmation_deadline" SET NOT NULL;--> statement-breakpoint
-- Earlier command ACKs could close stops while their original Turn remained active.
UPDATE "platform"."conversation_stops" s SET "status" = 'submitted'
FROM "platform"."conversation_executions" e
WHERE e.execution_id = s.execution_id AND e.status IN ('submitted', 'processing', 'unknown') AND s.status = 'completed';--> statement-breakpoint
UPDATE "platform"."outbox_items" o SET "status" = 'retry_scheduled', "available_at" = clock_timestamp(), "lease_owner" = NULL, "lease_expires_at" = NULL
FROM "platform"."conversation_stops" s
WHERE o.id = 'conversation:stop:' || s.stop_request_id AND o.operation = 'conversation.turn.stop.v1' AND o.status = 'succeeded' AND s.status = 'submitted';
--> statement-breakpoint
ALTER TABLE "platform"."platform_api_credentials" ADD CONSTRAINT "platform_api_credential_hash_unique" UNIQUE("credential_hash");
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "execution_source" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_purpose" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_subject_id" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_id" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_version" bigint;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_key_version_fk" FOREIGN KEY ("relay_key_purpose","relay_key_subject_id","relay_key_version","relay_key_id") REFERENCES "platform"."relay_key_versions"("purpose","subject_id","key_version","key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_key_binding" CHECK ((
				"platform"."conversation_executions"."execution_source" IS NULL
				AND "platform"."conversation_executions"."relay_key_purpose" IS NULL
				AND "platform"."conversation_executions"."relay_key_subject_id" IS NULL
				AND "platform"."conversation_executions"."relay_key_id" IS NULL
				AND "platform"."conversation_executions"."relay_key_version" IS NULL
			) OR (
				"platform"."conversation_executions"."execution_source" IS NOT NULL
				AND "platform"."conversation_executions"."relay_key_purpose" IS NOT NULL
				AND "platform"."conversation_executions"."relay_key_subject_id" IS NOT NULL
				AND "platform"."conversation_executions"."relay_key_id" IS NOT NULL
				AND "platform"."conversation_executions"."relay_key_version" IS NOT NULL
				AND "platform"."conversation_executions"."execution_source" in ('web', 'wecom', 'platform-api', 'eval')
				AND "platform"."conversation_executions"."relay_key_purpose" in ('personal', 'agent-default')
				AND char_length("platform"."conversation_executions"."relay_key_subject_id") > 0
				AND char_length("platform"."conversation_executions"."relay_key_id") > 0
				AND "platform"."conversation_executions"."relay_key_version" between 1 and 9007199254740991
				AND (("platform"."conversation_executions"."execution_source" = 'web' AND "platform"."conversation_executions"."channel_id" = 'web')
					OR ("platform"."conversation_executions"."execution_source" = 'wecom' AND ("platform"."conversation_executions"."channel_id" = 'wecom'
						OR left("platform"."conversation_executions"."channel_id", 10) = 'wecom_bot:'
						OR left("platform"."conversation_executions"."channel_id", 10) = 'wecom_app:'))
					OR ("platform"."conversation_executions"."execution_source" = 'platform-api' AND ("platform"."conversation_executions"."channel_id" = 'api'
						OR "platform"."conversation_executions"."channel_id" LIKE 'api:%'))
					OR ("platform"."conversation_executions"."execution_source" = 'eval' AND "platform"."conversation_executions"."channel_id" = 'eval'))
				AND (("platform"."conversation_executions"."execution_source" in ('web', 'wecom')
					AND "platform"."conversation_executions"."relay_key_purpose" = 'personal'
					AND "platform"."conversation_executions"."relay_key_subject_id" = "platform"."conversation_executions"."actor_id")
					OR ("platform"."conversation_executions"."execution_source" in ('platform-api', 'eval')
					AND "platform"."conversation_executions"."relay_key_purpose" = 'agent-default'
					AND "platform"."conversation_executions"."relay_key_subject_id" = "platform"."conversation_executions"."agent_id"))
			));
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "runtime_submit_protocol" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "original_operation_digest" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "original_submit_host_session_ref" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_original_digest_binding" CHECK (("platform"."conversation_executions"."runtime_submit_protocol" IS NULL AND "platform"."conversation_executions"."original_operation_digest" IS NULL AND "platform"."conversation_executions"."original_submit_host_session_ref" IS NULL) OR ("platform"."conversation_executions"."runtime_submit_protocol" IS NOT NULL AND "platform"."conversation_executions"."original_operation_digest" IS NOT NULL AND "platform"."conversation_executions"."runtime_submit_protocol" in ('v2', 'v4') AND "platform"."conversation_executions"."original_operation_digest" ~ '^[A-Za-z0-9_-]{43}$' AND ("platform"."conversation_executions"."runtime_submit_protocol" <> 'v4' OR "platform"."conversation_executions"."execution_source" IS NOT NULL) AND ("platform"."conversation_executions"."runtime_submit_protocol" <> 'v2' OR "platform"."conversation_executions"."original_submit_host_session_ref" IS NULL)));
