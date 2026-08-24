ALTER TABLE connection_provider_releases
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;

ALTER TABLE connection_action_versions
  ADD COLUMN required_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;

ALTER TABLE connection_consumers
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN current_declaration_id TEXT;

CREATE TABLE connection_consumer_action_declarations (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES connection_consumers(id) ON DELETE RESTRICT,
  provider_release_id TEXT NOT NULL
    REFERENCES connection_provider_releases(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL,
  digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PUBLISHED', 'SUPERSEDED', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, consumer_id),
  UNIQUE (consumer_id, revision)
);

CREATE UNIQUE INDEX connection_consumer_action_declarations_current
  ON connection_consumer_action_declarations (consumer_id)
  WHERE status = 'PUBLISHED';

CREATE TABLE connection_consumer_declared_actions (
  declaration_id TEXT NOT NULL
    REFERENCES connection_consumer_action_declarations(id) ON DELETE RESTRICT,
  action_version_id TEXT NOT NULL
    REFERENCES connection_action_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (declaration_id, action_version_id)
);

ALTER TABLE connection_consumers
  ADD CONSTRAINT connection_consumers_current_declaration_fkey
  FOREIGN KEY (current_declaration_id, id)
  REFERENCES connection_consumer_action_declarations(id, consumer_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE connection_accounts
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN execution_fence BIGINT NOT NULL DEFAULT 1;

ALTER TABLE connection_credential_versions
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN scope_json JSONB;

ALTER TABLE connection_credential_versions
  ADD CONSTRAINT connection_credential_versions_id_connection_id_key
  UNIQUE (id, connection_id);

ALTER TABLE connection_authorization_previews
  ADD COLUMN declaration_id TEXT,
  ADD CONSTRAINT connection_authorization_previews_declaration_fkey
  FOREIGN KEY (declaration_id) REFERENCES connection_consumer_action_declarations(id)
  ON DELETE RESTRICT;

ALTER TABLE connection_grants
  ADD COLUMN declaration_id TEXT,
  ADD COLUMN connection_revision BIGINT,
  ADD COLUMN connection_execution_fence BIGINT,
  ADD COLUMN external_account_fingerprint TEXT,
  ADD COLUMN shared_eligibility_path_hash TEXT,
  ADD COLUMN credential_version_id TEXT,
  ADD COLUMN credential_revision BIGINT,
  ADD COLUMN credential_scope_digest TEXT,
  ADD COLUMN provider_release_id TEXT,
  ADD COLUMN confirmed_action_set_digest TEXT,
  ADD COLUMN grant_revision BIGINT NOT NULL DEFAULT 1,
  ADD CONSTRAINT connection_grants_declaration_fkey
    FOREIGN KEY (declaration_id) REFERENCES connection_consumer_action_declarations(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT connection_grants_credential_fkey
    FOREIGN KEY (credential_version_id, connection_id)
    REFERENCES connection_credential_versions(id, connection_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT connection_grants_provider_release_fkey
    FOREIGN KEY (provider_release_id, provider_id)
    REFERENCES connection_provider_releases(id, provider)
    ON DELETE RESTRICT;
