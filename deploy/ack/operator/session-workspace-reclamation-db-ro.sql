-- Run as the PostgreSQL administrator, connected to the Platform database.
-- Apply once, after the workspace reclamation read migration.
BEGIN;

-- Cluster-wide check includes inactive and temporary logical slots.
DO $$
DECLARE
  logical_slot_count bigint;
BEGIN
  SELECT count(*) INTO logical_slot_count
  FROM pg_catalog.pg_replication_slots WHERE slot_type = 'logical';
  IF logical_slot_count <> 0 THEN
    RAISE EXCEPTION 'WORKSPACE_READER_LOGICAL_SLOTS_PRESENT'
      USING DETAIL = format('logical_slot_count=%s', logical_slot_count);
  END IF;
END;
$$;

CREATE ROLE agent_infra_reclamation_ro NOLOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE agent_infra_reclamation_ro SET default_transaction_read_only = on;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO agent_infra_reclamation_ro', current_database());
END;
$$;

GRANT USAGE ON SCHEMA platform, platform_reclamation_read TO agent_infra_reclamation_ro;
-- Column grants avoid table-wide REVOKE removing any column privileges
-- other administrators add during the Job.
DO $$
DECLARE
  view_row regclass;
  columns text;
BEGIN
  FOREACH view_row IN ARRAY ARRAY[
    'platform_reclamation_read.allocations'::regclass,
    'platform_reclamation_read.outbox_items'::regclass,
    'platform_reclamation_read.stopped_audit'::regclass
  ] LOOP
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO STRICT columns
    FROM pg_attribute WHERE attrelid = view_row AND attnum > 0 AND NOT attisdropped;
    EXECUTE format('GRANT SELECT (%s) ON TABLE %s TO agent_infra_reclamation_ro', columns, view_row);
  END LOOP;
END;
$$;
GRANT SELECT (id, agent_id, session_generation, status) ON platform.conversations
  TO agent_infra_reclamation_ro;
GRANT SELECT (sandbox_id, namespace, released, compute_released)
  ON platform.session_sandbox_resource_charges TO agent_infra_reclamation_ro;
GRANT SELECT (conversation_id, status) ON platform.conversation_generation_tombstones,
  platform.conversation_executions TO agent_infra_reclamation_ro;
GRANT SELECT (scope_type, scope_id, status) ON platform.outbox_items
  TO agent_infra_reclamation_ro;
GRANT SELECT (target_id, action) ON platform.audit_events TO agent_infra_reclamation_ro;
GRANT SELECT (sandbox_id) ON platform.session_sandbox_reserves TO agent_infra_reclamation_ro;

-- The same transaction that creates the role records the actual ACL entries,
-- including their catalog grantors. No credentials are stored.
CREATE VIEW platform_reclamation_read.reader_grant_catalog AS
SELECT d.dbid, d.classid, d.objid, d.objsubid,
  a.grantor, a.grantee, a.privilege_type, a.is_grantable
FROM pg_shdepend d
CROSS JOIN LATERAL aclexplode(
  CASE
    WHEN d.classid = 'pg_database'::regclass AND d.dbid = 0 THEN
      (SELECT datacl FROM pg_database WHERE oid = d.objid)
    WHEN d.dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) THEN
      CASE
        WHEN d.classid = 'pg_namespace'::regclass THEN
          (SELECT nspacl FROM pg_namespace WHERE oid = d.objid)
        WHEN d.classid = 'pg_class'::regclass AND d.objsubid = 0 THEN
          (SELECT relacl FROM pg_class WHERE oid = d.objid)
        WHEN d.classid = 'pg_class'::regclass THEN
          (SELECT attacl FROM pg_attribute WHERE attrelid = d.objid AND attnum = d.objsubid)
      END
  END
) a
WHERE d.refclassid = 'pg_authid'::regclass
  AND d.refobjid = (SELECT oid FROM pg_roles WHERE rolname = 'agent_infra_reclamation_ro')
  AND d.deptype = 'a'
  AND d.refobjid IN (a.grantee, a.grantor);

CREATE TABLE platform_reclamation_read.reader_grant_receipt AS
SELECT * FROM platform_reclamation_read.reader_grant_catalog;

-- Check effective privileges too: PostgreSQL adds any privileges from PUBLIC.
DO $$
DECLARE
  reader constant name := 'agent_infra_reclamation_ro';
  readable_views constant oid[] := ARRAY[
    'platform_reclamation_read.allocations'::regclass::oid,
    'platform_reclamation_read.outbox_items'::regclass::oid,
    'platform_reclamation_read.stopped_audit'::regclass::oid
  ];
  -- The 2026-11-19 decisions permit only these existing PUBLIC grants.
  public_execute_exceptions constant oid[] := ARRAY[
    'pg_catalog.lo_creat(integer)'::regprocedure::oid,
    'pg_catalog.lo_create(oid)'::regprocedure::oid,
    'pg_catalog.lo_from_bytea(oid,bytea)'::regprocedure::oid,
    'pg_catalog.lo_open(oid,integer)'::regprocedure::oid,
    'pg_catalog.lo_put(oid,bigint,bytea)'::regprocedure::oid,
    'pg_catalog.lo_truncate(integer,integer)'::regprocedure::oid,
    'pg_catalog.lo_truncate64(integer,bigint)'::regprocedure::oid,
    'pg_catalog.lo_unlink(oid)'::regprocedure::oid,
    'pg_catalog.lowrite(integer,bytea)'::regprocedure::oid,
    'pg_catalog.pg_logical_emit_message(boolean,text,text)'::regprocedure::oid,
    'pg_catalog.pg_logical_emit_message(boolean,text,bytea)'::regprocedure::oid
  ];
BEGIN
  IF has_database_privilege(reader, current_database(), 'CREATE,TEMP')
    OR EXISTS (
      SELECT 1 FROM pg_namespace n
      WHERE has_schema_privilege(reader, n.oid, 'CREATE')
    )
    OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (
          has_table_privilege(reader, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
          OR has_any_column_privilege(reader, c.oid, 'INSERT,UPDATE,REFERENCES')
          OR (NOT (c.oid = ANY(readable_views)) AND has_table_privilege(reader, c.oid, 'SELECT'))
        )
    )
    OR EXISTS (
      SELECT 1
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND NOT (c.oid = ANY(readable_views))
        AND has_column_privilege(reader, c.oid, a.attnum, 'SELECT')
        AND NOT (n.nspname = 'platform' AND (c.relname || '.' || a.attname) IN (
          'conversations.id', 'conversations.agent_id', 'conversations.session_generation', 'conversations.status',
          'session_sandbox_resource_charges.sandbox_id', 'session_sandbox_resource_charges.namespace',
          'session_sandbox_resource_charges.released', 'session_sandbox_resource_charges.compute_released',
          'conversation_generation_tombstones.conversation_id', 'conversation_generation_tombstones.status',
          'conversation_executions.conversation_id', 'conversation_executions.status',
          'outbox_items.scope_type', 'outbox_items.scope_id', 'outbox_items.status',
          'audit_events.target_id', 'audit_events.action',
          'session_sandbox_reserves.sandbox_id'
        ))
    )
    OR EXISTS (
      SELECT 1 FROM pg_sequence s
      WHERE has_sequence_privilege(reader, s.seqrelid, 'USAGE,UPDATE')
    )
    OR EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE (
        (n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosecdef)
        OR (n.nspname = 'pg_catalog' AND p.proname IN (
          'lo_creat', 'lo_create', 'lo_from_bytea', 'lo_import', 'lo_export',
          'lo_open', 'lo_put', 'lowrite', 'lo_truncate', 'lo_truncate64', 'lo_unlink',
          'pg_logical_emit_message'
        ))
      )
        AND has_schema_privilege(reader, n.oid, 'USAGE')
        AND has_function_privilege(reader, p.oid, 'EXECUTE')
        AND NOT (
          p.oid = ANY(public_execute_exceptions)
          AND EXISTS (
            SELECT 1
            FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
            WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
          )
        )
    )
  THEN
    RAISE EXCEPTION 'reclamation reader has unexpected effective privileges';
  END IF;
END;
$$;

COMMIT;
