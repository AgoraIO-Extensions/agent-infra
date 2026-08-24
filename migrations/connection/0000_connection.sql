CREATE TABLE IF NOT EXISTS connection_principals (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connection_consumers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED'))
);

CREATE TABLE IF NOT EXISTS connection_consumer_instances (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES connection_consumers(id),
  kind TEXT NOT NULL CHECK (kind IN ('DIRECT', 'DELEGATED')),
  auth_subject TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED'))
);

CREATE TABLE IF NOT EXISTS connection_provider_releases (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PUBLISHED', 'DISABLED'))
);

CREATE TABLE IF NOT EXISTS connection_action_versions (
  id TEXT PRIMARY KEY,
  provider_release_id TEXT NOT NULL REFERENCES connection_provider_releases(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('READ', 'WRITE')),
  input_schema JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PUBLISHED', 'DISABLED'))
);

CREATE TABLE IF NOT EXISTS connection_accounts (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES connection_principals(id),
  provider_release_id TEXT NOT NULL REFERENCES connection_provider_releases(id),
  external_account TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISCONNECTED'))
);

CREATE TABLE IF NOT EXISTS connection_credential_versions (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connection_accounts(id),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  tag TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED'))
);

CREATE TABLE IF NOT EXISTS connection_grants (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES connection_principals(id),
  consumer_id TEXT NOT NULL REFERENCES connection_consumers(id),
  instance_id TEXT NOT NULL REFERENCES connection_consumer_instances(id),
  connection_id TEXT NOT NULL REFERENCES connection_accounts(id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'REPLACED'))
);

CREATE TABLE IF NOT EXISTS connection_authorization_roots (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES connection_principals(id),
  consumer_id TEXT NOT NULL REFERENCES connection_consumers(id),
  instance_id TEXT NOT NULL REFERENCES connection_consumer_instances(id),
  connection_id TEXT NOT NULL REFERENCES connection_accounts(id),
  current_grant_id TEXT,
  fence BIGINT NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'TERMINATED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (principal_id, consumer_id, instance_id, connection_id)
);

CREATE TABLE IF NOT EXISTS connection_authorization_consents (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES connection_authorization_roots(id),
  action_version_ids JSONB NOT NULL,
  snapshot_hash TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE connection_grants ADD COLUMN IF NOT EXISTS root_id TEXT REFERENCES connection_authorization_roots(id);
ALTER TABLE connection_grants ADD COLUMN IF NOT EXISTS consent_id TEXT REFERENCES connection_authorization_consents(id);

CREATE TABLE IF NOT EXISTS connection_grant_actions (
  grant_id TEXT NOT NULL REFERENCES connection_grants(id) ON DELETE CASCADE,
  action_version_id TEXT NOT NULL REFERENCES connection_action_versions(id),
  PRIMARY KEY (grant_id, action_version_id)
);

-- Earlier development builds cast JSON text to jsonb through a string parameter,
-- which produces a JSON string rather than the intended object or array.
UPDATE connection_authorization_consents
SET action_version_ids = (action_version_ids #>> '{}')::jsonb
WHERE jsonb_typeof(action_version_ids) = 'string';

DO $$
BEGIN
  IF to_regclass('public.connection_calls') IS NOT NULL THEN
    UPDATE connection_calls
    SET request_input = (request_input #>> '{}')::jsonb
    WHERE jsonb_typeof(request_input) = 'string';

    UPDATE connection_calls
    SET result = (result #>> '{}')::jsonb
    WHERE jsonb_typeof(result) = 'string';
  END IF;

  IF to_regclass('public.connection_audit_records') IS NOT NULL THEN
    UPDATE connection_audit_records
    SET detail = (detail #>> '{}')::jsonb
    WHERE jsonb_typeof(detail) = 'string';
  END IF;
END $$;

-- Upgrade legacy grants into immutable consent records and a current root pointer.
-- New confirmations use SHA-256 in the application; this deterministic legacy marker
-- preserves the exact pre-root grant without pretending it was user-confirmed anew.
INSERT INTO connection_authorization_roots (
  id, principal_id, consumer_id, instance_id, connection_id, current_grant_id, status
)
SELECT
  'root-' || g.id,
  g.principal_id,
  g.consumer_id,
  g.instance_id,
  g.connection_id,
  CASE WHEN g.status = 'ACTIVE' THEN g.id ELSE NULL END,
  CASE WHEN g.status = 'ACTIVE' THEN 'ACTIVE' ELSE 'TERMINATED' END
FROM connection_grants g
WHERE g.root_id IS NULL
ON CONFLICT (principal_id, consumer_id, instance_id, connection_id) DO NOTHING;

UPDATE connection_authorization_roots root
SET current_grant_id = g.id, fence = fence + 1
FROM connection_grants g
WHERE g.root_id IS NULL
  AND g.status = 'ACTIVE'
  AND root.principal_id = g.principal_id
  AND root.consumer_id = g.consumer_id
  AND root.instance_id = g.instance_id
  AND root.connection_id = g.connection_id
  AND root.current_grant_id IS NULL
  AND root.status = 'ACTIVE';

INSERT INTO connection_authorization_consents (
  id, root_id, action_version_ids, snapshot_hash
)
SELECT
  'legacy-consent-' || g.id,
  root.id,
  COALESCE(actions.action_version_ids, '[]'::jsonb),
  'legacy-grant:' || g.id
FROM connection_grants g
JOIN connection_authorization_roots root
  ON root.principal_id = g.principal_id
  AND root.consumer_id = g.consumer_id
  AND root.instance_id = g.instance_id
  AND root.connection_id = g.connection_id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(ga.action_version_id ORDER BY ga.action_version_id) AS action_version_ids
  FROM connection_grant_actions ga
  WHERE ga.grant_id = g.id
) actions ON TRUE
WHERE g.root_id IS NULL
ON CONFLICT (id) DO NOTHING;

UPDATE connection_grants g
SET
  root_id = root.id,
  consent_id = 'legacy-consent-' || g.id
FROM connection_authorization_roots root
WHERE g.root_id IS NULL
  AND root.principal_id = g.principal_id
  AND root.consumer_id = g.consumer_id
  AND root.instance_id = g.instance_id
  AND root.connection_id = g.connection_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'connection_grants_status_check'
  ) THEN
    ALTER TABLE connection_grants DROP CONSTRAINT connection_grants_status_check;
    ALTER TABLE connection_grants ADD CONSTRAINT connection_grants_status_check
      CHECK (status IN ('ACTIVE', 'REVOKED', 'REPLACED'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS connection_calls (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES connection_principals(id),
  consumer_id TEXT NOT NULL REFERENCES connection_consumers(id),
  instance_id TEXT NOT NULL REFERENCES connection_consumer_instances(id),
  grant_id TEXT NOT NULL REFERENCES connection_grants(id),
  connection_id TEXT NOT NULL REFERENCES connection_accounts(id),
  credential_version_id TEXT NOT NULL REFERENCES connection_credential_versions(id),
  action_version_id TEXT NOT NULL REFERENCES connection_action_versions(id),
  request_hash TEXT NOT NULL,
  request_input JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('AUTHORIZED', 'DENIED_LOCAL', 'SUCCEEDED', 'FAILED', 'UNCERTAIN')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE connection_calls ADD COLUMN IF NOT EXISTS request_input JSONB NOT NULL DEFAULT '{}'::jsonb;

-- A business retry must survive a replacement Grant or ActionVersion. The stable
-- authenticated subject, not a revocable snapshot, owns the request key.
DROP INDEX IF EXISTS connection_calls_idempotency_scope;
CREATE UNIQUE INDEX connection_calls_idempotency_scope
ON connection_calls (principal_id, consumer_id, instance_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS connection_effects (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES connection_calls(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('PREPARED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN'))
);

CREATE TABLE IF NOT EXISTS connection_dispatches (
  id TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL REFERENCES connection_effects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUBMISSION_STARTED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN'))
);

CREATE TABLE IF NOT EXISTS connection_reconciliation_jobs (
  call_id TEXT PRIMARY KEY REFERENCES connection_calls(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  leased_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'LEASED', 'SUCCEEDED')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE connection_reconciliation_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS connection_audit_records (
  id BIGSERIAL PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES connection_principals(id),
  call_id TEXT REFERENCES connection_calls(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connection_oauth_transactions (
  state_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES connection_principals(id),
  verifier_ciphertext TEXT NOT NULL,
  verifier_nonce TEXT NOT NULL,
  verifier_tag TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'connection_oauth_transactions' AND column_name = 'state'
  ) THEN
    ALTER TABLE connection_oauth_transactions RENAME COLUMN state TO state_hash;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'connection_oauth_transactions' AND column_name = 'code_verifier'
  ) THEN
    ALTER TABLE connection_oauth_transactions RENAME COLUMN code_verifier TO verifier_ciphertext;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'connection_oauth_transactions' AND column_name = 'verifier_nonce'
  ) THEN
    ALTER TABLE connection_oauth_transactions ADD COLUMN verifier_nonce TEXT;
    ALTER TABLE connection_oauth_transactions ADD COLUMN verifier_tag TEXT;
    UPDATE connection_oauth_transactions SET verifier_nonce = '', verifier_tag = '';
    ALTER TABLE connection_oauth_transactions ALTER COLUMN verifier_nonce SET NOT NULL;
    ALTER TABLE connection_oauth_transactions ALTER COLUMN verifier_tag SET NOT NULL;
  END IF;
END $$;
