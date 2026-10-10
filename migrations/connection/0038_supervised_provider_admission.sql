-- Scoped pilot admission is additive to the ordinary Connection authority.
CREATE FUNCTION connection_supervised_provider_allowed(
  release_id text, principal_id text DEFAULT NULL, consumer_id text DEFAULT NULL,
  external_account text DEFAULT NULL, instance_id text DEFAULT NULL, actor_key text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE profile jsonb; release_status text; starts_at timestamptz; ends_at timestamptz;
BEGIN
  SELECT deployment_profile->'supervisedPilot', status INTO profile, release_status
  FROM connection_provider_releases WHERE id = release_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF profile IS NULL THEN RETURN release_id <> 'static-spaces-connection-v2-supervised'; END IF;
  IF jsonb_typeof(profile) <> 'object' OR release_status <> 'PUBLISHED'
    OR profile->>'approvalIssue' IS DISTINCT FROM '1681' OR profile->>'principalId' IS NULL
    OR profile->>'consumerId' IS NULL OR profile->>'externalAccount' IS NULL
    THEN RETURN false; END IF;
  BEGIN
    starts_at := (profile->>'startsAt')::timestamptz;
    ends_at := (profile->>'expiresAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN RETURN false; END;
  IF starts_at IS NULL OR ends_at IS NULL OR ends_at <= starts_at
    OR ends_at - starts_at > interval '24 hours'
    OR clock_timestamp() < starts_at OR clock_timestamp() >= ends_at THEN RETURN false; END IF;
  IF principal_id IS NOT NULL AND principal_id <> profile->>'principalId' THEN RETURN false; END IF;
  IF consumer_id IS NOT NULL AND consumer_id <> profile->>'consumerId' THEN RETURN false; END IF;
  IF external_account IS NOT NULL AND external_account <> profile->>'externalAccount' THEN RETURN false; END IF;
  IF actor_key IS NOT NULL AND actor_key <> '' THEN RETURN false; END IF;
  IF instance_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM connection_consumer_instances instance WHERE instance.id = instance_id
      AND instance.kind IN ('DEVICE', 'TOKEN') AND instance.status = 'ACTIVE'
      AND instance.consumer_id = profile->>'consumerId'
      AND instance.principal_id = profile->>'principalId'
  ) THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM connection_audit_records audit
    WHERE audit.event = 'SUPERVISED_PILOT_CLOSED'
      AND audit.detail->>'providerReleaseId' = release_id);
END;
$$;

CREATE FUNCTION connection_close_supervised_provider(release_id text, owner_id text, reason text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM connection_provider_releases
    WHERE id = release_id AND deployment_profile ? 'supervisedPilot') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('supervised-provider:' || release_id, 0));
    INSERT INTO connection_audit_records (principal_id, event, detail)
      VALUES (owner_id, 'SUPERVISED_PILOT_CLOSED',
        jsonb_build_object('providerReleaseId', release_id, 'reason', reason));
  END IF;
END;
$$;

CREATE FUNCTION connection_guard_supervised_provider_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE release_id text; owner_id text; consumer_id text; external_id text; instance_id text; actor_key text;
BEGIN
  IF TG_TABLE_NAME = 'connection_accounts' THEN
    release_id := NEW.provider_release_id; owner_id := NEW.owner_principal_id; external_id := NEW.external_account;
    IF NEW.owner_type <> 'PERSONAL' AND EXISTS (SELECT 1 FROM connection_provider_releases
      WHERE id = release_id AND deployment_profile ? 'supervisedPilot') THEN
      RAISE EXCEPTION 'Supervised provider requires personal ownership' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'connection_consumer_action_declarations' THEN
    release_id := NEW.provider_release_id; consumer_id := NEW.consumer_id;
  ELSIF TG_TABLE_NAME = 'connection_authorization_previews' THEN
    SELECT account.provider_release_id, root.principal_id, root.consumer_id, account.external_account
      INTO release_id, owner_id, consumer_id, external_id
      FROM connection_authorization_roots root JOIN connection_accounts account ON account.id = NEW.connection_id
      WHERE root.id = NEW.root_id;
  ELSIF TG_TABLE_NAME = 'connection_grants' THEN
    release_id := NEW.provider_release_id; owner_id := NEW.principal_id; consumer_id := NEW.consumer_id;
    actor_key := NEW.actor_key;
    SELECT external_account INTO external_id FROM connection_accounts WHERE id = NEW.connection_id;
  ELSIF TG_TABLE_NAME = 'connection_calls' THEN
    SELECT provider_release_id INTO release_id FROM connection_action_versions WHERE id = NEW.action_version_id;
    owner_id := NEW.principal_id; consumer_id := NEW.consumer_id; instance_id := NEW.instance_id;
    SELECT stored.actor_key INTO actor_key FROM connection_grants stored WHERE stored.id = NEW.grant_id;
    SELECT external_account INTO external_id FROM connection_accounts WHERE id = NEW.connection_id;
  ELSIF TG_TABLE_NAME = 'connection_access_requests' THEN
    release_id := NEW.provider_release_id; owner_id := NEW.applicant_principal_id;
  ELSIF TG_TABLE_NAME = 'connection_dispatches' THEN
    IF NEW.status <> 'SUBMISSION_STARTED' THEN RETURN NEW; END IF;
    SELECT action.provider_release_id, call.principal_id, call.consumer_id, account.external_account,
      call.instance_id, stored_grant.actor_key
      INTO release_id, owner_id, consumer_id, external_id, instance_id, actor_key
      FROM connection_effects effect JOIN connection_calls call ON call.id = effect.call_id
      JOIN connection_action_versions action ON action.id = call.action_version_id
      JOIN connection_accounts account ON account.id = call.connection_id
      JOIN connection_grants stored_grant ON stored_grant.id = call.grant_id
      WHERE effect.id = NEW.effect_id;
    IF EXISTS (SELECT 1 FROM connection_provider_releases
      WHERE id = release_id AND deployment_profile ? 'supervisedPilot') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('supervised-provider:' || release_id, 0));
    END IF;
  END IF;
  IF release_id IS NOT NULL AND NOT connection_supervised_provider_allowed(
      release_id, owner_id, consumer_id, external_id, instance_id, actor_key) THEN
    RAISE EXCEPTION 'Supervised provider admission denied' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supervised_account_guard BEFORE INSERT OR UPDATE OF provider_release_id, owner_principal_id, external_account
  ON connection_accounts FOR EACH ROW EXECUTE FUNCTION connection_guard_supervised_provider_write();
CREATE TRIGGER supervised_declaration_guard BEFORE INSERT ON connection_consumer_action_declarations
  FOR EACH ROW EXECUTE FUNCTION connection_guard_supervised_provider_write();
CREATE TRIGGER supervised_preview_guard BEFORE INSERT ON connection_authorization_previews
  FOR EACH ROW EXECUTE FUNCTION connection_guard_supervised_provider_write();
CREATE TRIGGER supervised_grant_guard BEFORE INSERT ON connection_grants
  FOR EACH ROW EXECUTE FUNCTION connection_guard_supervised_provider_write();
CREATE TRIGGER supervised_call_guard BEFORE INSERT ON connection_calls
  FOR EACH ROW EXECUTE FUNCTION connection_guard_supervised_provider_write();
CREATE TRIGGER supervised_request_guard BEFORE INSERT ON connection_access_requests
  FOR EACH ROW EXECUTE FUNCTION connection_guard_supervised_provider_write();
CREATE TRIGGER supervised_dispatch_guard BEFORE UPDATE OF status ON connection_dispatches
  FOR EACH ROW EXECUTE FUNCTION connection_guard_supervised_provider_write();

CREATE FUNCTION connection_close_supervised_provider_on_terminal_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE release_id text;
BEGIN
  IF TG_TABLE_NAME = 'connection_calls' AND NEW.status IN ('UNCERTAIN', 'FAILED') THEN
    SELECT provider_release_id INTO release_id FROM connection_action_versions WHERE id = NEW.action_version_id;
    PERFORM connection_close_supervised_provider(release_id, NEW.principal_id, NEW.status);
  ELSIF TG_TABLE_NAME = 'connection_grants' AND NEW.status IN ('REVOKED', 'TERMINATED', 'PAUSED_CREDENTIAL') THEN
    PERFORM connection_close_supervised_provider(NEW.provider_release_id, NEW.principal_id, 'GRANT_REVOKED');
  ELSIF TG_TABLE_NAME = 'connection_credential_versions' AND NEW.status = 'REVOKED' THEN
    SELECT provider_release_id INTO release_id FROM connection_accounts WHERE id = NEW.connection_id;
    PERFORM connection_close_supervised_provider(release_id,
      (SELECT owner_principal_id FROM connection_accounts WHERE id = NEW.connection_id), 'CREDENTIAL_REVOKED');
  ELSIF TG_TABLE_NAME = 'connection_accounts' AND NEW.status = 'DISCONNECTED' THEN
    PERFORM connection_close_supervised_provider(NEW.provider_release_id, NEW.owner_principal_id, 'DISCONNECTED');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supervised_unknown_close AFTER UPDATE OF status ON connection_calls
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION connection_close_supervised_provider_on_terminal_change();
CREATE TRIGGER supervised_grant_close AFTER UPDATE OF status ON connection_grants
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION connection_close_supervised_provider_on_terminal_change();
CREATE TRIGGER supervised_disconnect_close AFTER UPDATE OF status ON connection_accounts
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION connection_close_supervised_provider_on_terminal_change();

CREATE TRIGGER supervised_credential_close AFTER UPDATE OF status ON connection_credential_versions
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION connection_close_supervised_provider_on_terminal_change();
