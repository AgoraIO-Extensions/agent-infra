CREATE UNIQUE INDEX connection_accounts_external_identity
  ON connection_accounts (principal_id, provider_id, external_account);

CREATE UNIQUE INDEX connection_credential_versions_active
  ON connection_credential_versions (connection_id)
  WHERE status = 'ACTIVE';
