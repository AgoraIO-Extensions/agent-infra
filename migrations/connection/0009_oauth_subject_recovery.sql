ALTER TABLE connection_oauth_authorizations
  ADD COLUMN recovery_generation TEXT;

-- Pending codes created before this binding cannot be proven to predate the
-- current recovery boundary, so expire them instead of inheriting authority.
UPDATE connection_oauth_authorizations AS auth
SET
  expires_at = LEAST(auth.expires_at, now()),
  recovery_generation = recovery.generation
FROM connection_recovery_control recovery
WHERE auth.recovery_generation IS NULL;

ALTER TABLE connection_oauth_authorizations
  ALTER COLUMN recovery_generation SET NOT NULL,
  ADD CONSTRAINT connection_oauth_authorizations_recovery_generation_check
  CHECK (recovery_generation ~ '^(0|[1-9][0-9]*)$');

-- Repair installations that applied the earlier DIRECT -> DEVICE conversion
-- before PAT-backed instances were distinguished.
UPDATE connection_consumer_instances AS ci
SET kind = 'TOKEN'
FROM connection_personal_access_tokens pat
WHERE pat.instance_id = ci.id
  AND ci.kind <> 'TOKEN';

ALTER TABLE connection_oauth_clients
  ADD CONSTRAINT connection_oauth_clients_subject_key
  UNIQUE (client_id, consumer_id, instance_id),
  ADD CONSTRAINT connection_oauth_clients_instance_consumer_fkey
  FOREIGN KEY (instance_id, consumer_id)
  REFERENCES connection_consumer_instances (id, consumer_id);

ALTER TABLE connection_oauth_authorizations
  ADD CONSTRAINT connection_oauth_authorizations_client_subject_fkey
  FOREIGN KEY (client_id, consumer_id, instance_id)
  REFERENCES connection_oauth_clients (client_id, consumer_id, instance_id),
  ADD CONSTRAINT connection_oauth_authorizations_instance_subject_fkey
  FOREIGN KEY (instance_id, consumer_id, principal_id)
  REFERENCES connection_consumer_instances (id, consumer_id, principal_id);

ALTER TABLE connection_oauth_sessions
  ADD CONSTRAINT connection_oauth_sessions_client_subject_fkey
  FOREIGN KEY (client_id, consumer_id, instance_id)
  REFERENCES connection_oauth_clients (client_id, consumer_id, instance_id),
  ADD CONSTRAINT connection_oauth_sessions_instance_subject_fkey
  FOREIGN KEY (instance_id, consumer_id, principal_id)
  REFERENCES connection_consumer_instances (id, consumer_id, principal_id);
