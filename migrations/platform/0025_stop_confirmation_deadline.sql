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
