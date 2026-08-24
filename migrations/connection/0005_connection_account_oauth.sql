ALTER TABLE connection_principals
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE connection_principals
  DROP CONSTRAINT IF EXISTS connection_principals_status_check;
ALTER TABLE connection_principals
  ADD CONSTRAINT connection_principals_status_check
  CHECK (status IN ('ACTIVE', 'DISABLED'));

ALTER TABLE connection_consumer_instances
  ADD COLUMN IF NOT EXISTS principal_id TEXT REFERENCES connection_principals(id),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE TABLE connection_principal_identities (
  identity_issuer TEXT NOT NULL,
  identity_subject_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES connection_principals(id),
  identity_reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  verified_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (identity_issuer, identity_subject_hash),
  UNIQUE (principal_id, identity_issuer)
);

CREATE TABLE connection_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  consumer_id TEXT NOT NULL REFERENCES connection_consumers(id),
  instance_id TEXT NOT NULL UNIQUE REFERENCES connection_consumer_instances(id),
  redirect_uris JSONB NOT NULL CHECK (jsonb_typeof(redirect_uris) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE connection_oauth_authorizations (
  request_id_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES connection_oauth_clients(client_id),
  consumer_id TEXT NOT NULL REFERENCES connection_consumers(id),
  instance_id TEXT NOT NULL REFERENCES connection_consumer_instances(id),
  principal_id TEXT REFERENCES connection_principals(id),
  code_challenge TEXT NOT NULL,
  code_hash TEXT UNIQUE,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX connection_oauth_authorizations_expiry
  ON connection_oauth_authorizations (expires_at);

CREATE TABLE connection_oauth_sessions (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES connection_oauth_clients(client_id),
  consumer_id TEXT NOT NULL REFERENCES connection_consumers(id),
  instance_id TEXT NOT NULL REFERENCES connection_consumer_instances(id),
  principal_id TEXT NOT NULL REFERENCES connection_principals(id),
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  recovery_generation TEXT NOT NULL CHECK (recovery_generation ~ '^(0|[1-9][0-9]*)$'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE connection_oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES connection_oauth_sessions(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX connection_oauth_access_tokens_expiry
  ON connection_oauth_access_tokens (expires_at);

CREATE TABLE connection_oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES connection_oauth_sessions(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX connection_oauth_refresh_tokens_expiry
  ON connection_oauth_refresh_tokens (expires_at);

-- G-08 is open, so this migration must not reinterpret existing Grant ownership.
-- A non-empty pre-account authorization store needs an approved data migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM connection_authorization_roots)
    OR EXISTS (SELECT 1 FROM connection_grants) THEN
    RAISE EXCEPTION
      'G-08 blocks automatic migration of existing Connection authorization data';
  END IF;
END $$;

ALTER TABLE connection_provider_releases
  ADD CONSTRAINT connection_provider_releases_id_provider_key
  UNIQUE (id, provider);

ALTER TABLE connection_accounts ADD COLUMN provider_id TEXT;
UPDATE connection_accounts account
SET provider_id = release.provider
FROM connection_provider_releases release
WHERE release.id = account.provider_release_id;
ALTER TABLE connection_accounts ALTER COLUMN provider_id SET NOT NULL;
ALTER TABLE connection_accounts
  ADD CONSTRAINT connection_accounts_release_provider_fkey
  FOREIGN KEY (provider_release_id, provider_id)
  REFERENCES connection_provider_releases (id, provider);
ALTER TABLE connection_accounts
  ADD CONSTRAINT connection_accounts_id_principal_provider_key
  UNIQUE (id, principal_id, provider_id);

ALTER TABLE connection_grants
  DROP CONSTRAINT IF EXISTS connection_grants_root_subject_fkey;
ALTER TABLE connection_authorization_roots
  DROP CONSTRAINT IF EXISTS connection_authorization_roots_id_subject_key;
ALTER TABLE connection_grants
  DROP CONSTRAINT IF EXISTS connection_grants_direct_root_subject_fkey;
DROP INDEX IF EXISTS connection_authorization_roots_direct_scope;
ALTER TABLE connection_authorization_roots
  DROP CONSTRAINT IF EXISTS connection_authorization_root_principal_id_consumer_id_inst_key,
  DROP CONSTRAINT IF EXISTS connection_authorization_roots_id_direct_subject_key,
  DROP CONSTRAINT IF EXISTS connection_authorization_roots_instance_consumer_fkey,
  DROP CONSTRAINT IF EXISTS connection_authorization_roots_connection_principal_fkey,
  DROP CONSTRAINT IF EXISTS connection_authorization_roots_connection_id_fkey,
  DROP CONSTRAINT IF EXISTS connection_authorization_roots_instance_id_fkey;
ALTER TABLE connection_grants
  DROP CONSTRAINT IF EXISTS connection_grants_instance_id_fkey;

ALTER TABLE connection_authorization_roots
  ADD COLUMN actor_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN provider_id TEXT;
ALTER TABLE connection_grants
  ADD COLUMN actor_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN provider_id TEXT;
UPDATE connection_authorization_roots root
SET provider_id = release.provider
FROM connection_accounts account
JOIN connection_provider_releases release ON release.id = account.provider_release_id
WHERE account.id = root.connection_id;
UPDATE connection_grants grant_row
SET provider_id = release.provider
FROM connection_accounts account
JOIN connection_provider_releases release ON release.id = account.provider_release_id
WHERE account.id = grant_row.connection_id;
ALTER TABLE connection_authorization_roots ALTER COLUMN provider_id SET NOT NULL;
ALTER TABLE connection_grants ALTER COLUMN provider_id SET NOT NULL;
ALTER TABLE connection_authorization_roots
  DROP COLUMN instance_id,
  DROP COLUMN connection_id;
ALTER TABLE connection_grants DROP COLUMN instance_id;

ALTER TABLE connection_authorization_roots
  ADD CONSTRAINT connection_authorization_roots_id_direct_subject_key
  UNIQUE (id, principal_id, consumer_id, actor_key, provider_id);

ALTER TABLE connection_grants
  ADD CONSTRAINT connection_grants_direct_root_subject_fkey
  FOREIGN KEY (root_id, principal_id, consumer_id, actor_key, provider_id)
  REFERENCES connection_authorization_roots
    (id, principal_id, consumer_id, actor_key, provider_id);
ALTER TABLE connection_grants
  ADD CONSTRAINT connection_grants_connection_subject_fkey
  FOREIGN KEY (connection_id, principal_id, provider_id)
  REFERENCES connection_accounts (id, principal_id, provider_id);

CREATE UNIQUE INDEX connection_authorization_roots_direct_scope
  ON connection_authorization_roots (principal_id, consumer_id, provider_id)
  WHERE actor_key = '';
CREATE UNIQUE INDEX connection_authorization_roots_delegated_scope
  ON connection_authorization_roots (
    principal_id,
    consumer_id,
    actor_key,
    provider_id
  )
  WHERE actor_key <> '';

DROP INDEX IF EXISTS connection_calls_idempotency_scope;
ALTER TABLE connection_calls ADD COLUMN IF NOT EXISTS actor_key TEXT;
CREATE UNIQUE INDEX connection_calls_idempotency_scope
  ON connection_calls (
    principal_id,
    consumer_id,
    COALESCE(actor_key, ''),
    idempotency_key
  )
  WHERE idempotency_key IS NOT NULL;
