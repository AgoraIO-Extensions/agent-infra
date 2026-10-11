-- Approved ordinary release; archived pilot/restricted admission remains unchanged.
ALTER FUNCTION connection_supervised_provider_allowed(text,text,text,text,text,text)
  RENAME TO connection_supervised_provider_allowed_v5;
CREATE FUNCTION connection_supervised_provider_allowed(
  release_id text, principal_id text DEFAULT NULL, consumer_id text DEFAULT NULL,
  external_account text DEFAULT NULL, instance_id text DEFAULT NULL, actor_key text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE deployment jsonb; release_status text; executor text;
BEGIN
  SELECT deployment_profile, status, executor_digest INTO deployment, release_status, executor
    FROM connection_provider_releases WHERE id = release_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF release_id <> 'static-spaces-connection-v6-standard' THEN
    IF deployment ? 'standardApproval' THEN RETURN false; END IF;
    RETURN connection_supervised_provider_allowed_v5(release_id,principal_id,consumer_id,external_account,instance_id,actor_key);
  END IF;
  RETURN release_status = 'PUBLISHED'
    AND executor = 'sha256:54450461a0fb2e2937deb5df4481130cf9c32e898053c0eabdedd4950e2b5a6a'
    AND NOT deployment ? 'restrictedApproval' AND NOT deployment ? 'supervisedPilot'
    AND deployment->'standardApproval' = '{"approvalIssue":"1880","approvalReference":"https://github.com/AgoraIO-Extensions/agent-infra/pull/1878","lifecycle":"CONNECTION_UNRESOLVED_WRITE"}'::jsonb;
END;
$$;

-- Pending calls may coexist; only one submitted unresolved WRITE per Connection.
-- Includes in-flight PREPARED effects so a second submission cannot race UNKNOWN.
-- Query old calls, not the current Grant/Credential/release, to survive upgrades.
CREATE FUNCTION connection_guard_static_spaces_standard_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE connection_key text; release_id text; effect_type text; current_effect text;
BEGIN
  IF TG_TABLE_NAME = 'connection_accounts' THEN
    IF NEW.provider_release_id = 'static-spaces-connection-v6-standard' AND NEW.owner_type <> 'PERSONAL' THEN
      RAISE EXCEPTION 'StaticSpaces requires personal ownership' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'connection_calls' THEN
    SELECT action.provider_release_id, action.effect INTO release_id, effect_type
      FROM connection_action_versions action WHERE action.id = NEW.action_version_id;
    IF effect_type <> 'WRITE' THEN RETURN NEW; END IF;
    connection_key := NEW.connection_id;
  ELSE
    IF NEW.status <> 'SUBMISSION_STARTED' THEN RETURN NEW; END IF;
    SELECT call.connection_id, action.provider_release_id INTO connection_key, release_id
      FROM connection_effects effect JOIN connection_calls call ON call.id = effect.call_id
      JOIN connection_action_versions action ON action.id = call.action_version_id
      WHERE effect.id = NEW.effect_id;
    current_effect := NEW.effect_id;
  END IF;
  -- Applies to future versions as well, if this Connection has standard-version history.
  IF release_id <> 'static-spaces-connection-v6-standard' AND NOT EXISTS (
    SELECT 1 FROM connection_calls call JOIN connection_action_versions action ON action.id = call.action_version_id
    WHERE call.connection_id = connection_key AND action.provider_release_id = 'static-spaces-connection-v6-standard'
  ) THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('static-spaces-write:' || connection_key, 0));
  IF EXISTS (
    SELECT 1 FROM connection_calls call JOIN connection_effects effect ON effect.call_id = call.id
    LEFT JOIN connection_dispatches dispatch ON dispatch.effect_id = effect.id
    WHERE call.connection_id = connection_key AND effect.id IS DISTINCT FROM current_effect
      AND (effect.status = 'UNCERTAIN' OR
        (effect.status = 'PREPARED' AND dispatch.status IN ('SUBMISSION_STARTED','UNCERTAIN','SUCCEEDED')))
  ) THEN
    RAISE EXCEPTION 'StaticSpaces Connection has unresolved WRITE; authorized READ remains available'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connection_static_spaces_personal
  BEFORE INSERT OR UPDATE ON connection_accounts FOR EACH ROW
  EXECUTE FUNCTION connection_guard_static_spaces_standard_write();
CREATE TRIGGER connection_static_spaces_write_creation
  BEFORE INSERT ON connection_calls FOR EACH ROW
  EXECUTE FUNCTION connection_guard_static_spaces_standard_write();
CREATE TRIGGER connection_static_spaces_write_submission
  BEFORE UPDATE OF status ON connection_dispatches FOR EACH ROW
  EXECUTE FUNCTION connection_guard_static_spaces_standard_write();

CREATE INDEX connection_calls_connection_history ON connection_calls(connection_id, action_version_id);
