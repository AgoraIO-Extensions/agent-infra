-- Scoped pilot admission is additive to the ordinary Connection authority.
CREATE OR REPLACE FUNCTION connection_supervised_provider_allowed(
  release_id text, principal_id text DEFAULT NULL, consumer_id text DEFAULT NULL,
  external_account text DEFAULT NULL, instance_id text DEFAULT NULL, actor_key text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE profile jsonb; release_status text; starts_at timestamptz; ends_at timestamptz;
BEGIN
  SELECT deployment_profile->'supervisedPilot', status INTO profile, release_status
  FROM connection_provider_releases WHERE id = release_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF profile IS NULL THEN RETURN release_id NOT IN ('static-spaces-connection-v2-supervised', 'static-spaces-connection-v3-supervised'); END IF;
  IF jsonb_typeof(profile) <> 'object' OR release_status <> 'PUBLISHED'
    OR profile->>'approvalIssue' IS DISTINCT FROM (CASE
      WHEN release_id = 'static-spaces-connection-v3-supervised' THEN '1714' ELSE '1681' END) OR profile->>'principalId' IS NULL
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
