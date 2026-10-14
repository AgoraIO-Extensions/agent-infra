CREATE TABLE connection_authentication_budgets (
  key_hash TEXT PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  window_ends_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX connection_authentication_budgets_expiry ON connection_authentication_budgets (window_ends_at);
ALTER TABLE connection_oauth_clients ADD COLUMN registration_kind TEXT NOT NULL DEFAULT 'TRUSTED'
  CHECK (registration_kind IN ('TRUSTED', 'DYNAMIC'));
CREATE INDEX connection_oauth_clients_dynamic_cleanup ON connection_oauth_clients (consumer_id, created_at)
  WHERE registration_kind = 'DYNAMIC';
CREATE INDEX connection_oauth_sessions_client ON connection_oauth_sessions (client_id);
