-- New immutable release with unchanged approved scope; closed v4 remains closed.
ALTER FUNCTION connection_supervised_provider_allowed(text,text,text,text,text,text)
  RENAME TO connection_supervised_provider_allowed_v4;
CREATE FUNCTION connection_supervised_provider_allowed(
  release_id text, principal_id text DEFAULT NULL, consumer_id text DEFAULT NULL,
  external_account text DEFAULT NULL, instance_id text DEFAULT NULL, actor_key text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE profile jsonb; release_status text; deployment jsonb;
BEGIN
  SELECT deployment_profile, status INTO deployment, release_status
    FROM connection_provider_releases WHERE id = release_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF release_id <> 'static-spaces-connection-v5-restricted' THEN
    RETURN connection_supervised_provider_allowed_v4(release_id,principal_id,consumer_id,external_account,instance_id,actor_key);
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
      VALUES (owner_id, CASE WHEN EXISTS (SELECT 1 FROM connection_provider_releases WHERE id = release_id AND deployment_profile ? 'restrictedApproval') THEN 'RESTRICTED_PROVIDER_CLOSED' ELSE 'SUPERVISED_PILOT_CLOSED' END,
        jsonb_build_object('providerReleaseId', release_id, 'reason', reason));
  END IF;
END;
$$;


