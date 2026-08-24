CREATE TABLE connection_browser_sessions (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  identity_issuer TEXT NOT NULL,
  recovery_generation TEXT NOT NULL CHECK (recovery_generation ~ '^(0|[1-9][0-9]*)$'),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT connection_browser_sessions_identity_fkey
    FOREIGN KEY (principal_id, identity_issuer)
    REFERENCES connection_principal_identities (principal_id, identity_issuer)
    ON DELETE RESTRICT
);

CREATE INDEX connection_browser_sessions_principal
  ON connection_browser_sessions (principal_id, created_at DESC);
CREATE INDEX connection_browser_sessions_expiry
  ON connection_browser_sessions (expires_at)
  WHERE revoked_at IS NULL;
