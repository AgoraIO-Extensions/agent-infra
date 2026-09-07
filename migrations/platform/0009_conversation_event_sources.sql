ALTER TABLE "platform"."conversation_audit_events" DROP CONSTRAINT "conversation_audit_execution_binding";--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" DROP CONSTRAINT "conversation_event_runtime_cursor_non_empty";--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" ALTER COLUMN "runtime_cursor" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" ADD COLUMN "source" varchar(16);--> statement-breakpoint
UPDATE "platform"."conversation_events" SET "source" = 'runtime';--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
DO $$
DECLARE
	unresolved_count bigint;
BEGIN
	WITH unique_bindings AS (
		SELECT fallback.id, min(command.execution_id) AS execution_id
		FROM platform.conversation_audit_events AS fallback
		JOIN platform.conversation_audit_events AS command
			ON command.conversation_id = fallback.conversation_id
			AND command.agent_id = fallback.agent_id
			AND command.actor_id = fallback.actor_id
			AND command.request_id = fallback.request_id
			AND command.trace_id = fallback.trace_id
			AND command.occurred_at = fallback.occurred_at
			AND command.execution_id IS NOT NULL
			AND command.action IN (
				'conversation.message.accepted',
				'conversation.message.supplemented',
				'conversation.regeneration.accepted'
			)
		WHERE fallback.action = 'conversation.model_selection.fell_back'
			AND fallback.execution_id IS NULL
		GROUP BY fallback.id
		HAVING count(*) = 1
	)
	UPDATE platform.conversation_audit_events AS fallback
	SET execution_id = unique_bindings.execution_id
	FROM unique_bindings
	WHERE fallback.id = unique_bindings.id;

	SELECT count(*) INTO unresolved_count
	FROM platform.conversation_audit_events
	WHERE action = 'conversation.model_selection.fell_back'
		AND execution_id IS NULL;

	IF unresolved_count <> 0 THEN
		RAISE EXCEPTION 'cannot uniquely bind % legacy model fallback audit event(s)', unresolved_count;
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "platform"."conversation_audit_events" ADD CONSTRAINT "conversation_audit_execution_binding" CHECK ((
					"platform"."conversation_audit_events"."execution_id" IS NULL
					AND "platform"."conversation_audit_events"."action" = 'conversation.model_selection.updated'
				) OR (
					"platform"."conversation_audit_events"."execution_id" IS NOT NULL
					AND "platform"."conversation_audit_events"."action" <> 'conversation.model_selection.updated'
				));--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" ADD CONSTRAINT "conversation_event_source_binding" CHECK ((
					"platform"."conversation_events"."source" = 'runtime'
					AND "platform"."conversation_events"."runtime_cursor" IS NOT NULL
					AND char_length("platform"."conversation_events"."runtime_cursor") > 0
					AND "platform"."conversation_events"."event_type" <> 'model.selection.fell_back'
				) OR (
					"platform"."conversation_events"."source" = 'platform'
					AND "platform"."conversation_events"."runtime_cursor" IS NULL
					AND "platform"."conversation_events"."event_type" = 'model.selection.fell_back'
				));--> statement-breakpoint
DROP INDEX "platform"."conversation_event_execution_adapter_key_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_event_execution_adapter_key_unique" ON "platform"."conversation_events" USING btree ("execution_id","adapter_event_key") WHERE "platform"."conversation_events"."source" = 'runtime';
