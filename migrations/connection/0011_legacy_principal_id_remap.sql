ALTER TABLE connection_accounts
  DROP CONSTRAINT connection_accounts_principal_id_fkey,
  ADD CONSTRAINT connection_accounts_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE;

ALTER TABLE connection_audit_records
  DROP CONSTRAINT connection_audit_records_principal_id_fkey,
  ADD CONSTRAINT connection_audit_records_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE;

ALTER TABLE connection_authorization_roots
  DROP CONSTRAINT connection_authorization_roots_principal_id_fkey,
  ADD CONSTRAINT connection_authorization_roots_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE;

ALTER TABLE connection_browser_sessions
  DROP CONSTRAINT connection_browser_sessions_principal_id_fkey,
  ADD CONSTRAINT connection_browser_sessions_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE ON DELETE RESTRICT,
  DROP CONSTRAINT connection_browser_sessions_identity_fkey,
  ADD CONSTRAINT connection_browser_sessions_identity_fkey
  FOREIGN KEY (principal_id, identity_issuer)
  REFERENCES connection_principal_identities (principal_id, identity_issuer)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE connection_calls
  DROP CONSTRAINT connection_calls_principal_id_fkey,
  ADD CONSTRAINT connection_calls_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE;

ALTER TABLE connection_consumer_instances
  DROP CONSTRAINT connection_consumer_instances_principal_id_fkey,
  ADD CONSTRAINT connection_consumer_instances_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE;

ALTER TABLE connection_grants
  DROP CONSTRAINT connection_grants_principal_id_fkey,
  ADD CONSTRAINT connection_grants_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE,
  DROP CONSTRAINT connection_grants_connection_subject_fkey,
  ADD CONSTRAINT connection_grants_connection_subject_fkey
  FOREIGN KEY (connection_id, principal_id, provider_id)
  REFERENCES connection_accounts (id, principal_id, provider_id)
  ON UPDATE CASCADE,
  DROP CONSTRAINT connection_grants_direct_root_subject_fkey,
  ADD CONSTRAINT connection_grants_direct_root_subject_fkey
  FOREIGN KEY (root_id, principal_id, consumer_id, actor_key, provider_id)
  REFERENCES connection_authorization_roots (
    id, principal_id, consumer_id, actor_key, provider_id
  )
  ON UPDATE CASCADE;

ALTER TABLE connection_oauth_authorizations
  DROP CONSTRAINT connection_oauth_authorizations_principal_id_fkey,
  ADD CONSTRAINT connection_oauth_authorizations_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE,
  DROP CONSTRAINT connection_oauth_authorizations_instance_subject_fkey,
  ADD CONSTRAINT connection_oauth_authorizations_instance_subject_fkey
  FOREIGN KEY (instance_id, consumer_id, principal_id)
  REFERENCES connection_consumer_instances (id, consumer_id, principal_id)
  ON UPDATE CASCADE;

ALTER TABLE connection_oauth_sessions
  DROP CONSTRAINT connection_oauth_sessions_principal_id_fkey,
  ADD CONSTRAINT connection_oauth_sessions_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE,
  DROP CONSTRAINT connection_oauth_sessions_instance_subject_fkey,
  ADD CONSTRAINT connection_oauth_sessions_instance_subject_fkey
  FOREIGN KEY (instance_id, consumer_id, principal_id)
  REFERENCES connection_consumer_instances (id, consumer_id, principal_id)
  ON UPDATE CASCADE;

ALTER TABLE connection_oauth_transactions
  DROP CONSTRAINT connection_oauth_transactions_principal_id_fkey,
  ADD CONSTRAINT connection_oauth_transactions_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE;

ALTER TABLE connection_personal_access_tokens
  DROP CONSTRAINT connection_personal_access_tokens_principal_id_fkey,
  ADD CONSTRAINT connection_personal_access_tokens_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE ON DELETE RESTRICT,
  DROP CONSTRAINT connection_personal_access_tokens_instance_subject_fkey,
  ADD CONSTRAINT connection_personal_access_tokens_instance_subject_fkey
  FOREIGN KEY (instance_id, consumer_id, principal_id)
  REFERENCES connection_consumer_instances (id, consumer_id, principal_id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE connection_principal_identities
  DROP CONSTRAINT connection_principal_identities_principal_id_fkey,
  ADD CONSTRAINT connection_principal_identities_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES connection_principals(id)
  ON UPDATE CASCADE;
