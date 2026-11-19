-- Run as the PostgreSQL administrator, connected to the Platform database.
-- Stop the Job and commit ALTER ROLE agent_infra_reclamation_ro NOLOGIN first.
BEGIN;
DO $$
DECLARE
  reader constant oid := 'agent_infra_reclamation_ro'::regrole;
  owned record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = reader AND rolcanlogin) THEN
    RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_LOGIN_ENABLED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE usesysid = reader)
    OR EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE owner = 'agent_infra_reclamation_ro') THEN
    RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_SESSION_OR_TRANSACTION_PRESENT';
  END IF;

  SELECT
    (SELECT count(*) FROM pg_largeobject_metadata WHERE lomowner = reader) AS large_objects,
    (SELECT count(*) FROM pg_class WHERE relowner = reader AND relkind IN ('r','p','f')) AS tables,
    (SELECT count(*) FROM pg_class WHERE relowner = reader AND relkind = 'S') AS sequences,
    (SELECT count(*) FROM pg_class WHERE relowner = reader AND relkind IN ('v','m')) AS views,
    (SELECT count(*) FROM pg_proc WHERE proowner = reader) AS routines,
    (SELECT count(*) FROM pg_namespace WHERE nspowner = reader) AS schemas,
    (SELECT count(*) FROM pg_shdepend
       WHERE refclassid = 'pg_authid'::regclass
       AND refobjid = reader AND deptype = 'o') AS cluster_ownership_entries
  INTO owned;

  IF owned.large_objects <> 0 OR owned.tables <> 0 OR owned.sequences <> 0
    OR owned.views <> 0 OR owned.routines <> 0 OR owned.schemas <> 0
    OR owned.cluster_ownership_entries <> 0 THEN
    RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_OWNERSHIP_PRESENT'
      USING DETAIL = row_to_json(owned)::text;
  END IF;
  RAISE NOTICE 'WORKSPACE_READER_CLEANUP_OWNERSHIP_CLEAR %', row_to_json(owned);
END;
$$;
-- Ownership was checked cluster-wide. Remove only the role's grant dependencies.
DROP OWNED BY agent_infra_reclamation_ro RESTRICT;
DROP ROLE agent_infra_reclamation_ro;
COMMIT;
SELECT NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'agent_infra_reclamation_ro'
) AS role_removed;
