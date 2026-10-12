-- Automatic catalog maintenance records a system actor, never an administrator identity.
ALTER TABLE connection_audit_records ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'PRINCIPAL';
ALTER TABLE connection_audit_records ALTER COLUMN principal_id DROP NOT NULL;
ALTER TABLE connection_audit_records ADD CONSTRAINT connection_audit_actor_identity CHECK (
  (actor_kind = 'PRINCIPAL' AND principal_id IS NOT NULL)
  OR (actor_kind = 'SYSTEM' AND principal_id IS NULL AND event IN (
    'connection.capability-profile.published',
    'connection.capability-profile.compatible-upgrade',
    'connection.capability-profile.update-required',
    'connection.access-policy.published'
  ))
);
