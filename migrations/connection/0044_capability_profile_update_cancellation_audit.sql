-- Record automatic cancellation when the runtime no longer requires an upgrade.
ALTER TABLE connection_audit_records DROP CONSTRAINT connection_audit_actor_identity;
ALTER TABLE connection_audit_records ADD CONSTRAINT connection_audit_actor_identity CHECK (
  (actor_kind = 'PRINCIPAL' AND principal_id IS NOT NULL)
  OR (actor_kind = 'SYSTEM' AND principal_id IS NULL AND event IN (
    'connection.capability-profile.published',
    'connection.capability-profile.compatible-upgrade',
    'connection.capability-profile.update-required',
    'connection.capability-profile.update-canceled',
    'connection.access-policy.published'
  ))
);
