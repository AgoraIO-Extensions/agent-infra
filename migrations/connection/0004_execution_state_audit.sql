-- PostgreSQL is the authority even when a caller bypasses the repository.
CREATE FUNCTION "connection"."enforce_execution_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (TG_TABLE_NAME = 'action_calls' AND NEW."status" = 'created') OR
       (TG_TABLE_NAME = 'effects' AND NEW."status" = 'planned') OR
       (TG_TABLE_NAME = 'dispatches' AND NEW."status" = 'pending') THEN
      RETURN NEW;
    END IF;
  ELSIF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'action_calls' AND (
    (OLD."status" = 'created' AND NEW."status" IN ('submission_started', 'provider_failed', 'result_pending')) OR
    (OLD."status" = 'submission_started' AND NEW."status" IN ('provider_succeeded', 'provider_failed', 'result_pending')) OR
    (OLD."status" = 'result_pending' AND NEW."status" IN ('provider_succeeded', 'provider_failed', 'needs_manual_review', 'unresolved')) OR
    (OLD."status" = 'needs_manual_review' AND NEW."status" IN ('provider_succeeded', 'provider_failed', 'unresolved'))
  ) THEN
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'effects' AND (
    (OLD."status" = 'planned' AND NEW."status" IN ('submitted', 'failed', 'unknown')) OR
    (OLD."status" = 'submitted' AND NEW."status" IN ('succeeded', 'failed', 'unknown')) OR
    (OLD."status" = 'unknown' AND NEW."status" IN ('succeeded', 'failed'))
  ) THEN
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'dispatches' AND (
    (OLD."status" = 'pending' AND NEW."status" IN ('claimed', 'failed', 'unknown')) OR
    (OLD."status" = 'claimed' AND NEW."status" IN ('completed', 'failed', 'unknown')) OR
    (OLD."status" = 'unknown' AND NEW."status" IN ('completed', 'failed'))
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid % status transition', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "action_calls_state_transition_trigger"
BEFORE INSERT OR UPDATE OF "status" ON "connection"."action_calls"
FOR EACH ROW EXECUTE FUNCTION "connection"."enforce_execution_state"();

CREATE TRIGGER "effects_state_transition_trigger"
BEFORE INSERT OR UPDATE OF "status" ON "connection"."effects"
FOR EACH ROW EXECUTE FUNCTION "connection"."enforce_execution_state"();

CREATE TRIGGER "dispatches_state_transition_trigger"
BEFORE INSERT OR UPDATE OF "status" ON "connection"."dispatches"
FOR EACH ROW EXECUTE FUNCTION "connection"."enforce_execution_state"();

CREATE FUNCTION "connection"."protect_action_call_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW."id", NEW."request_id", NEW."trace_id", NEW."call_id",
         NEW."idempotency_key", NEW."namespace_key", NEW."principal_id",
         NEW."consumer_id", NEW."consumer_instance_id", NEW."actor_id",
         NEW."grant_id", NEW."connection_id", NEW."credential_version_id",
         NEW."action_version_id", NEW."request_digest", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."request_id", OLD."trace_id", OLD."call_id",
         OLD."idempotency_key", OLD."namespace_key", OLD."principal_id",
         OLD."consumer_id", OLD."consumer_instance_id", OLD."actor_id",
         OLD."grant_id", OLD."connection_id", OLD."credential_version_id",
         OLD."action_version_id", OLD."request_digest", OLD."created_at") THEN
    RAISE EXCEPTION 'ActionCall binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "action_calls_immutable_binding_trigger"
BEFORE UPDATE ON "connection"."action_calls"
FOR EACH ROW EXECUTE FUNCTION "connection"."protect_action_call_binding"();

CREATE FUNCTION "connection"."enforce_call_audit_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bound "connection"."action_calls"%ROWTYPE;
  expected_actor_id text;
BEGIN
  IF NEW."target_type" <> 'action_call' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO bound FROM "connection"."action_calls"
   WHERE "id" = NEW."target_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ActionCall audit binding is invalid';
  END IF;
  expected_actor_id := CASE WHEN bound."actor_id" = '__consumer_actor__'
                            THEN NULL ELSE bound."actor_id" END;
  IF NEW."trace_id" IS DISTINCT FROM bound."trace_id" OR
     NEW."principal_id" IS DISTINCT FROM bound."principal_id" OR
     NEW."consumer_instance_id" IS DISTINCT FROM bound."consumer_instance_id" OR
     NEW."actor_id" IS DISTINCT FROM expected_actor_id THEN
    RAISE EXCEPTION 'ActionCall audit binding is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "audit_events_call_binding_trigger"
BEFORE INSERT ON "connection"."audit_events"
FOR EACH ROW EXECUTE FUNCTION "connection"."enforce_call_audit_binding"();

CREATE FUNCTION "connection"."protect_audit_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Connection audit event is immutable';
END;
$$;

CREATE TRIGGER "audit_events_immutable_trigger"
BEFORE UPDATE OR DELETE ON "connection"."audit_events"
FOR EACH ROW EXECUTE FUNCTION "connection"."protect_audit_event"();
