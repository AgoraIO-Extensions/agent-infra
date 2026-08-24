-- HLD sections 13 and 17 require these relationships to be database invariants,
-- not only application-level predicates. Existing rows were normalized by the
-- baseline migration before these constraints are applied.
ALTER TABLE connection_consumer_instances
  ADD CONSTRAINT connection_consumer_instances_id_consumer_id_key
  UNIQUE (id, consumer_id);

ALTER TABLE connection_accounts
  ADD CONSTRAINT connection_accounts_id_principal_id_key
  UNIQUE (id, principal_id);

ALTER TABLE connection_authorization_roots
  ADD CONSTRAINT connection_authorization_roots_id_subject_key
  UNIQUE (id, principal_id, consumer_id, instance_id, connection_id);

ALTER TABLE connection_authorization_roots
  ADD CONSTRAINT connection_authorization_roots_instance_consumer_fkey
  FOREIGN KEY (instance_id, consumer_id)
  REFERENCES connection_consumer_instances (id, consumer_id);

ALTER TABLE connection_authorization_roots
  ADD CONSTRAINT connection_authorization_roots_connection_principal_fkey
  FOREIGN KEY (connection_id, principal_id)
  REFERENCES connection_accounts (id, principal_id);

ALTER TABLE connection_authorization_consents
  ADD CONSTRAINT connection_authorization_consents_id_root_id_key
  UNIQUE (id, root_id);

ALTER TABLE connection_grants
  ADD CONSTRAINT connection_grants_id_root_id_key
  UNIQUE (id, root_id);

ALTER TABLE connection_grants
  ADD CONSTRAINT connection_grants_root_subject_fkey
  FOREIGN KEY (root_id, principal_id, consumer_id, instance_id, connection_id)
  REFERENCES connection_authorization_roots
    (id, principal_id, consumer_id, instance_id, connection_id);

ALTER TABLE connection_grants
  ADD CONSTRAINT connection_grants_consent_root_fkey
  FOREIGN KEY (consent_id, root_id)
  REFERENCES connection_authorization_consents (id, root_id);

ALTER TABLE connection_authorization_roots
  ADD CONSTRAINT connection_authorization_roots_current_grant_fkey
  FOREIGN KEY (current_grant_id, id)
  REFERENCES connection_grants (id, root_id)
  DEFERRABLE INITIALLY DEFERRED;
