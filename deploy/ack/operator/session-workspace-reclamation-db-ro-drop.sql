-- Run as the PostgreSQL administrator, connected to the Platform database.
-- Stop the Job and commit ALTER ROLE agent_infra_reclamation_ro NOLOGIN first.
BEGIN ISOLATION LEVEL READ COMMITTED;
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

  IF NOT EXISTS (SELECT 1 FROM platform_reclamation_read.reader_grant_receipt)
    OR EXISTS (SELECT 1 FROM platform_reclamation_read.reader_grant_receipt
      WHERE grantee <> reader OR is_grantable) THEN
    RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_INVALID_RECEIPT';
  END IF;

  WITH dependencies AS (
    SELECT d.*,
      CASE WHEN d.dbid = 0 AND d.classid = 'pg_database'::regclass
        THEN d.objid ELSE d.dbid END AS object_database,
      d.deptype = 'a' AND EXISTS (
        SELECT 1 FROM platform_reclamation_read.reader_grant_receipt s
        WHERE (s.dbid, s.classid, s.objid, s.objsubid) = (d.dbid, d.classid, d.objid, d.objsubid)
      ) AS is_setup_object
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
    count(*) FILTER (WHERE deptype = 'a' AND NOT is_setup_object) AS unexpected_acl_entries,
    count(*) FILTER (WHERE deptype = 'o' AND object_database = postgres_db) AS postgres_ownership_entries,
    count(*) FILTER (WHERE deptype = 'a' AND object_database = postgres_db) AS postgres_acl_entries,
    count(*) FILTER (WHERE deptype = 'o' AND object_database = template_db) AS template1_ownership_entries,
    count(*) FILTER (WHERE deptype = 'a' AND object_database = template_db) AS template1_acl_entries,
    count(*) FILTER (WHERE deptype NOT IN ('o', 'a')) AS other_dependency_entries,
    (SELECT count(*) FROM (
      SELECT * FROM platform_reclamation_read.reader_grant_catalog
      EXCEPT ALL SELECT * FROM platform_reclamation_read.reader_grant_receipt
    ) extra) AS unexpected_acl_rows,
    (SELECT count(*) FROM (
      SELECT * FROM platform_reclamation_read.reader_grant_receipt
      EXCEPT ALL SELECT * FROM platform_reclamation_read.reader_grant_catalog
    ) missing) AS missing_acl_rows
  INTO owned FROM dependencies;

  IF owned.large_objects <> 0 OR owned.tables <> 0 OR owned.sequences <> 0
    OR owned.views <> 0 OR owned.routines <> 0 OR owned.schemas <> 0
    OR owned.cluster_ownership_entries <> 0 THEN
    RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_OWNERSHIP_PRESENT'
      USING DETAIL = row_to_json(owned)::text;
  END IF;
  IF owned.unexpected_acl_entries <> 0 OR owned.other_dependency_entries <> 0
    OR owned.unexpected_acl_rows <> 0 OR owned.missing_acl_rows <> 0 THEN
    RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_UNEXPECTED_DEPENDENCIES'
      USING DETAIL = row_to_json(owned)::text;
  END IF;
END;
$$;
-- Revoke only the recorded privilege under its actual catalog grantor.
DO $$
DECLARE
  entry record;
  target text;
  grantor_name name;
  column_name name;
  operator_name constant name := current_user;
BEGIN
  FOR entry IN SELECT * FROM platform_reclamation_read.reader_grant_receipt LOOP
    SELECT rolname INTO STRICT grantor_name FROM pg_roles WHERE oid = entry.grantor;
    IF entry.classid = 'pg_database'::regclass AND entry.objsubid = 0
      AND entry.dbid = 0 AND entry.privilege_type = 'CONNECT' THEN
      SELECT format('DATABASE %I', datname) INTO STRICT target FROM pg_database
        WHERE oid = entry.objid AND datname = current_database() FOR UPDATE;
    ELSIF entry.classid = 'pg_namespace'::regclass AND entry.objsubid = 0
      AND entry.privilege_type = 'USAGE' THEN
      SELECT format('SCHEMA %I', nspname) INTO STRICT target FROM pg_namespace WHERE oid = entry.objid FOR UPDATE;
    ELSIF entry.classid = 'pg_class'::regclass AND entry.objsubid > 0
      AND entry.privilege_type = 'SELECT' THEN
      SELECT format('TABLE %I.%I', n.nspname, c.relname), a.attname
      INTO STRICT target, column_name
      FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = entry.objsubid
      WHERE c.oid = entry.objid AND NOT a.attisdropped FOR UPDATE OF a;
    ELSE
      RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_INVALID_RECEIPT';
    END IF;
    -- Check the current grant under its catalog row lock before changing it.
    IF NOT EXISTS (SELECT 1 FROM platform_reclamation_read.reader_grant_catalog g
        WHERE (g.dbid, g.classid, g.objid, g.objsubid, g.grantor, g.grantee, g.privilege_type, g.is_grantable)
            = (entry.dbid, entry.classid, entry.objid, entry.objsubid, entry.grantor, entry.grantee,
               entry.privilege_type, entry.is_grantable)) THEN
      RAISE EXCEPTION 'WORKSPACE_READER_CLEANUP_GRANT_CHANGED';
    END IF;
    EXECUTE format('SET LOCAL ROLE %I', grantor_name);
    EXECUTE format('REVOKE %s ON %s FROM agent_infra_reclamation_ro GRANTED BY %I RESTRICT',
      CASE WHEN entry.objsubid > 0 THEN format('SELECT (%I)', column_name) ELSE entry.privilege_type END,
      target, grantor_name);
    EXECUTE format('SET LOCAL ROLE %I', operator_name);
  END LOOP;
END;
$$;
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
DROP VIEW platform_reclamation_read.reader_grant_catalog;
DROP TABLE platform_reclamation_read.reader_grant_receipt;
DROP ROLE agent_infra_reclamation_ro;
COMMIT;
SELECT NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'agent_infra_reclamation_ro'
) AS role_removed;
