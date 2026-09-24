-- Existing Consumers have no reviewed Actor mode. A clean database must
-- choose that mode explicitly when each Consumer is registered.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "connection"."consumers") THEN
    RAISE EXCEPTION 'existing Consumers require reviewed Actor policy migration';
  END IF;
END;
$$;

ALTER TABLE "connection"."consumers"
  ADD COLUMN "actor_required" boolean NOT NULL;

ALTER TABLE "connection"."grants"
  ADD COLUMN "expires_at" timestamp with time zone NOT NULL,
  ADD CONSTRAINT "grants_lifetime_check" CHECK ("expires_at" > "created_at");

CREATE FUNCTION "connection"."protect_grant_lifetime"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."created_at" IS DISTINCT FROM OLD."created_at" OR
     NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    RAISE EXCEPTION 'Grant lifetime is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "grants_immutable_lifetime_trigger"
BEFORE UPDATE OF "created_at", "expires_at" ON "connection"."grants"
FOR EACH ROW EXECUTE FUNCTION "connection"."protect_grant_lifetime"();

CREATE FUNCTION "connection"."protect_consumer_actor_policy"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."actor_required" IS DISTINCT FROM OLD."actor_required" THEN
    RAISE EXCEPTION 'Consumer Actor policy is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "consumers_actor_policy_immutable_trigger"
BEFORE UPDATE OF "actor_required" ON "connection"."consumers"
FOR EACH ROW EXECUTE FUNCTION "connection"."protect_consumer_actor_policy"();

CREATE FUNCTION "connection"."enforce_actor_registration"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requires_actor boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id" OR
    NEW."consumer_instance_id" IS DISTINCT FROM OLD."consumer_instance_id"
  ) THEN
    RAISE EXCEPTION 'Actor registration is immutable';
  END IF;
  SELECT c."actor_required" INTO requires_actor
    FROM "connection"."consumer_instances" i
    JOIN "connection"."consumers" c ON c."id" = i."consumer_id"
   WHERE i."id" = NEW."consumer_instance_id";
  IF requires_actor IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Consumer does not define Actors';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "actors_registration_policy_trigger"
BEFORE INSERT OR UPDATE OF "id", "consumer_instance_id"
ON "connection"."actors"
FOR EACH ROW EXECUTE FUNCTION "connection"."enforce_actor_registration"();

CREATE OR REPLACE FUNCTION "connection"."enforce_actor_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requires_actor boolean;
  bound_instance text;
BEGIN
  SELECT "actor_required" INTO requires_actor
    FROM "connection"."consumers"
   WHERE "id" = NEW."consumer_id";
  IF NOT FOUND OR requires_actor = (NEW."actor_id" = '__consumer_actor__') THEN
    RAISE EXCEPTION 'Actor mode does not match Consumer';
  END IF;
  IF NEW."actor_id" = '__consumer_actor__' THEN
    RETURN NEW;
  END IF;

  SELECT "consumer_instance_id" INTO bound_instance
    FROM "connection"."actors"
   WHERE "id" = NEW."actor_id" AND "status" = 'active';
  IF bound_instance IS NULL OR bound_instance <> NEW."consumer_instance_id" THEN
    RAISE EXCEPTION 'actor is not active for consumer instance';
  END IF;
  RETURN NEW;
END;
$$;
