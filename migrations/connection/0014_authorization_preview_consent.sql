CREATE TABLE connection_authorization_previews (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES connection_authorization_roots(id),
  connection_id TEXT NOT NULL REFERENCES connection_accounts(id),
  confirmation_token_hash TEXT NOT NULL UNIQUE,
  action_version_ids JSONB NOT NULL,
  action_set_digest TEXT NOT NULL,
  authorization_digest TEXT NOT NULL,
  source_revisions JSONB NOT NULL,
  root_fence BIGINT NOT NULL,
  current_grant_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  confirmation_idempotency_key TEXT,
  confirmed_grant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, root_id),
  FOREIGN KEY (current_grant_id, root_id)
    REFERENCES connection_grants(id, root_id),
  FOREIGN KEY (confirmed_grant_id, root_id)
    REFERENCES connection_grants(id, root_id),
  CHECK (
    (consumed_at IS NULL
      AND confirmation_idempotency_key IS NULL
      AND confirmed_grant_id IS NULL)
    OR
    (consumed_at IS NOT NULL
      AND confirmation_idempotency_key IS NOT NULL
      AND confirmed_grant_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX connection_authorization_previews_confirmation_idempotency
  ON connection_authorization_previews (root_id, confirmation_idempotency_key)
  WHERE confirmation_idempotency_key IS NOT NULL;

ALTER TABLE connection_authorization_consents
  ADD COLUMN preview_id TEXT;

ALTER TABLE connection_authorization_consents
  ADD CONSTRAINT connection_authorization_consents_preview_root_fkey
  FOREIGN KEY (preview_id, root_id)
  REFERENCES connection_authorization_previews (id, root_id);

CREATE UNIQUE INDEX connection_authorization_consents_preview
  ON connection_authorization_consents (preview_id)
  WHERE preview_id IS NOT NULL;

ALTER TABLE connection_grant_actions
  ADD COLUMN authorization_digest TEXT;
