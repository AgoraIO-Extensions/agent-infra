-- Commit wakeups (Spec §8.2, §10.2). NOTIFY is delivered only after the
-- writing transaction commits, so a listener can never observe uncommitted
-- state. A wakeup carries no business content and is only a hint; Worker
-- polling and SSE polling remain the delivery guarantee.
CREATE FUNCTION "platform"."notify_outbox_available"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_notify('agent_infra_outbox_available', '');
	RETURN NULL;
END
$$;--> statement-breakpoint
-- Writers stamp available_at from their own clock after the transaction
-- starts, so compare with the trigger-time clock. The small allowance absorbs
-- clock skew between writers and the database; delayed retries (seconds) and
-- waiting tasks (infinity) do not wake anyone.
CREATE TRIGGER "outbox_item_available"
AFTER INSERT OR UPDATE OF "status", "available_at" ON "platform"."outbox_items"
FOR EACH ROW
WHEN (
	NEW."status" IN ('pending', 'retry_scheduled')
	AND NEW."available_at" <= clock_timestamp() + interval '250 milliseconds'
)
EXECUTE FUNCTION "platform"."notify_outbox_available"();--> statement-breakpoint
CREATE FUNCTION "platform"."notify_conversation_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_notify('agent_infra_conversation_event', NEW."conversation_id");
	RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "conversation_event_committed"
AFTER INSERT ON "platform"."conversation_events"
FOR EACH ROW
EXECUTE FUNCTION "platform"."notify_conversation_event"();
