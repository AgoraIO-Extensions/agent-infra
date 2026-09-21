CREATE TABLE connection_provider_upgrade_campaigns (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  source_provider_release_id TEXT NOT NULL
    REFERENCES connection_provider_releases(id) ON DELETE RESTRICT,
  target_provider_release_id TEXT NOT NULL
    REFERENCES connection_provider_releases(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  deadline_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, provider_id),
  UNIQUE (source_provider_release_id, target_provider_release_id)
);

CREATE TABLE connection_provider_upgrade_tasks (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL
    REFERENCES connection_provider_upgrade_campaigns(id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL REFERENCES connection_accounts(id) ON DELETE RESTRICT,
  authorization_root_id TEXT NOT NULL
    REFERENCES connection_authorization_roots(id) ON DELETE RESTRICT,
  consumer_id TEXT NOT NULL REFERENCES connection_consumers(id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('PENDING_CONNECTION', 'PENDING_AUTHORIZATION', 'COMPLETED', 'EXPIRED')
  ),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, provider_id)
    REFERENCES connection_provider_upgrade_campaigns(id, provider_id) ON DELETE RESTRICT,
  FOREIGN KEY (authorization_root_id, principal_id, consumer_id, actor_key, provider_id)
    REFERENCES connection_authorization_roots
      (id, principal_id, consumer_id, actor_key, provider_id) ON DELETE RESTRICT,
  FOREIGN KEY (connection_id, principal_id, provider_id)
    REFERENCES connection_accounts(id, principal_id, provider_id) ON DELETE RESTRICT,
  UNIQUE (campaign_id, authorization_root_id)
);

CREATE INDEX connection_provider_upgrade_tasks_principal_status
  ON connection_provider_upgrade_tasks (principal_id, status);

CREATE TABLE connection_outbox_events (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (topic, aggregate_id)
);
