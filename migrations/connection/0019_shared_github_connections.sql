CREATE TABLE connection_shared_scopes (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
  revision BIGINT NOT NULL DEFAULT 1,
  created_by_principal_id TEXT NOT NULL
    CONSTRAINT connection_shared_scopes_created_by_fkey
    REFERENCES connection_principals(id) ON UPDATE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE connection_shared_scope_principals (
  shared_scope_id TEXT NOT NULL REFERENCES connection_shared_scopes(id),
  principal_id TEXT NOT NULL
    CONSTRAINT connection_shared_scope_principals_principal_id_fkey
    REFERENCES connection_principals(id) ON UPDATE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  revision BIGINT NOT NULL DEFAULT 1,
  granted_by_principal_id TEXT NOT NULL
    CONSTRAINT connection_shared_scope_principals_granted_by_fkey
    REFERENCES connection_principals(id) ON UPDATE CASCADE,
  revoked_by_principal_id TEXT
    CONSTRAINT connection_shared_scope_principals_revoked_by_fkey
    REFERENCES connection_principals(id) ON UPDATE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (shared_scope_id, principal_id),
  CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL AND revoked_by_principal_id IS NULL)
    OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

ALTER TABLE connection_accounts
  RENAME COLUMN principal_id TO owner_principal_id;

ALTER TABLE connection_grants
  DROP CONSTRAINT connection_grants_connection_subject_fkey;

ALTER TABLE connection_oauth_transactions
  ADD COLUMN shared_scope_id TEXT REFERENCES connection_shared_scopes(id);

ALTER TABLE connection_accounts
  DROP CONSTRAINT connection_accounts_principal_id_fkey,
  DROP CONSTRAINT connection_accounts_id_principal_id_key,
  DROP CONSTRAINT connection_accounts_id_principal_provider_key,
  ALTER COLUMN owner_principal_id DROP NOT NULL,
  ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'PERSONAL',
  ADD COLUMN shared_scope_id TEXT REFERENCES connection_shared_scopes(id),
  ADD CONSTRAINT connection_accounts_owner_principal_fkey
    FOREIGN KEY (owner_principal_id) REFERENCES connection_principals(id)
    ON UPDATE CASCADE,
  ADD CONSTRAINT connection_accounts_owner_check CHECK (
    (owner_type = 'PERSONAL' AND owner_principal_id IS NOT NULL AND shared_scope_id IS NULL)
    OR
    (owner_type = 'SHARED' AND owner_principal_id IS NULL AND shared_scope_id IS NOT NULL)
  ),
  ADD CONSTRAINT connection_accounts_id_provider_key UNIQUE (id, provider_id);

ALTER TABLE connection_grants
  ADD CONSTRAINT connection_grants_connection_provider_fkey
    FOREIGN KEY (connection_id, provider_id)
    REFERENCES connection_accounts(id, provider_id)
    ON UPDATE CASCADE;

CREATE INDEX connection_accounts_shared_scope
ON connection_accounts (shared_scope_id, provider_id)
WHERE owner_type = 'SHARED';

CREATE UNIQUE INDEX connection_accounts_personal_external_identity
ON connection_accounts (owner_principal_id, provider_id, external_account)
WHERE owner_type = 'PERSONAL';

CREATE UNIQUE INDEX connection_accounts_shared_external_identity
ON connection_accounts (shared_scope_id, provider_id, external_account)
WHERE owner_type = 'SHARED';

CREATE INDEX connection_shared_scope_principals_active
ON connection_shared_scope_principals (principal_id, shared_scope_id)
WHERE status = 'ACTIVE';

CREATE OR REPLACE FUNCTION connection_enforce_grant_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status
    OR (
      OLD.status = 'ACTIVE'
      AND NEW.status IN (
        'PAUSED_CONNECTION',
        'PAUSED_CREDENTIAL',
        'REPLACED',
        'REVOKED',
        'TERMINATED'
      )
    )
    OR (
      OLD.status IN ('PAUSED_CONNECTION', 'PAUSED_CREDENTIAL')
      AND NEW.status = 'TERMINATED'
    ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid Connection grant status transition: % -> %',
    OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$;
