-- New independently approved restricted release. Old pilot admission/closure remains immutable.
ALTER FUNCTION connection_supervised_provider_allowed(text,text,text,text,text,text)
  RENAME TO connection_supervised_provider_allowed_v3;
CREATE FUNCTION connection_supervised_provider_allowed(
  release_id text, principal_id text DEFAULT NULL, consumer_id text DEFAULT NULL,
  external_account text DEFAULT NULL, instance_id text DEFAULT NULL, actor_key text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE profile jsonb; release_status text; deployment jsonb;
BEGIN
  SELECT deployment_profile, status INTO deployment, release_status
    FROM connection_provider_releases WHERE id = release_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF release_id <> 'static-spaces-connection-v4-restricted' THEN
    IF deployment ? 'restrictedApproval' THEN RETURN false; END IF;
    RETURN connection_supervised_provider_allowed_v3(release_id,principal_id,consumer_id,external_account,instance_id,actor_key);
  END IF;
  profile := deployment->'restrictedApproval';
  IF release_status <> 'PUBLISHED' OR deployment ? 'supervisedPilot'
    OR profile IS DISTINCT FROM '{"approvalIssue":"1830","principalId":"e3cc9ece-4e3e-4f2e-866e-3ef38fcf5749","consumerId":"consumer-codex","externalAccount":"841","approvalReference":"https://github.com/AgoraIO-Extensions/agent-infra/pull/1831","lifecycle":"GRANT","applicationId":"0c1e6e33-6750-4127-9d72-157e8899ddcd","ownerGroupId":"5c8d58a6-4732-4e7a-bf3e-c0174e771aa1","viewerGroupId":"9ba88b80-f9fb-43c8-8c91-684f0bbcdef0","canaryRunId":"static-spaces-3071294d-e487-4d98-ae2c-36c5e20550d2"}'::jsonb THEN RETURN false; END IF;
  IF principal_id IS NOT NULL AND principal_id <> profile->>'principalId' THEN RETURN false; END IF;
  IF consumer_id IS NOT NULL AND consumer_id <> profile->>'consumerId' THEN RETURN false; END IF;
  IF external_account IS NOT NULL AND external_account <> profile->>'externalAccount' THEN RETURN false; END IF;
  IF actor_key IS NOT NULL AND actor_key <> '' THEN RETURN false; END IF;
  IF instance_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM connection_consumer_instances instance WHERE instance.id = instance_id
      AND instance.kind IN ('DEVICE','TOKEN') AND instance.status = 'ACTIVE'
      AND instance.consumer_id = profile->>'consumerId'
      AND instance.principal_id = profile->>'principalId'
  ) THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM connection_audit_records audit
    WHERE audit.event IN ('RESTRICTED_PROVIDER_CLOSED','SUPERVISED_PILOT_CLOSED')
      AND audit.detail->>'providerReleaseId' = release_id);
END;
$$;

CREATE OR REPLACE FUNCTION connection_close_supervised_provider(release_id text, owner_id text, reason text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM connection_provider_releases
    WHERE id = release_id AND (deployment_profile ? 'supervisedPilot' OR deployment_profile ? 'restrictedApproval')) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('supervised-provider:' || release_id, 0));
    INSERT INTO connection_audit_records (principal_id, event, detail)
      VALUES (owner_id, CASE WHEN release_id = 'static-spaces-connection-v4-restricted' THEN 'RESTRICTED_PROVIDER_CLOSED' ELSE 'SUPERVISED_PILOT_CLOSED' END,
        jsonb_build_object('providerReleaseId', release_id, 'reason', reason));
  END IF;
END;
$$;


CREATE OR REPLACE FUNCTION connection_guard_supervised_provider_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE release_id text; owner_id text; consumer_id text; external_id text; instance_id text; actor_key text;
BEGIN
  IF TG_TABLE_NAME = 'connection_accounts' THEN
    release_id := NEW.provider_release_id; owner_id := NEW.owner_principal_id; external_id := NEW.external_account;
    IF NEW.owner_type <> 'PERSONAL' AND EXISTS (SELECT 1 FROM connection_provider_releases
      WHERE id = release_id AND (deployment_profile ? 'supervisedPilot' OR deployment_profile ? 'restrictedApproval')) THEN
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
      WHERE id = release_id AND (deployment_profile ? 'supervisedPilot' OR deployment_profile ? 'restrictedApproval')) THEN
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
