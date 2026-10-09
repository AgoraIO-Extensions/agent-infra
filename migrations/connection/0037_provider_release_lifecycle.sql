-- Deprecation preserves existing execution; retirement preserves all history.
ALTER TABLE connection_provider_releases
  ADD COLUMN deprecated_at TIMESTAMPTZ,
  ADD COLUMN successor_release_id TEXT REFERENCES connection_provider_releases(id),
  ADD COLUMN retirement_reason TEXT,
  ADD COLUMN retired_at TIMESTAMPTZ,
  ADD COLUMN runtime_registered BOOLEAN NOT NULL DEFAULT false;

CREATE VIEW connection_provider_release_dependencies AS
SELECT release.id,
  (SELECT count(*) FROM connection_accounts account
    WHERE account.provider_release_id = release.id AND account.status = 'ACTIVE') AS accounts,
  (SELECT count(*) FROM connection_grants grant_record
    JOIN connection_accounts account ON account.id = grant_record.connection_id
    WHERE grant_record.status = 'ACTIVE' AND
      (account.provider_release_id = release.id OR grant_record.provider_release_id = release.id)) AS grants,
  (SELECT count(*) FROM connection_consumer_action_declarations declaration
    WHERE declaration.provider_release_id = release.id AND declaration.status = 'PUBLISHED') AS declarations,
  (SELECT count(*) FROM connection_calls call_record
    JOIN connection_action_versions action ON action.id = call_record.action_version_id
    WHERE action.provider_release_id = release.id AND
      (call_record.status IN ('AUTHORIZED', 'UNCERTAIN') OR EXISTS (
        SELECT 1 FROM connection_effects effect WHERE effect.call_id = call_record.id
          AND (effect.status IN ('PREPARED', 'UNCERTAIN') OR EXISTS (
            SELECT 1 FROM connection_dispatches dispatch WHERE dispatch.effect_id = effect.id
              AND dispatch.status IN ('PENDING', 'SUBMISSION_STARTED', 'UNCERTAIN')))))) AS unfinished_calls
FROM connection_provider_releases release;

CREATE FUNCTION connection_guard_release_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE release_id TEXT; release_state TEXT; deprecated TIMESTAMPTZ;
BEGIN
  IF TG_TABLE_NAME = 'connection_accounts' THEN
    IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE'
      AND OLD.provider_release_id = NEW.provider_release_id THEN RETURN NEW; END IF;
    release_id := NEW.provider_release_id;
  ELSIF TG_TABLE_NAME = 'connection_grants' THEN
    IF NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' AND OLD.connection_id = NEW.connection_id
      AND OLD.provider_release_id IS NOT DISTINCT FROM NEW.provider_release_id THEN RETURN NEW; END IF;
    SELECT provider_release_id INTO release_id FROM connection_accounts WHERE id = NEW.connection_id;
  ELSIF TG_TABLE_NAME = 'connection_consumer_action_declarations' THEN
    IF NEW.status <> 'PUBLISHED' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'PUBLISHED'
      AND OLD.provider_release_id = NEW.provider_release_id THEN RETURN NEW; END IF;
    release_id := NEW.provider_release_id;
  ELSE
    SELECT provider_release_id INTO release_id FROM connection_action_versions WHERE id = NEW.action_version_id;
  END IF;
  SELECT status, deprecated_at INTO release_state, deprecated
    FROM connection_provider_releases WHERE id = release_id FOR SHARE;
  IF release_state IS DISTINCT FROM 'PUBLISHED' OR
    (TG_TABLE_NAME <> 'connection_calls' AND deprecated IS NOT NULL) THEN
    RAISE EXCEPTION 'ProviderRelease does not admit this operation' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER connection_account_release_admission BEFORE INSERT OR UPDATE OF provider_release_id, status
  ON connection_accounts FOR EACH ROW EXECUTE FUNCTION connection_guard_release_admission();
CREATE TRIGGER connection_grant_release_admission BEFORE INSERT OR UPDATE OF status, connection_id, provider_release_id
  ON connection_grants FOR EACH ROW EXECUTE FUNCTION connection_guard_release_admission();
CREATE TRIGGER connection_declaration_release_admission BEFORE INSERT OR UPDATE OF status, provider_release_id
  ON connection_consumer_action_declarations FOR EACH ROW EXECUTE FUNCTION connection_guard_release_admission();
CREATE TRIGGER connection_call_release_admission BEFORE INSERT
  ON connection_calls FOR EACH ROW EXECUTE FUNCTION connection_guard_release_admission();
