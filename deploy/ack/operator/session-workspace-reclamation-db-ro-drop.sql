-- Run as the PostgreSQL administrator, connected to the Platform database.
-- Stop the Job and commit ALTER ROLE agent_infra_reclamation_ro NOLOGIN first.
BEGIN;
DO $$
DECLARE
  reader constant oid := 'agent_infra_reclamation_ro'::regrole;
  target_db constant oid := (SELECT oid FROM pg_database WHERE datname = current_database());
  postgres_db constant oid := (SELECT oid FROM pg_database WHERE datname = 'postgres');
  template_db constant oid := (SELECT oid FROM pg_database WHERE datname = 'template1');
  owned record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = reader AND rolcanlogin) THEN
    RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_LOGIN_ENABLED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE usesysid = reader)
    OR EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE owner = 'agent_infra_reclamation_ro') THEN
    RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_SESSION_OR_TRANSACTION_PRESENT';
  END IF;

  -- DROP OWNED can remove the setup grants only after proving there are no other
  -- dependencies. Check both the addressed object and the actual privilege.
  WITH approved_columns(table_oid, column_name) AS (
    VALUES
      ('platform.conversations'::regclass, 'id'),
      ('platform.conversations'::regclass, 'agent_id'),
      ('platform.conversations'::regclass, 'session_generation'),
      ('platform.conversations'::regclass, 'status'),
      ('platform.session_sandbox_resource_charges'::regclass, 'sandbox_id'),
      ('platform.session_sandbox_resource_charges'::regclass, 'namespace'),
      ('platform.session_sandbox_resource_charges'::regclass, 'released'),
      ('platform.session_sandbox_resource_charges'::regclass, 'compute_released'),
      ('platform.conversation_generation_tombstones'::regclass, 'conversation_id'),
      ('platform.conversation_generation_tombstones'::regclass, 'status'),
      ('platform.conversation_executions'::regclass, 'conversation_id'),
      ('platform.conversation_executions'::regclass, 'status'),
      ('platform.outbox_items'::regclass, 'scope_type'),
      ('platform.outbox_items'::regclass, 'scope_id'),
      ('platform.outbox_items'::regclass, 'status'),
      ('platform.audit_events'::regclass, 'target_id'),
      ('platform.audit_events'::regclass, 'action')
  ), setup_acl(dbid, classid, objid, objsubid, acl, privilege) AS (
    SELECT 0::oid, 'pg_database'::regclass, oid, 0, datacl, 'CONNECT'
    FROM pg_database WHERE oid = target_db
    UNION ALL
    SELECT target_db, 'pg_namespace'::regclass, oid, 0, nspacl, 'USAGE'
    FROM pg_namespace WHERE nspname IN ('platform', 'platform_reclamation_read')
    UNION ALL
    SELECT target_db, 'pg_class'::regclass, oid, 0, relacl, 'SELECT'
    FROM pg_class WHERE oid IN (
      'platform_reclamation_read.allocations'::regclass,
      'platform_reclamation_read.outbox_items'::regclass,
      'platform_reclamation_read.stopped_audit'::regclass
    )
    UNION ALL
    SELECT target_db, 'pg_class'::regclass, attrelid, attnum, attacl, 'SELECT'
    FROM pg_attribute a JOIN approved_columns c
      ON a.attrelid = c.table_oid AND a.attname = c.column_name
    WHERE NOT a.attisdropped
  ), dependencies AS (
    SELECT d.*,
      CASE WHEN d.dbid = 0 AND d.classid = 'pg_database'::regclass
        THEN d.objid ELSE d.dbid END AS object_database,
      d.deptype = 'a' AND EXISTS (
        SELECT 1 FROM setup_acl s
        WHERE (s.dbid, s.classid, s.objid, s.objsubid) = (d.dbid, d.classid, d.objid, d.objsubid)
          AND EXISTS (
            SELECT 1 FROM aclexplode(s.acl) g
            WHERE g.grantee = reader AND g.privilege_type = s.privilege AND NOT g.is_grantable
          )
          AND NOT EXISTS (
            SELECT 1 FROM aclexplode(s.acl) g
            WHERE g.grantor = reader OR
              (g.grantee = reader AND (g.privilege_type <> s.privilege OR g.is_grantable))
          )
      ) AS is_setup_acl
    FROM pg_shdepend d
    WHERE refclassid = 'pg_authid'::regclass AND refobjid = reader
  )
  SELECT
    (SELECT count(*) FROM pg_largeobject_metadata WHERE lomowner = reader) AS large_objects,
    (SELECT count(*) FROM pg_class WHERE relowner = reader AND relkind IN ('r','p','f')) AS tables,
    (SELECT count(*) FROM pg_class WHERE relowner = reader AND relkind = 'S') AS sequences,
    (SELECT count(*) FROM pg_class WHERE relowner = reader AND relkind IN ('v','m')) AS views,
    (SELECT count(*) FROM pg_proc WHERE proowner = reader) AS routines,
    (SELECT count(*) FROM pg_namespace WHERE nspowner = reader) AS schemas,
    count(*) FILTER (WHERE deptype = 'o') AS cluster_ownership_entries,
    count(*) FILTER (WHERE deptype = 'a' AND NOT is_setup_acl) AS unexpected_acl_entries,
    count(*) FILTER (WHERE deptype = 'o' AND object_database = postgres_db) AS postgres_ownership_entries,
    count(*) FILTER (WHERE deptype = 'a' AND object_database = postgres_db) AS postgres_acl_entries,
    count(*) FILTER (WHERE deptype = 'o' AND object_database = template_db) AS template1_ownership_entries,
    count(*) FILTER (WHERE deptype = 'a' AND object_database = template_db) AS template1_acl_entries,
    count(*) FILTER (WHERE deptype NOT IN ('o', 'a')) AS other_dependency_entries
  INTO owned FROM dependencies;

  IF owned.large_objects <> 0 OR owned.tables <> 0 OR owned.sequences <> 0
    OR owned.views <> 0 OR owned.routines <> 0 OR owned.schemas <> 0
    OR owned.cluster_ownership_entries <> 0 THEN
    RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_OWNERSHIP_PRESENT'
      USING DETAIL = row_to_json(owned)::text;
  END IF;
  IF owned.unexpected_acl_entries <> 0 OR owned.other_dependency_entries <> 0 THEN
    RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_UNEXPECTED_DEPENDENCIES'
      USING DETAIL = row_to_json(owned)::text;
  END IF;
END;
$$;
-- Only the setup grants remain. Restore them on any failure in this transaction.
DROP OWNED BY agent_infra_reclamation_ro RESTRICT;
DO $$
DECLARE
  counts record;
BEGIN
  SELECT count(*) FILTER (WHERE deptype = 'o') AS cluster_ownership_entries,
    count(*) FILTER (WHERE deptype = 'a') AS cluster_acl_entries,
    count(*) FILTER (WHERE deptype NOT IN ('o', 'a')) AS other_dependency_entries
  INTO counts FROM pg_shdepend
  WHERE refclassid = 'pg_authid'::regclass AND refobjid = 'agent_infra_reclamation_ro'::regrole;
  IF counts.cluster_ownership_entries <> 0 OR counts.cluster_acl_entries <> 0
    OR counts.other_dependency_entries <> 0 THEN
    RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_DEPENDENCIES_REMAIN'
      USING DETAIL = row_to_json(counts)::text;
  END IF;
  RAISE NOTICE 'WORKSPACE_READER_CLEANUP_DEPENDENCIES_CLEAR %', row_to_json(counts);
END;
$$;
DROP ROLE agent_infra_reclamation_ro;
COMMIT;
SELECT NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'agent_infra_reclamation_ro'
) AS role_removed;
