CREATE TABLE "platform"."agent_personal_runtime_bindings" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"owner_id" text,
	"service_id" text,
	"target" jsonb,
	CONSTRAINT "personal_runtime_binding_version" CHECK ("platform"."agent_personal_runtime_bindings"."revision" > 0),
	CONSTRAINT "personal_runtime_binding_target" CHECK (num_nonnulls("platform"."agent_personal_runtime_bindings"."owner_id", "platform"."agent_personal_runtime_bindings"."service_id", "platform"."agent_personal_runtime_bindings"."target") in (0,3))
);
--> statement-breakpoint
ALTER TABLE "platform"."external_service_versions" ADD COLUMN "runtime_discovery" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."agent_personal_runtime_bindings" ADD CONSTRAINT "agent_personal_runtime_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."agent_personal_runtime_bindings" ADD CONSTRAINT "personal_runtime_service_fk" FOREIGN KEY ("service_id") REFERENCES "platform"."external_services"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Binding and sharing can commit concurrently through different API entry points.
CREATE FUNCTION platform.check_personal_runtime_owner(target_agent text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    personal_owner text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('personal-runtime-scope:' || target_agent, 0));
    SELECT owner_id INTO personal_owner FROM platform.agent_personal_runtime_bindings WHERE agent_id = target_agent;
    IF personal_owner IS NULL THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM platform.agent_owners WHERE agent_id = target_agent AND owner_id = personal_owner)
        OR EXISTS (SELECT 1 FROM platform.agent_owners WHERE agent_id = target_agent AND owner_id <> personal_owner)
        OR EXISTS (SELECT 1 FROM platform.agent_availability WHERE agent_id = target_agent AND (target_type <> 'user' OR target_id <> personal_owner))
        OR EXISTS (SELECT 1 FROM platform.agent_principal_grants WHERE agent_id = target_agent AND grant_type = 'use' AND revoked_at IS NULL AND (principal_type <> 'user' OR principal_id <> personal_owner))
    THEN
        RAISE EXCEPTION 'Personal runtime requires exclusive use by its owner'
            USING ERRCODE = '23514', CONSTRAINT = 'personal_runtime_owner_scope';
    END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION platform.enforce_personal_runtime_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.agent_id <> NEW.agent_id) THEN
        PERFORM platform.check_personal_runtime_owner(OLD.agent_id);
    END IF;
    IF TG_OP <> 'DELETE' THEN PERFORM platform.check_personal_runtime_owner(NEW.agent_id); END IF;
    RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER personal_runtime_scope_binding AFTER INSERT OR UPDATE OR DELETE ON platform.agent_personal_runtime_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform.enforce_personal_runtime_owner();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER personal_runtime_scope_owner AFTER INSERT OR UPDATE OR DELETE ON platform.agent_owners DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform.enforce_personal_runtime_owner();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER personal_runtime_scope_availability AFTER INSERT OR UPDATE OR DELETE ON platform.agent_availability DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform.enforce_personal_runtime_owner();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER personal_runtime_scope_grant AFTER INSERT OR UPDATE OR DELETE ON platform.agent_principal_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform.enforce_personal_runtime_owner();
