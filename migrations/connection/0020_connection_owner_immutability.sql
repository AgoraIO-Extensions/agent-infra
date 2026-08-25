CREATE OR REPLACE FUNCTION connection_enforce_account_owner_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.owner_type IS DISTINCT FROM NEW.owner_type
    OR OLD.shared_scope_id IS DISTINCT FROM NEW.shared_scope_id THEN
    RAISE EXCEPTION 'Connection owner is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.owner_principal_id IS DISTINCT FROM NEW.owner_principal_id
    AND (
      OLD.owner_type <> 'PERSONAL'
      OR OLD.owner_principal_id IS NULL
      OR EXISTS (
        SELECT 1 FROM connection_principals
        WHERE id = OLD.owner_principal_id
      )
    ) THEN
    RAISE EXCEPTION 'Connection owner is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER connection_account_owner_immutability
BEFORE UPDATE OF owner_type, owner_principal_id, shared_scope_id
ON connection_accounts
FOR EACH ROW
EXECUTE FUNCTION connection_enforce_account_owner_immutability();
