-- HLD section 18.2 requires assertion replay state to survive process restart
-- and to remain independent from PITR-restored business rows.
CREATE TABLE IF NOT EXISTS connection_recovery_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  generation TEXT NOT NULL CHECK (generation ~ '^(0|[1-9][0-9]*)$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO connection_recovery_control (singleton, generation)
VALUES (TRUE, '0')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS connection_delegation_replay (
  instance_id TEXT NOT NULL REFERENCES connection_consumer_instances(id),
  jti_hash TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  action_version_id TEXT NOT NULL REFERENCES connection_action_versions(id),
  invocation_id TEXT NOT NULL,
  recovery_generation TEXT NOT NULL CHECK (recovery_generation ~ '^(0|[1-9][0-9]*)$'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, jti_hash)
);

CREATE INDEX IF NOT EXISTS connection_delegation_replay_expiry
  ON connection_delegation_replay (expires_at);
