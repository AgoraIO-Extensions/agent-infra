ALTER TABLE connection_credential_versions
  ADD COLUMN refresh_ciphertext TEXT,
  ADD COLUMN refresh_nonce TEXT,
  ADD COLUMN refresh_tag TEXT,
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN refresh_expires_at TIMESTAMPTZ;

ALTER TABLE connection_credential_versions
  ADD CONSTRAINT connection_credential_versions_refresh_envelope_check CHECK (
    (refresh_ciphertext IS NULL AND refresh_nonce IS NULL AND refresh_tag IS NULL)
    OR (refresh_ciphertext IS NOT NULL AND refresh_nonce IS NOT NULL AND refresh_tag IS NOT NULL)
  );

CREATE TABLE connection_credential_refresh_attempts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connection_accounts(id) ON DELETE RESTRICT,
  source_credential_version_id TEXT NOT NULL
    REFERENCES connection_credential_versions(id) ON DELETE RESTRICT,
  source_credential_revision BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('PREPARED', 'SUBMISSION_STARTED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN')
  ),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX connection_credential_refresh_attempts_active
ON connection_credential_refresh_attempts (connection_id)
WHERE status IN ('PREPARED', 'SUBMISSION_STARTED');
