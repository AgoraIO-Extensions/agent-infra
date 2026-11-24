CREATE TABLE "platform"."external_service_queries" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"receipt" jsonb
);
--> statement-breakpoint
CREATE TABLE "platform"."external_service_versions" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"url" text NOT NULL,
	"credential" jsonb NOT NULL,
	CONSTRAINT "external_service_versions_id_revision_pk" PRIMARY KEY("id","revision")
);
--> statement-breakpoint
CREATE TABLE "platform"."external_services" (
	"id" text PRIMARY KEY NOT NULL,
	"model_endpoint_id" text,
	"enabled_once" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"active" integer,
	"verified" integer,
	CONSTRAINT "external_services_model_endpoint_id_unique" UNIQUE("model_endpoint_id")
);
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "external_service_id" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "external_service_revision" integer;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "queued_supplement_message_id" text;--> statement-breakpoint
ALTER TABLE "platform"."external_service_versions" ADD CONSTRAINT "external_service_versions_id_external_services_id_fk" FOREIGN KEY ("id") REFERENCES "platform"."external_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_service_queries_expiry" ON "platform"."external_service_queries" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "execution_external_service_version_fk" FOREIGN KEY ("external_service_id","external_service_revision") REFERENCES "platform"."external_service_versions"("id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Bind at admission, under the same transaction as the Execution and outbox.
-- A retry updates the original Execution and never resolves the active version again.
CREATE FUNCTION platform.bind_external_service_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  service platform.external_services%ROWTYPE;
BEGIN
  NEW.external_service_id := NULL;
  NEW.external_service_revision := NULL;
  SELECT s.* INTO service
    FROM platform.agent_configuration_revisions r
    CROSS JOIN LATERAL jsonb_array_elements(r.configuration->'modelConfiguration'->'options') opt
    JOIN platform.external_services s ON s.model_endpoint_id = opt->>'endpointId'
    WHERE r.agent_id = NEW.agent_id AND r.revision = NEW.model_configuration_revision
      AND opt->>'optionId' = NEW.model_option_id
    FOR SHARE OF s;
  IF FOUND AND service.enabled_once THEN
    IF service.active IS NULL THEN
      RAISE EXCEPTION 'external service disabled' USING ERRCODE = '23514';
    END IF;
    NEW.external_service_id := service.id;
    NEW.external_service_revision := service.active;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Old API writers must also honor the Worker fence during a rolling upgrade.
CREATE FUNCTION platform.fence_platform_user_disable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_user_id text;
BEGIN
  target_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  -- A legacy writer already holds the table lock; waiting here could invert the
  -- new writer's advisory-before-table order. Reject known contention instead.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('platform_user_disable:' || target_user_id, 0)) THEN
    RAISE EXCEPTION 'platform user governance busy' USING ERRCODE = '55P03';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER platform_user_disable_fence
BEFORE INSERT OR DELETE ON platform.platform_user_disables
FOR EACH ROW EXECUTE FUNCTION platform.fence_platform_user_disable();
--> statement-breakpoint
CREATE TRIGGER bind_external_service_execution BEFORE INSERT ON platform.conversation_executions
FOR EACH ROW WHEN (NEW.relay_key_id IS NOT NULL AND NEW.model_option_id IS NOT NULL)
EXECUTE FUNCTION platform.bind_external_service_execution();
CREATE OR REPLACE FUNCTION platform.bind_external_service_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  service platform.external_services%ROWTYPE;
BEGIN
  NEW.external_service_id := NULL;
  NEW.external_service_revision := NULL;
  -- A queued supplement is already accepted. Copy even an unbound predecessor.
  IF NEW.queued_supplement_message_id IS NOT NULL THEN
    SELECT e.external_service_id, e.external_service_revision
      INTO STRICT NEW.external_service_id, NEW.external_service_revision
      FROM platform.conversation_messages m
      JOIN platform.conversation_executions e ON e.execution_id = m.execution_id
      JOIN platform.outbox_items o ON o.id = 'conversation:supplement:' || m.message_id
      WHERE m.message_id = NEW.queued_supplement_message_id AND m.status = 'submitted'
        AND NEW.status = 'waiting' AND m.role = 'user'
        AND m.conversation_id = NEW.conversation_id AND m.actor_id = NEW.actor_id
        AND o.scope_type = 'conversation' AND o.scope_id = NEW.conversation_id
        AND o.operation = 'conversation.turn.supplement.v1'
        AND o.payload->>'executionId' = e.execution_id
        AND (e.agent_id,e.sandbox_id,e.conversation_id,e.actor_id,e.principal_type,e.channel_id,e.session_generation,
             e.authorization_revision,e.model_configuration_revision,e.model_option_id,e.reasoning_level,e.execution_source,
             e.relay_key_purpose,e.relay_key_subject_id,e.relay_key_id,e.relay_key_version)
          IS NOT DISTINCT FROM
            (NEW.agent_id,NEW.sandbox_id,NEW.conversation_id,NEW.actor_id,NEW.principal_type,NEW.channel_id,NEW.session_generation,
             NEW.authorization_revision,NEW.model_configuration_revision,NEW.model_option_id,NEW.reasoning_level,NEW.execution_source,
             NEW.relay_key_purpose,NEW.relay_key_subject_id,NEW.relay_key_id,NEW.relay_key_version);
    RETURN NEW;
  END IF;
  SELECT s.* INTO service
    FROM platform.agent_configuration_revisions r
    CROSS JOIN LATERAL jsonb_array_elements(r.configuration->'modelConfiguration'->'options') opt
    JOIN platform.external_services s ON s.model_endpoint_id = opt->>'endpointId'
    WHERE r.agent_id = NEW.agent_id AND r.revision = NEW.model_configuration_revision
      AND opt->>'optionId' = NEW.model_option_id
    FOR SHARE OF s;
  IF FOUND AND service.enabled_once THEN
    IF service.active IS NULL THEN
      -- Legacy queue writers identify the source only after moving the Message.
      IF NEW.status = 'waiting' AND NEW.queued_supplement_message_id IS NULL THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'external service disabled' USING ERRCODE = '23514';
    END IF;
    NEW.external_service_id := service.id;
    NEW.external_service_revision := service.active;
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE INDEX "conversation_message_execution_idx" ON "platform"."conversation_messages" USING btree ("execution_id");
--> statement-breakpoint
CREATE FUNCTION platform.finish_waiting_external_service_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pending platform.conversation_executions%ROWTYPE;
  service platform.external_services%ROWTYPE;
  source_message_id text;
  original_id text;
  original_revision integer;
BEGIN
  SELECT * INTO pending FROM platform.conversation_executions WHERE execution_id = NEW.execution_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  BEGIN
    -- Detect a supplement relationship before validating it: invalid evidence
    -- must not fall through to admission against the currently enabled service.
    SELECT m.message_id INTO STRICT source_message_id
      FROM platform.conversation_messages m
      JOIN platform.outbox_items o ON o.id = 'conversation:supplement:' || m.message_id
      WHERE m.execution_id = pending.execution_id;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN source_message_id := NULL;
    WHEN TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'ambiguous queued supplement' USING ERRCODE = '23514';
  END;
  IF source_message_id IS NOT NULL THEN
    BEGIN
      SELECT e.external_service_id, e.external_service_revision
        INTO STRICT original_id, original_revision
        FROM platform.conversation_messages m
        JOIN platform.outbox_items o ON o.id = 'conversation:supplement:' || m.message_id
        JOIN platform.conversation_executions e ON e.execution_id = o.payload->>'executionId'
        JOIN platform.outbox_items n ON n.id = 'conversation:turn:' || pending.execution_id
        WHERE m.message_id = source_message_id AND m.execution_id = pending.execution_id
          AND m.status = 'submitted' AND m.role = 'user'
          AND m.conversation_id = pending.conversation_id AND m.actor_id = pending.actor_id
          AND (pending.queued_supplement_message_id IS NULL OR pending.queued_supplement_message_id = m.message_id)
          AND e.execution_id <> pending.execution_id
          AND o.scope_type = 'conversation' AND o.scope_id = pending.conversation_id
          AND o.operation = 'conversation.turn.supplement.v1' AND o.status = 'succeeded'
          AND o.payload->>'schemaVersion' = '1' AND o.payload->>'messageId' = m.message_id
          AND o.payload->>'conversationId' = pending.conversation_id
          AND o.payload->>'turnId' = e.turn_id AND o.payload->>'sessionGeneration' = e.session_generation::text
          AND n.scope_type = 'conversation' AND n.scope_id = pending.conversation_id
          AND n.operation = 'conversation.turn.submit.v1' AND n.available_at = 'infinity'::timestamptz
          AND n.payload->>'schemaVersion' = '1' AND n.payload->>'messageId' = m.message_id
          AND n.payload->>'conversationId' = pending.conversation_id
          AND n.payload->>'executionId' = pending.execution_id AND n.payload->>'turnId' = pending.turn_id
          AND n.payload->>'sessionGeneration' = pending.session_generation::text
          AND (e.agent_id,e.sandbox_id,e.conversation_id,e.actor_id,e.principal_type,e.channel_id,e.session_generation,
               e.authorization_revision,e.model_configuration_revision,e.model_option_id,e.reasoning_level,e.execution_source,
               e.relay_key_purpose,e.relay_key_subject_id,e.relay_key_id,e.relay_key_version)
            IS NOT DISTINCT FROM
              (pending.agent_id,pending.sandbox_id,pending.conversation_id,pending.actor_id,pending.principal_type,pending.channel_id,pending.session_generation,
               pending.authorization_revision,pending.model_configuration_revision,pending.model_option_id,pending.reasoning_level,pending.execution_source,
               pending.relay_key_purpose,pending.relay_key_subject_id,pending.relay_key_id,pending.relay_key_version);
    EXCEPTION
      WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'invalid queued supplement binding' USING ERRCODE = '23514';
    END;
    UPDATE platform.conversation_executions
      SET external_service_id = original_id, external_service_revision = original_revision,
          queued_supplement_message_id = source_message_id
      WHERE execution_id = pending.execution_id;
    RETURN NULL;
  END IF;
  IF pending.queued_supplement_message_id IS NOT NULL THEN
    RAISE EXCEPTION 'missing queued supplement binding' USING ERRCODE = '23514';
  END IF;
  SELECT s.* INTO service
    FROM platform.agent_configuration_revisions r
    CROSS JOIN LATERAL jsonb_array_elements(r.configuration->'modelConfiguration'->'options') opt
    JOIN platform.external_services s ON s.model_endpoint_id = opt->>'endpointId'
    WHERE r.agent_id = pending.agent_id AND r.revision = pending.model_configuration_revision
      AND opt->>'optionId' = pending.model_option_id
    FOR SHARE OF s;
  IF FOUND AND service.enabled_once THEN
    IF service.active IS NULL THEN
      RAISE EXCEPTION 'external service disabled' USING ERRCODE = '23514';
    END IF;
    UPDATE platform.conversation_executions SET external_service_id = service.id, external_service_revision = service.active
      WHERE execution_id = pending.execution_id;
  ELSE
    UPDATE platform.conversation_executions SET external_service_id = NULL, external_service_revision = NULL
      WHERE execution_id = pending.execution_id AND external_service_id IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER finish_waiting_external_service_binding
AFTER INSERT ON platform.conversation_executions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.status::text = 'waiting' AND NEW.queued_supplement_message_id IS NULL
  AND NEW.relay_key_id IS NOT NULL AND NEW.model_option_id IS NOT NULL)
EXECUTE FUNCTION platform.finish_waiting_external_service_binding();
