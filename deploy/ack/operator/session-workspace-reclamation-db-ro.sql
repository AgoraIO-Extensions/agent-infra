-- Run as the PostgreSQL administrator, connected to the Platform database.
-- Apply once, after the workspace reclamation read migration.
BEGIN;

CREATE ROLE agent_infra_reclamation_ro NOLOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE agent_infra_reclamation_ro SET default_transaction_read_only = on;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO agent_infra_reclamation_ro', current_database());
END;
$$;

GRANT USAGE ON SCHEMA platform, platform_reclamation_read TO agent_infra_reclamation_ro;
GRANT SELECT ON platform_reclamation_read.allocations,
  platform_reclamation_read.outbox_items, platform_reclamation_read.stopped_audit
  TO agent_infra_reclamation_ro;
GRANT SELECT (id, agent_id, session_generation, status) ON platform.conversations
  TO agent_infra_reclamation_ro;
GRANT SELECT (sandbox_id, namespace, released, compute_released)
  ON platform.session_sandbox_resource_charges TO agent_infra_reclamation_ro;
GRANT SELECT (conversation_id, status) ON platform.conversation_generation_tombstones,
  platform.conversation_executions TO agent_infra_reclamation_ro;
GRANT SELECT (scope_type, scope_id, status) ON platform.outbox_items
  TO agent_infra_reclamation_ro;
GRANT SELECT (target_id, action) ON platform.audit_events TO agent_infra_reclamation_ro;

-- Check effective privileges too: PostgreSQL adds any privileges from PUBLIC.
DO $$
DECLARE
  reader constant name := 'agent_infra_reclamation_ro';
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
          OR (n.nspname <> 'platform_reclamation_read' AND has_table_privilege(reader, c.oid, 'SELECT'))
        )
    )
    OR EXISTS (
      SELECT 1
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'platform_reclamation_read')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_column_privilege(reader, c.oid, a.attnum, 'SELECT')
        AND NOT (n.nspname = 'platform' AND (c.relname || '.' || a.attname) IN (
          'conversations.id', 'conversations.agent_id', 'conversations.session_generation', 'conversations.status',
          'session_sandbox_resource_charges.sandbox_id', 'session_sandbox_resource_charges.namespace',
          'session_sandbox_resource_charges.released', 'session_sandbox_resource_charges.compute_released',
          'conversation_generation_tombstones.conversation_id', 'conversation_generation_tombstones.status',
          'conversation_executions.conversation_id', 'conversation_executions.status',
          'outbox_items.scope_type', 'outbox_items.scope_id', 'outbox_items.status',
          'audit_events.target_id', 'audit_events.action'
        ))
    )
    OR EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND p.prosecdef AND has_schema_privilege(reader, n.oid, 'USAGE')
        AND has_function_privilege(reader, p.oid, 'EXECUTE')
    )
  THEN
    RAISE EXCEPTION 'reclamation reader has unexpected effective privileges';
  END IF;
END;
$$;

COMMIT;
