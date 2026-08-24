ALTER TABLE connection_grants
  DROP CONSTRAINT connection_grants_status_check;

ALTER TABLE connection_grants
  ADD CONSTRAINT connection_grants_status_check
  CHECK (status IN (
    'ACTIVE',
    'PAUSED_CONNECTION',
    'PAUSED_CREDENTIAL',
    'REPLACED',
    'REVOKED',
    'TERMINATED'
  ));
