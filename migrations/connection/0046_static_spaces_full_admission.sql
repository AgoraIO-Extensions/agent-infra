-- Approved full release; v1-v6 history remains unchanged.
ALTER FUNCTION connection_supervised_provider_allowed(text,text,text,text,text,text)
  RENAME TO connection_supervised_provider_allowed_v6;
CREATE FUNCTION connection_supervised_provider_allowed(
  release_id text, principal_id text DEFAULT NULL, consumer_id text DEFAULT NULL,
  external_account text DEFAULT NULL, instance_id text DEFAULT NULL, actor_key text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE deployment jsonb; release_status text; executor text;
BEGIN
  IF release_id <> 'static-spaces-connection-v7-full' THEN
    RETURN connection_supervised_provider_allowed_v6(release_id,principal_id,consumer_id,external_account,instance_id,actor_key);
  END IF;
  SELECT deployment_profile, status, executor_digest INTO deployment, release_status, executor
    FROM connection_provider_releases WHERE id = release_id;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN release_status = 'PUBLISHED'
    AND executor = 'sha256:08ac0209380239bfb46a21f4d53460fb077396b2f12c84535a37a59f4400c0e4'
    AND NOT deployment ? 'restrictedApproval' AND NOT deployment ? 'supervisedPilot'
    AND deployment->'standardApproval' = '{"approvalIssue":"1927","approvalReference":"https://github.com/AgoraIO-Extensions/agent-infra/issues/1927","lifecycle":"CONNECTION_UNRESOLVED_WRITE"}'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION connection_guard_static_spaces_standard_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE connection_key text; release_id text; effect_type text; current_effect text;
BEGIN
  IF TG_TABLE_NAME = 'connection_accounts' THEN
    IF NEW.provider_release_id IN ('static-spaces-connection-v6-standard','static-spaces-connection-v7-full') AND NEW.owner_type <> 'PERSONAL' THEN
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
  IF release_id NOT IN ('static-spaces-connection-v6-standard','static-spaces-connection-v7-full') AND NOT EXISTS (
    SELECT 1 FROM connection_calls call JOIN connection_action_versions action ON action.id = call.action_version_id
    WHERE call.connection_id = connection_key AND action.provider_release_id IN ('static-spaces-connection-v6-standard','static-spaces-connection-v7-full')
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
