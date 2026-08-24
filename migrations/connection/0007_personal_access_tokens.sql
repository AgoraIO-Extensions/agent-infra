CREATE TABLE connection_personal_access_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  principal_id TEXT NOT NULL REFERENCES connection_principals(id),
  consumer_id TEXT NOT NULL REFERENCES connection_consumers(id),
  instance_id TEXT NOT NULL UNIQUE REFERENCES connection_consumer_instances(id),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  recovery_generation TEXT NOT NULL CHECK (recovery_generation ~ '^(0|[1-9][0-9]*)$'),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX connection_personal_access_tokens_principal
  ON connection_personal_access_tokens (principal_id, created_at DESC);
CREATE INDEX connection_personal_access_tokens_expiry
  ON connection_personal_access_tokens (expires_at)
  WHERE revoked_at IS NULL;
