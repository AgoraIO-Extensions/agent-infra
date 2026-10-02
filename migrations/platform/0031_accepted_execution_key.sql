DO $migration$
DECLARE
  candidate_column text;
BEGIN
  FOREACH candidate_column IN ARRAY ARRAY[
    'execution_source',
    'relay_key_purpose',
    'relay_key_subject_id',
    'relay_key_id',
    'relay_key_version',
    'runtime_submit_protocol',
    'original_operation_digest',
    'original_submit_host_session_ref'
  ] LOOP
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
          WHEN 'relay_key_version' THEN 'bigint'
          ELSE 'text'
        END
      );
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('execution_source', 'text'),
      ('relay_key_purpose', 'text'),
      ('relay_key_subject_id', 'text'),
      ('relay_key_id', 'text'),
      ('relay_key_version', 'bigint'),
      ('runtime_submit_protocol', 'text'),
      ('original_operation_digest', 'text'),
      ('original_submit_host_session_ref', 'text')
    ) AS expected(column_name, data_type)
    LEFT JOIN information_schema.columns actual
      ON actual.table_schema = 'platform'
      AND actual.table_name = 'conversation_executions'
      AND actual.column_name = expected.column_name
    WHERE actual.column_name IS NULL
      OR actual.data_type <> expected.data_type
      OR actual.is_nullable <> 'YES'
  ) THEN
    RAISE EXCEPTION 'Incompatible historical conversation execution key columns';
  END IF;
END
$migration$;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" DROP CONSTRAINT IF EXISTS "conversation_execution_key_version_fk";--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" DROP CONSTRAINT IF EXISTS "conversation_execution_original_digest_binding";--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" DROP CONSTRAINT IF EXISTS "conversation_execution_key_binding";--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_key_version_fk" FOREIGN KEY ("relay_key_purpose","relay_key_subject_id","relay_key_version","relay_key_id") REFERENCES "platform"."relay_key_versions"("purpose","subject_id","key_version","key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_original_digest_binding" CHECK (("platform"."conversation_executions"."runtime_submit_protocol" IS NULL AND "platform"."conversation_executions"."original_operation_digest" IS NULL AND "platform"."conversation_executions"."original_submit_host_session_ref" IS NULL) OR ("platform"."conversation_executions"."runtime_submit_protocol" IS NOT NULL AND "platform"."conversation_executions"."original_operation_digest" IS NOT NULL AND "platform"."conversation_executions"."runtime_submit_protocol" in ('v2', 'v4') AND "platform"."conversation_executions"."original_operation_digest" ~ '^[A-Za-z0-9_-]{43}$' AND ("platform"."conversation_executions"."runtime_submit_protocol" <> 'v4' OR "platform"."conversation_executions"."execution_source" IS NOT NULL) AND ("platform"."conversation_executions"."runtime_submit_protocol" <> 'v2' OR ("platform"."conversation_executions"."execution_source" IS NULL AND "platform"."conversation_executions"."original_submit_host_session_ref" IS NULL))));--> statement-breakpoint
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
