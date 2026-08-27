ALTER TABLE connection_consumers
  ADD COLUMN IF NOT EXISTS current_declaration_id TEXT;

UPDATE connection_consumers consumer
SET current_declaration_id = declaration.id
FROM connection_consumer_action_declarations declaration
WHERE declaration.consumer_id = consumer.id
  AND declaration.provider_id = 'github'
  AND declaration.status = 'PUBLISHED'
  AND consumer.current_declaration_id IS DISTINCT FROM declaration.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connection_consumers_current_declaration_fkey'
  ) THEN
    ALTER TABLE connection_consumers
      ADD CONSTRAINT connection_consumers_current_declaration_fkey
      FOREIGN KEY (current_declaration_id, id)
      REFERENCES connection_consumer_action_declarations(id, consumer_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION connection_set_declaration_provider_id()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_id IS NULL THEN
    SELECT provider INTO NEW.provider_id
    FROM connection_provider_releases
    WHERE id = NEW.provider_release_id;
  END IF;
  IF NEW.provider_id IS NULL THEN
    RAISE EXCEPTION 'ProviderRelease is unavailable for Consumer declaration';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS connection_set_declaration_provider_id
  ON connection_consumer_action_declarations;

CREATE TRIGGER connection_set_declaration_provider_id
BEFORE INSERT OR UPDATE OF provider_release_id, provider_id
ON connection_consumer_action_declarations
FOR EACH ROW EXECUTE FUNCTION connection_set_declaration_provider_id();
