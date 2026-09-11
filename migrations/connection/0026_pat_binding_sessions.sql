CREATE TABLE connection_pat_consumer_profiles (
  consumer_id TEXT PRIMARY KEY REFERENCES connection_consumers(id),
  callback_url TEXT NOT NULL CHECK (callback_url ~ '^https://'),
  secret_hash TEXT NOT NULL UNIQUE CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE connection_pat_binding_sessions (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  consumer_id TEXT NOT NULL REFERENCES connection_consumers(id),
  instance_id TEXT NOT NULL UNIQUE,
  token_name TEXT NOT NULL CHECK (char_length(btrim(token_name)) BETWEEN 1 AND 100),
  principal_hint_hash TEXT NOT NULL CHECK (principal_hint_hash ~ '^[0-9a-f]{64}$'),
  callback_url TEXT NOT NULL CHECK (callback_url ~ '^https://'),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ISSUED', 'DELIVERED')),
  token_id TEXT UNIQUE REFERENCES connection_personal_access_tokens(id),
  protected_token TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  issued_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'PENDING'
      AND token_id IS NULL AND protected_token IS NULL
      AND issued_at IS NULL AND delivered_at IS NULL)
    OR
    (status = 'ISSUED'
      AND token_id IS NOT NULL AND protected_token IS NOT NULL
      AND issued_at IS NOT NULL AND delivered_at IS NULL)
    OR
    (status = 'DELIVERED'
      AND token_id IS NOT NULL AND protected_token IS NOT NULL
      AND issued_at IS NOT NULL AND delivered_at IS NOT NULL)
  )
);

CREATE INDEX connection_pat_binding_sessions_expiry
  ON connection_pat_binding_sessions (expires_at)
  WHERE status <> 'DELIVERED';
