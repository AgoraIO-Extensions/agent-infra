ALTER TABLE connection_provider_releases
  ADD COLUMN deployment_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN auth_profile JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE connection_consumer_action_declarations
  ADD COLUMN provider_id TEXT;

UPDATE connection_consumer_action_declarations declaration
SET provider_id = release.provider
FROM connection_provider_releases release
WHERE release.id = declaration.provider_release_id
  AND declaration.provider_id IS NULL;

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

CREATE TRIGGER connection_set_declaration_provider_id
BEFORE INSERT OR UPDATE OF provider_release_id, provider_id
ON connection_consumer_action_declarations
FOR EACH ROW EXECUTE FUNCTION connection_set_declaration_provider_id();

ALTER TABLE connection_consumer_action_declarations
  ALTER COLUMN provider_id SET NOT NULL;

DROP INDEX connection_consumer_action_declarations_current;

CREATE UNIQUE INDEX connection_consumer_action_declarations_current
  ON connection_consumer_action_declarations (consumer_id, provider_id)
  WHERE status = 'PUBLISHED';
