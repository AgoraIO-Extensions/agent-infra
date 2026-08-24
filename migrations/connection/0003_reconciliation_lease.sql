-- HLD section 20 requires a recovery worker to prove it still owns a lease
-- before it can finalize or reschedule a job.
ALTER TABLE connection_reconciliation_jobs
  ADD COLUMN IF NOT EXISTS lease_id TEXT;
