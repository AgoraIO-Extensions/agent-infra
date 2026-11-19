-- Run as the PostgreSQL administrator, connected to the Platform database
-- after the operator Job and its connection have stopped.
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_shdepend
    WHERE refclassid = 'pg_authid'::regclass
      AND refobjid = 'agent_infra_reclamation_ro'::regrole
      AND deptype = 'o'
  ) THEN
    RAISE EXCEPTION 'reclamation reader owns an object; stop before dropping grants';
  END IF;
END;
$$;
DROP OWNED BY agent_infra_reclamation_ro RESTRICT;
DROP ROLE agent_infra_reclamation_ro;
COMMIT;
SELECT NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'agent_infra_reclamation_ro'
) AS role_removed;
