DO $migration$
DECLARE
  waiting_order real;
  submitted_order real;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum value
    JOIN pg_type type ON type.oid = value.enumtypid
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'platform'
      AND type.typname = 'conversation_execution_status'
      AND value.enumlabel = 'waiting'
  ) THEN
    EXECUTE 'ALTER TYPE "platform"."conversation_execution_status" ADD VALUE ''waiting'' BEFORE ''submitted''';
  END IF;

  SELECT waiting.enumsortorder, submitted.enumsortorder
  INTO waiting_order, submitted_order
  FROM pg_enum waiting
  JOIN pg_type type ON type.oid = waiting.enumtypid
  JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
  JOIN pg_enum submitted
    ON submitted.enumtypid = waiting.enumtypid
    AND submitted.enumlabel = 'submitted'
  WHERE namespace.nspname = 'platform'
    AND type.typname = 'conversation_execution_status'
    AND waiting.enumlabel = 'waiting';
  IF waiting_order IS NULL OR submitted_order IS NULL OR waiting_order >= submitted_order THEN
    RAISE EXCEPTION 'Incompatible conversation execution status enum order';
  END IF;
END
$migration$;
--> statement-breakpoint
DO $migration$
DECLARE
  candidate_column text;
BEGIN
  FOREACH candidate_column IN ARRAY ARRAY['principal_type', 'task_wait_order', 'task_wait_deadline'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns columns
      WHERE table_schema = 'platform'
        AND table_name = 'conversation_executions'
        AND columns.column_name = candidate_column
    ) THEN
      EXECUTE format(
        'ALTER TABLE "platform"."conversation_executions" ADD COLUMN %I %s',
        candidate_column,
        CASE candidate_column
          WHEN 'principal_type' THEN 'varchar(16) DEFAULT ''user'' NOT NULL'
          WHEN 'task_wait_order' THEN 'bigint'
          ELSE 'timestamp with time zone'
        END
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'platform' AND table_name = 'conversations'
      AND column_name = 'principal_type'
  ) THEN
    ALTER TABLE "platform"."conversations"
      ADD COLUMN "principal_type" varchar(16) DEFAULT 'user' NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('conversation_executions', 'principal_type', 'character varying'),
      ('conversation_executions', 'task_wait_order', 'bigint'),
      ('conversation_executions', 'task_wait_deadline', 'timestamp with time zone'),
      ('conversations', 'principal_type', 'character varying')
    ) AS expected(table_name, column_name, data_type)
    LEFT JOIN information_schema.columns actual
      ON actual.table_schema = 'platform'
      AND actual.table_name = expected.table_name
      AND actual.column_name = expected.column_name
    WHERE actual.column_name IS NULL
      OR actual.data_type <> expected.data_type
      OR (expected.column_name = 'principal_type' AND (
        actual.is_nullable <> 'NO'
        OR actual.character_maximum_length <> 16
        OR actual.column_default IS DISTINCT FROM '''user''::character varying'
      ))
  ) THEN
    RAISE EXCEPTION 'Incompatible historical typed task columns';
  END IF;
END
$migration$;
--> statement-breakpoint
ALTER TABLE "platform"."conversations" DROP CONSTRAINT IF EXISTS "conversation_principal_binding_unique";--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" DROP CONSTRAINT IF EXISTS "conversation_execution_principal_binding_fk";--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" DROP CONSTRAINT IF EXISTS "conversation_execution_principal_type_valid";--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" DROP CONSTRAINT IF EXISTS "conversation_execution_task_wait_binding";--> statement-breakpoint
ALTER TABLE "platform"."conversations" DROP CONSTRAINT IF EXISTS "conversation_principal_type_valid";--> statement-breakpoint
ALTER TABLE "platform"."conversations" ADD CONSTRAINT "conversation_principal_binding_unique" UNIQUE("id","agent_id","actor_id","channel_id","principal_type");--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_principal_binding_fk" FOREIGN KEY ("conversation_id","agent_id","actor_id","channel_id","principal_type") REFERENCES "platform"."conversations"("id","agent_id","actor_id","channel_id","principal_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_principal_type_valid" CHECK (("platform"."conversation_executions"."principal_type" = 'user' AND "platform"."conversation_executions"."channel_id" <> 'api:application') OR ("platform"."conversation_executions"."principal_type" = 'application' AND "platform"."conversation_executions"."channel_id" in ('api', 'api:application')));--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_task_wait_binding" CHECK (("platform"."conversation_executions"."task_wait_order" IS NULL AND "platform"."conversation_executions"."task_wait_deadline" IS NULL AND "platform"."conversation_executions"."status"::text <> 'waiting') OR ("platform"."conversation_executions"."task_wait_order" IS NOT NULL AND "platform"."conversation_executions"."task_wait_order" between 1 and 9007199254740991 AND "platform"."conversation_executions"."task_wait_deadline" IS NOT NULL AND "platform"."conversation_executions"."task_wait_deadline" > "platform"."conversation_executions"."created_at"));--> statement-breakpoint
ALTER TABLE "platform"."conversations" ADD CONSTRAINT "conversation_principal_type_valid" CHECK (("platform"."conversations"."principal_type" = 'user' AND "platform"."conversations"."channel_id" <> 'api:application') OR ("platform"."conversations"."principal_type" = 'application' AND "platform"."conversations"."channel_id" in ('api', 'api:application')));--> statement-breakpoint
DROP INDEX IF EXISTS "platform"."conversation_execution_task_wait_order_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "platform"."conversation_execution_agent_wait_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_execution_task_wait_order_unique" ON "platform"."conversation_executions" USING btree ("agent_id","task_wait_order") WHERE "platform"."conversation_executions"."task_wait_order" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_execution_agent_wait_idx" ON "platform"."conversation_executions" USING btree ("agent_id","task_wait_order");
