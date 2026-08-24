CREATE FUNCTION connection_enforce_grant_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status
    OR (
      OLD.status = 'ACTIVE'
      AND NEW.status IN (
        'PAUSED_CONNECTION',
        'PAUSED_CREDENTIAL',
        'REPLACED',
        'REVOKED',
        'TERMINATED'
      )
    ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid Connection grant status transition: % -> %',
    OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER connection_grants_status_transition
BEFORE UPDATE OF status ON connection_grants
FOR EACH ROW EXECUTE FUNCTION connection_enforce_grant_status_transition();
