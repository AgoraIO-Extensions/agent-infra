ALTER TABLE "platform"."conversation_executions" ADD COLUMN "queued_supplement_message_id" text;
--> statement-breakpoint
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
