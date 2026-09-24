CREATE SCHEMA IF NOT EXISTS "connection";

CREATE TABLE "connection"."principals" (
  "id" text PRIMARY KEY NOT NULL,
  "issuer" varchar(255) NOT NULL,
  "uid" varchar(255) NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "recovery_generation" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "principals_status_check" CHECK ("status" IN ('active', 'disabled', 'revoked')),
  CONSTRAINT "principals_recovery_generation_positive" CHECK ("recovery_generation" > 0),
  CONSTRAINT "principal_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "principal_issuer_non_empty" CHECK (char_length("issuer") > 0),
  CONSTRAINT "principal_uid_non_empty" CHECK (char_length("uid") > 0)
);

CREATE TABLE "connection"."consumers" (
  "id" text PRIMARY KEY NOT NULL,
  "name" varchar(200) NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "consumers_status_check" CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "consumer_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "consumer_name_non_empty" CHECK (char_length("name") > 0)
);

CREATE TABLE "connection"."consumer_instances" (
  "id" text PRIMARY KEY NOT NULL,
  "consumer_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "installation_key" text NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "recovery_generation" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "consumer_instances_consumer_fk" FOREIGN KEY ("consumer_id") REFERENCES "connection"."consumers" ("id"),
  CONSTRAINT "consumer_instances_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "connection"."principals" ("id"),
  CONSTRAINT "consumer_instances_binding_unique" UNIQUE ("id", "consumer_id", "principal_id"),
  CONSTRAINT "consumer_instances_status_check" CHECK ("status" IN ('active', 'revoked')),
  CONSTRAINT "consumer_instances_recovery_generation_positive" CHECK ("recovery_generation" > 0),
  CONSTRAINT "consumer_instance_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "consumer_instance_installation_key_non_empty" CHECK (char_length("installation_key") > 0)
);

CREATE TABLE "connection"."actors" (
  "id" text PRIMARY KEY NOT NULL,
  "consumer_instance_id" text NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "actors_consumer_instance_fk" FOREIGN KEY ("consumer_instance_id") REFERENCES "connection"."consumer_instances" ("id"),
  CONSTRAINT "actors_instance_binding_unique" UNIQUE ("id", "consumer_instance_id"),
  CONSTRAINT "actors_status_check" CHECK ("status" IN ('active', 'revoked')),
  CONSTRAINT "actors_id_not_consumer_sentinel" CHECK ("id" <> '__consumer_actor__'),
  CONSTRAINT "actor_id_non_empty" CHECK (char_length("id") > 0)
);

CREATE TABLE "connection"."providers" (
  "id" text PRIMARY KEY NOT NULL,
  "name" varchar(200) NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "providers_status_check" CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "provider_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "provider_name_non_empty" CHECK (char_length("name") > 0)
);

CREATE TABLE "connection"."action_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_id" text NOT NULL,
  "action_id" text NOT NULL,
  "version" varchar(64) NOT NULL,
  "effect" varchar(16) NOT NULL,
  "input_schema" jsonb NOT NULL,
  "output_schema" jsonb NOT NULL,
  "required_scopes" jsonb NOT NULL,
  "status" varchar(32) DEFAULT 'published' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "action_versions_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "connection"."providers" ("id"),
  CONSTRAINT "action_versions_effect_check" CHECK ("effect" IN ('read', 'write')),
  CONSTRAINT "action_versions_status_check" CHECK ("status" IN ('published', 'disabled')),
  CONSTRAINT "action_version_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "action_version_action_id_non_empty" CHECK (char_length("action_id") > 0),
  CONSTRAINT "action_version_version_non_empty" CHECK (char_length("version") > 0)
);

CREATE TABLE "connection"."connections" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_id" text NOT NULL,
  "external_account_id" text NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "revocation_revision" bigint DEFAULT 0 NOT NULL,
  "current_credential_version_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connections_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "connection"."providers" ("id"),
  CONSTRAINT "connections_status_check" CHECK ("status" IN ('active', 'disabled', 'revoked')),
  CONSTRAINT "connections_revocation_revision_non_negative" CHECK ("revocation_revision" >= 0),
  CONSTRAINT "connection_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "connection_external_account_id_non_empty" CHECK (char_length("external_account_id") > 0)
);

CREATE TABLE "connection"."credential_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "version" integer NOT NULL,
  "ciphertext" text NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "credential_versions_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "connection"."connections" ("id"),
  CONSTRAINT "credential_versions_binding_unique" UNIQUE ("id", "connection_id"),
  CONSTRAINT "credential_versions_status_check" CHECK ("status" IN ('active', 'revoked')),
  CONSTRAINT "credential_versions_version_positive" CHECK ("version" > 0),
  CONSTRAINT "credential_version_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "credential_version_ciphertext_non_empty" CHECK (char_length("ciphertext") > 0)
);

ALTER TABLE "connection"."connections"
  ADD CONSTRAINT "connections_current_credential_version_fk"
  FOREIGN KEY ("current_credential_version_id")
  REFERENCES "connection"."credential_versions" ("id");

CREATE TABLE "connection"."grants" (
  "id" text PRIMARY KEY NOT NULL,
  "principal_id" text NOT NULL,
  "consumer_id" text NOT NULL,
  "consumer_instance_id" text NOT NULL,
  "actor_id" text NOT NULL,
  "connection_id" text NOT NULL,
  "credential_version_id" text NOT NULL,
  "revision" bigint DEFAULT 1 NOT NULL,
  "principal_recovery_generation" bigint NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "grants_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "connection"."principals" ("id"),
  CONSTRAINT "grants_consumer_fk" FOREIGN KEY ("consumer_id") REFERENCES "connection"."consumers" ("id"),
  CONSTRAINT "grants_consumer_instance_fk" FOREIGN KEY ("consumer_instance_id") REFERENCES "connection"."consumer_instances" ("id"),
  CONSTRAINT "grants_instance_binding_fk" FOREIGN KEY ("consumer_instance_id", "consumer_id", "principal_id") REFERENCES "connection"."consumer_instances" ("id", "consumer_id", "principal_id"),
  CONSTRAINT "grants_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "connection"."connections" ("id"),
  CONSTRAINT "grants_credential_version_fk" FOREIGN KEY ("credential_version_id") REFERENCES "connection"."credential_versions" ("id"),
  CONSTRAINT "grants_credential_connection_fk" FOREIGN KEY ("credential_version_id", "connection_id") REFERENCES "connection"."credential_versions" ("id", "connection_id"),
  CONSTRAINT "grants_binding_unique" UNIQUE ("id", "principal_id", "consumer_id", "consumer_instance_id", "actor_id", "connection_id", "credential_version_id"),
  CONSTRAINT "grants_status_check" CHECK ("status" IN ('active', 'revoked')),
  CONSTRAINT "grants_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "grants_principal_generation_positive" CHECK ("principal_recovery_generation" > 0),
  CONSTRAINT "grant_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "grant_credential_version_id_non_empty" CHECK (char_length("credential_version_id") > 0)
);

CREATE TABLE "connection"."grant_actions" (
  "grant_id" text NOT NULL,
  "action_version_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "grant_actions_pk" PRIMARY KEY ("grant_id", "action_version_id"),
  CONSTRAINT "grant_actions_grant_fk" FOREIGN KEY ("grant_id") REFERENCES "connection"."grants" ("id"),
  CONSTRAINT "grant_actions_action_version_fk" FOREIGN KEY ("action_version_id") REFERENCES "connection"."action_versions" ("id")
);

CREATE TABLE "connection"."action_calls" (
  "id" text PRIMARY KEY NOT NULL,
  "request_id" text NOT NULL,
  "trace_id" text NOT NULL,
  "call_id" text NOT NULL,
  "idempotency_key" varchar(128) NOT NULL,
  "namespace_key" text NOT NULL,
  "principal_id" text NOT NULL,
  "consumer_id" text NOT NULL,
  "consumer_instance_id" text NOT NULL,
  "actor_id" text NOT NULL,
  "grant_id" text NOT NULL,
  "connection_id" text NOT NULL,
  "credential_version_id" text NOT NULL,
  "action_version_id" text NOT NULL,
  "request_digest" varchar(64) NOT NULL,
  "status" varchar(32) DEFAULT 'created' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "action_calls_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "connection"."principals" ("id"),
  CONSTRAINT "action_calls_consumer_fk" FOREIGN KEY ("consumer_id") REFERENCES "connection"."consumers" ("id"),
  CONSTRAINT "action_calls_consumer_instance_fk" FOREIGN KEY ("consumer_instance_id") REFERENCES "connection"."consumer_instances" ("id"),
  CONSTRAINT "action_calls_instance_binding_fk" FOREIGN KEY ("consumer_instance_id", "consumer_id", "principal_id") REFERENCES "connection"."consumer_instances" ("id", "consumer_id", "principal_id"),
  CONSTRAINT "action_calls_grant_fk" FOREIGN KEY ("grant_id") REFERENCES "connection"."grants" ("id"),
  CONSTRAINT "action_calls_grant_binding_fk" FOREIGN KEY ("grant_id", "principal_id", "consumer_id", "consumer_instance_id", "actor_id", "connection_id", "credential_version_id") REFERENCES "connection"."grants" ("id", "principal_id", "consumer_id", "consumer_instance_id", "actor_id", "connection_id", "credential_version_id"),
  CONSTRAINT "action_calls_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "connection"."connections" ("id"),
  CONSTRAINT "action_calls_credential_version_fk" FOREIGN KEY ("credential_version_id") REFERENCES "connection"."credential_versions" ("id"),
  CONSTRAINT "action_calls_action_version_fk" FOREIGN KEY ("action_version_id") REFERENCES "connection"."action_versions" ("id"),
  CONSTRAINT "action_calls_idempotency_key_format" CHECK ("idempotency_key" ~ '^[A-Za-z0-9._~-]{1,128}$'),
  CONSTRAINT "action_calls_request_digest_format" CHECK ("request_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "action_calls_status_check" CHECK ("status" IN ('created', 'submission_started', 'provider_succeeded', 'provider_failed', 'result_pending', 'needs_manual_review', 'unresolved')),
  CONSTRAINT "action_call_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "action_call_request_id_non_empty" CHECK (char_length("request_id") > 0),
  CONSTRAINT "action_call_trace_id_non_empty" CHECK (char_length("trace_id") > 0),
  CONSTRAINT "action_call_namespace_key_non_empty" CHECK (char_length("namespace_key") > 0),
  CONSTRAINT "action_call_credential_version_id_non_empty" CHECK (char_length("credential_version_id") > 0)
);

CREATE TABLE "connection"."effects" (
  "id" text PRIMARY KEY NOT NULL,
  "action_call_id" text NOT NULL,
  "status" varchar(32) DEFAULT 'planned' NOT NULL,
  "provider_request_key" text NOT NULL,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "effects_action_call_fk" FOREIGN KEY ("action_call_id") REFERENCES "connection"."action_calls" ("id"),
  CONSTRAINT "effects_status_check" CHECK ("status" IN ('planned', 'submitted', 'succeeded', 'failed', 'unknown')),
  CONSTRAINT "effect_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "effect_provider_request_key_non_empty" CHECK (char_length("provider_request_key") > 0)
);

CREATE TABLE "connection"."dispatches" (
  "id" text PRIMARY KEY NOT NULL,
  "action_call_id" text NOT NULL,
  "status" varchar(32) DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "dispatches_action_call_fk" FOREIGN KEY ("action_call_id") REFERENCES "connection"."action_calls" ("id"),
  CONSTRAINT "dispatches_status_check" CHECK ("status" IN ('pending', 'claimed', 'completed', 'failed', 'unknown')),
  CONSTRAINT "dispatches_attempt_count_non_negative" CHECK ("attempt_count" >= 0),
  CONSTRAINT "dispatches_lease_pair" CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "dispatch_id_non_empty" CHECK (char_length("id") > 0)
);

CREATE TABLE "connection"."audit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "trace_id" text NOT NULL,
  "principal_id" text,
  "consumer_instance_id" text,
  "actor_id" text,
  "action" varchar(128) NOT NULL,
  "target_type" varchar(64) NOT NULL,
  "target_id" text NOT NULL,
  "outcome" varchar(32) NOT NULL,
  "metadata" jsonb NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audit_events_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "connection"."principals" ("id"),
  CONSTRAINT "audit_events_consumer_instance_fk" FOREIGN KEY ("consumer_instance_id") REFERENCES "connection"."consumer_instances" ("id"),
  CONSTRAINT "audit_events_outcome_check" CHECK ("outcome" IN ('succeeded', 'rejected', 'failed')),
  CONSTRAINT "audit_event_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "audit_event_trace_id_non_empty" CHECK (char_length("trace_id") > 0),
  CONSTRAINT "audit_event_action_non_empty" CHECK (char_length("action") > 0),
  CONSTRAINT "audit_event_target_type_non_empty" CHECK (char_length("target_type") > 0),
  CONSTRAINT "audit_event_target_id_non_empty" CHECK (char_length("target_id") > 0)
);

-- Consumer-level grants use a reserved non-null actor sentinel. A normal
-- foreign key cannot express that conditional binding, so keep the invariant
-- in one database trigger for both grants and persisted calls.
CREATE FUNCTION "connection"."enforce_actor_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bound_instance text;
BEGIN
  IF NEW."actor_id" = '__consumer_actor__' THEN
    RETURN NEW;
  END IF;

  SELECT "consumer_instance_id"
    INTO bound_instance
    FROM "connection"."actors"
   WHERE "id" = NEW."actor_id";

  IF bound_instance IS NULL OR bound_instance <> NEW."consumer_instance_id" THEN
    RAISE EXCEPTION 'actor is not bound to consumer instance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "grants_actor_binding_trigger"
BEFORE INSERT OR UPDATE OF "actor_id", "consumer_instance_id"
ON "connection"."grants"
FOR EACH ROW EXECUTE FUNCTION "connection"."enforce_actor_binding"();

CREATE TRIGGER "action_calls_actor_binding_trigger"
BEFORE INSERT OR UPDATE OF "actor_id", "consumer_instance_id"
ON "connection"."action_calls"
FOR EACH ROW EXECUTE FUNCTION "connection"."enforce_actor_binding"();

CREATE UNIQUE INDEX "principals_issuer_uid_unique" ON "connection"."principals" USING btree ("issuer", "uid");
CREATE UNIQUE INDEX "consumer_instances_installation_unique" ON "connection"."consumer_instances" USING btree ("installation_key");
CREATE UNIQUE INDEX "action_versions_provider_action_version_unique" ON "connection"."action_versions" USING btree ("provider_id", "action_id", "version");
CREATE UNIQUE INDEX "connections_provider_external_account_unique" ON "connection"."connections" USING btree ("provider_id", "external_account_id");
CREATE UNIQUE INDEX "credential_versions_connection_version_unique" ON "connection"."credential_versions" USING btree ("connection_id", "version");
CREATE UNIQUE INDEX "grants_current_binding_unique" ON "connection"."grants" USING btree ("principal_id", "consumer_id", "consumer_instance_id", "actor_id", "connection_id") WHERE "status" = 'active';
CREATE UNIQUE INDEX "action_calls_namespace_key_unique" ON "connection"."action_calls" USING btree ("namespace_key", "idempotency_key");
CREATE UNIQUE INDEX "action_calls_call_id_unique" ON "connection"."action_calls" USING btree ("call_id");
CREATE UNIQUE INDEX "effects_action_call_unique" ON "connection"."effects" USING btree ("action_call_id");
CREATE UNIQUE INDEX "dispatches_action_call_unique" ON "connection"."dispatches" USING btree ("action_call_id");
CREATE INDEX "audit_events_trace_idx" ON "connection"."audit_events" USING btree ("trace_id");
