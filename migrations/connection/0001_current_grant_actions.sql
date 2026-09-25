-- A current ActionVersion has exactly one Connection binding per subject.
-- Historical grant_actions remain after revocation; this table is the current
-- binding enforced by PostgreSQL's unique index under concurrent inserts.
ALTER TABLE "connection"."grants"
  ADD COLUMN "approved_action_version_ids" text[];

UPDATE "connection"."grants" g
   SET "approved_action_version_ids" = ARRAY(
     SELECT ga."action_version_id"
       FROM "connection"."grant_actions" ga
      WHERE ga."grant_id" = g."id"
      ORDER BY ga."action_version_id"
   );

ALTER TABLE "connection"."grants"
  ALTER COLUMN "approved_action_version_ids" SET NOT NULL,
  ADD CONSTRAINT "grants_approved_actions_nonempty"
    CHECK (cardinality("approved_action_version_ids") > 0);

CREATE TABLE "connection"."current_grant_actions" (
  "grant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "consumer_id" text NOT NULL,
  "consumer_instance_id" text NOT NULL,
  "actor_id" text NOT NULL,
  "action_version_id" text NOT NULL,
  CONSTRAINT "current_grant_actions_pk" PRIMARY KEY ("grant_id", "action_version_id"),
  CONSTRAINT "current_grant_actions_grant_fk" FOREIGN KEY ("grant_id") REFERENCES "connection"."grants" ("id"),
  CONSTRAINT "current_grant_actions_action_fk" FOREIGN KEY ("action_version_id") REFERENCES "connection"."action_versions" ("id")
);

CREATE UNIQUE INDEX "current_grant_actions_subject_action_unique"
ON "connection"."current_grant_actions" (
  "principal_id", "consumer_id", "consumer_instance_id", "actor_id", "action_version_id"
);

CREATE FUNCTION "connection"."validate_current_grant_action"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bound "connection"."grants"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO bound FROM "connection"."grants" WHERE "id" = OLD."grant_id";
    IF bound."status" = 'active' THEN
      RAISE EXCEPTION 'current grant action cannot be removed while grant is active';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'current grant action is immutable';
  END IF;

  SELECT * INTO bound FROM "connection"."grants"
   WHERE "id" = NEW."grant_id" FOR UPDATE;
  IF NOT FOUND OR bound."status" <> 'active' OR
     bound."principal_id" <> NEW."principal_id" OR
     bound."consumer_id" <> NEW."consumer_id" OR
     bound."consumer_instance_id" <> NEW."consumer_instance_id" OR
     bound."actor_id" <> NEW."actor_id" OR
     NOT EXISTS (
       SELECT 1 FROM "connection"."grant_actions"
        WHERE "grant_id" = NEW."grant_id"
          AND "action_version_id" = NEW."action_version_id"
     ) THEN
    RAISE EXCEPTION 'current grant action binding is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "current_grant_actions_validate_trigger"
BEFORE INSERT OR UPDATE OR DELETE ON "connection"."current_grant_actions"
FOR EACH ROW EXECUTE FUNCTION "connection"."validate_current_grant_action"();

CREATE FUNCTION "connection"."publish_current_grant_action"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bound "connection"."grants"%ROWTYPE;
BEGIN
  SELECT * INTO bound FROM "connection"."grants"
   WHERE "id" = NEW."grant_id" FOR UPDATE;
  IF NOT FOUND OR bound."status" <> 'active' OR
     NOT (NEW."action_version_id" = ANY(bound."approved_action_version_ids")) THEN
    RAISE EXCEPTION 'grant is not active';
  END IF;
  INSERT INTO "connection"."current_grant_actions" (
    "grant_id", "principal_id", "consumer_id", "consumer_instance_id", "actor_id", "action_version_id"
  ) VALUES (
    NEW."grant_id", bound."principal_id", bound."consumer_id",
    bound."consumer_instance_id", bound."actor_id", NEW."action_version_id"
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "grant_actions_publish_current_trigger"
AFTER INSERT ON "connection"."grant_actions"
FOR EACH ROW EXECUTE FUNCTION "connection"."publish_current_grant_action"();

CREATE FUNCTION "connection"."protect_grant_action"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'grant action declaration is immutable';
END;
$$;

CREATE TRIGGER "grant_actions_immutable_trigger"
BEFORE UPDATE OR DELETE ON "connection"."grant_actions"
FOR EACH ROW EXECUTE FUNCTION "connection"."protect_grant_action"();

CREATE FUNCTION "connection"."populate_grant_actions"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  action_id text;
BEGIN
  FOREACH action_id IN ARRAY NEW."approved_action_version_ids" LOOP
    INSERT INTO "connection"."grant_actions" ("grant_id", "action_version_id")
    VALUES (NEW."id", action_id);
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "grants_populate_actions_trigger"
AFTER INSERT ON "connection"."grants"
FOR EACH ROW EXECUTE FUNCTION "connection"."populate_grant_actions"();

CREATE FUNCTION "connection"."protect_grant_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."principal_id" IS DISTINCT FROM OLD."principal_id" OR
     NEW."consumer_id" IS DISTINCT FROM OLD."consumer_id" OR
     NEW."consumer_instance_id" IS DISTINCT FROM OLD."consumer_instance_id" OR
     NEW."actor_id" IS DISTINCT FROM OLD."actor_id" OR
     NEW."connection_id" IS DISTINCT FROM OLD."connection_id" OR
     NEW."credential_version_id" IS DISTINCT FROM OLD."credential_version_id" OR
     NEW."principal_recovery_generation" IS DISTINCT FROM OLD."principal_recovery_generation" OR
     NEW."consumer_instance_recovery_generation" IS DISTINCT FROM OLD."consumer_instance_recovery_generation" OR
     NEW."approved_action_version_ids" IS DISTINCT FROM OLD."approved_action_version_ids" THEN
    RAISE EXCEPTION 'grant binding is immutable';
  END IF;
  IF NEW."revision" IS DISTINCT FROM OLD."revision" AND NOT (
    OLD."status" = 'active' AND NEW."status" = 'revoked' AND
    NEW."revision" = OLD."revision" + 1
  ) THEN
    RAISE EXCEPTION 'grant revision requires revocation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "grants_immutable_binding_trigger"
BEFORE UPDATE ON "connection"."grants"
FOR EACH ROW EXECUTE FUNCTION "connection"."protect_grant_binding"();

CREATE FUNCTION "connection"."sync_grant_revocation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'revoked' OR NEW."status" <> 'revoked' OR
     NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'invalid grant revocation';
  END IF;
  DELETE FROM "connection"."current_grant_actions"
   WHERE "grant_id" = NEW."id";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "grants_revoke_current_actions_trigger"
AFTER UPDATE OF "status" ON "connection"."grants"
FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION "connection"."sync_grant_revocation"();

-- Existing candidate data must satisfy the current uniqueness rule. A
-- conflicting historical candidate aborts this migration for explicit review.
INSERT INTO "connection"."current_grant_actions" (
  "grant_id", "principal_id", "consumer_id", "consumer_instance_id", "actor_id", "action_version_id"
)
SELECT g."id", g."principal_id", g."consumer_id", g."consumer_instance_id",
       g."actor_id", ga."action_version_id"
  FROM "connection"."grants" g
  JOIN "connection"."grant_actions" ga ON ga."grant_id" = g."id"
 WHERE g."status" = 'active';
