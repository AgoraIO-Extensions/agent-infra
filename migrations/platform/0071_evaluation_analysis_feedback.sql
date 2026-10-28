CREATE TABLE "platform"."task_feedback" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"metadata_expires_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "terminal_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."task_feedback" ADD CONSTRAINT "task_feedback_execution_fk" FOREIGN KEY ("execution_id") REFERENCES "platform"."conversation_executions"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_feedback_metadata_expiry_idx" ON "platform"."task_feedback" USING btree ("metadata_expires_at","execution_id");--> statement-breakpoint
CREATE INDEX "execution_model_fact_sequence_idx" ON "platform"."conversation_events" USING btree ("execution_id","sequence") WHERE "platform"."conversation_events"."source"='runtime' and "platform"."conversation_events"."event_type"='execution.operation' and "platform"."conversation_events"."event_payload"->'fact'->>'kind'='model';--> statement-breakpoint
CREATE INDEX "execution_feedback_actor_window_idx" ON "platform"."conversation_executions" USING btree ("agent_id","principal_type","actor_id","terminal_observed_at","execution_id") WHERE "platform"."conversation_executions"."terminal_observed_at" is not null and "platform"."conversation_executions"."status" in ('completed','failed','cancelled');--> statement-breakpoint
CREATE INDEX "execution_feedback_owner_window_idx" ON "platform"."conversation_executions" USING btree ("agent_id","terminal_observed_at","execution_id") WHERE "platform"."conversation_executions"."terminal_observed_at" is not null and "platform"."conversation_executions"."status" in ('completed','failed','cancelled');
--> statement-breakpoint
-- Mechanical observation of the existing status authority, including producers without events.
-- Legacy terminal rows stay NULL; a caller-supplied timestamp never establishes evidence.
CREATE FUNCTION "platform"."conversation_execution_terminal_observed_at"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.status IN ('completed','failed','cancelled') THEN
   NEW.terminal_observed_at := clock_timestamp();
  ELSE
   NEW.terminal_observed_at := NULL;
  END IF;
 ELSE
  NEW.terminal_observed_at := OLD.terminal_observed_at;
  IF OLD.status NOT IN ('completed','failed','cancelled')
    AND NEW.status IN ('completed','failed','cancelled')
    AND OLD.terminal_observed_at IS NULL THEN
   NEW.terminal_observed_at := clock_timestamp();
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "conversation_execution_terminal_observed_at"
BEFORE INSERT OR UPDATE OF "status", "terminal_observed_at"
ON "platform"."conversation_executions"
FOR EACH ROW EXECUTE FUNCTION "platform"."conversation_execution_terminal_observed_at"();
