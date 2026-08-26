CREATE TABLE connection_browser_command_idempotency (
  subject_scope_hash TEXT NOT NULL CHECK (subject_scope_hash ~ '^[0-9a-f]{64}$'),
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 160),
  idempotency_key_hash TEXT NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('STARTED', 'COMPLETED')),
  response_ciphertext TEXT,
  response_nonce TEXT,
  response_tag TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT 'infinity'::timestamptz,
  PRIMARY KEY (subject_scope_hash, operation, idempotency_key_hash),
  CHECK (
    (state = 'STARTED'
      AND response_ciphertext IS NULL
      AND response_nonce IS NULL
      AND response_tag IS NULL
      AND completed_at IS NULL)
    OR
    (state = 'COMPLETED'
      AND response_ciphertext IS NOT NULL
      AND response_nonce IS NOT NULL
      AND response_tag IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);

CREATE INDEX connection_browser_command_idempotency_created
  ON connection_browser_command_idempotency (created_at);
