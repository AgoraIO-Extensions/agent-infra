-- Candidate ActionVersions have no reviewed ProviderRelease binding. Require a
-- fresh or explicitly cleaned database instead of assigning one implicitly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "connection"."action_versions") THEN
    RAISE EXCEPTION 'existing ActionVersions require reviewed ProviderRelease migration';
  END IF;
END;
$$;

CREATE TABLE "connection"."provider_releases" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_id" text NOT NULL,
  "version" varchar(64) NOT NULL,
  "status" varchar(32) DEFAULT 'disabled' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "provider_releases_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "connection"."providers" ("id"),
  CONSTRAINT "provider_releases_provider_version_unique" UNIQUE ("provider_id", "version"),
  CONSTRAINT "provider_releases_binding_unique" UNIQUE ("id", "provider_id"),
  CONSTRAINT "provider_releases_status_check" CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "provider_release_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "provider_release_version_non_empty" CHECK (char_length("version") > 0)
);

ALTER TABLE "connection"."action_versions"
  ADD COLUMN "provider_release_id" text NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'disabled',
  ADD CONSTRAINT "action_versions_release_binding_fk"
    FOREIGN KEY ("provider_release_id", "provider_id")
    REFERENCES "connection"."provider_releases" ("id", "provider_id");

CREATE FUNCTION "connection"."protect_provider_release_declaration"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ProviderRelease declaration is immutable';
  END IF;
  IF ROW(NEW."id", NEW."provider_id", NEW."version", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."provider_id", OLD."version", OLD."created_at") THEN
    RAISE EXCEPTION 'ProviderRelease declaration is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_releases_immutable_declaration_trigger"
BEFORE UPDATE OR DELETE ON "connection"."provider_releases"
FOR EACH ROW EXECUTE FUNCTION "connection"."protect_provider_release_declaration"();

CREATE FUNCTION "connection"."protect_action_version_declaration"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ActionVersion declaration is immutable';
  END IF;
  IF ROW(NEW."id", NEW."provider_id", NEW."provider_release_id",
         NEW."action_id", NEW."version", NEW."effect", NEW."input_schema",
         NEW."output_schema", NEW."required_scopes", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."provider_id", OLD."provider_release_id",
         OLD."action_id", OLD."version", OLD."effect", OLD."input_schema",
         OLD."output_schema", OLD."required_scopes", OLD."created_at") THEN
    RAISE EXCEPTION 'ActionVersion declaration is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "action_versions_immutable_declaration_trigger"
BEFORE UPDATE OR DELETE ON "connection"."action_versions"
FOR EACH ROW EXECUTE FUNCTION "connection"."protect_action_version_declaration"();
