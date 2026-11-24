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
        AND (e.agent_id,e.conversation_id,e.actor_id,e.principal_type,e.channel_id,e.session_generation,
             e.model_configuration_revision,e.model_option_id,e.relay_key_purpose,e.relay_key_subject_id,e.relay_key_id,e.relay_key_version)
          IS NOT DISTINCT FROM
            (NEW.agent_id,NEW.conversation_id,NEW.actor_id,NEW.principal_type,NEW.channel_id,NEW.session_generation,
             NEW.model_configuration_revision,NEW.model_option_id,NEW.relay_key_purpose,NEW.relay_key_subject_id,NEW.relay_key_id,NEW.relay_key_version);
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
      RAISE EXCEPTION 'external service disabled' USING ERRCODE = '23514';
    END IF;
    NEW.external_service_id := service.id;
    NEW.external_service_revision := service.active;
  END IF;
  RETURN NEW;
END $$;
