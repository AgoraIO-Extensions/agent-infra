-- Once provider submission may have started, missing terminal evidence cannot
-- be represented as FAILED because a retry could duplicate the external effect.
CREATE OR REPLACE FUNCTION connection_enforce_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'connection_calls' THEN
    IF (OLD.status = 'AUTHORIZED' AND NEW.status IN ('DENIED_LOCAL', 'SUCCEEDED', 'FAILED', 'UNCERTAIN'))
      OR (OLD.status = 'UNCERTAIN' AND NEW.status = 'SUCCEEDED') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'connection_effects' THEN
    IF (OLD.status = 'PREPARED' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'UNCERTAIN'))
      OR (OLD.status = 'UNCERTAIN' AND NEW.status = 'SUCCEEDED') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'connection_dispatches' THEN
    IF (OLD.status = 'PENDING' AND NEW.status IN ('SUBMISSION_STARTED', 'FAILED'))
      OR (OLD.status = 'SUBMISSION_STARTED' AND NEW.status IN ('SUCCEEDED', 'UNCERTAIN'))
      OR (OLD.status = 'UNCERTAIN' AND NEW.status = 'SUCCEEDED') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'connection_reconciliation_jobs' THEN
    IF (OLD.status = 'PENDING' AND NEW.status = 'LEASED')
      OR (OLD.status = 'LEASED' AND NEW.status IN ('PENDING', 'SUCCEEDED')) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'invalid Connection status transition for %: % -> %',
    TG_TABLE_NAME, OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$;
