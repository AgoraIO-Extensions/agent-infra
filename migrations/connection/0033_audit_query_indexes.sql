CREATE INDEX IF NOT EXISTS connection_calls_audit_time
ON connection_calls (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS connection_audit_records_call_time
ON connection_audit_records (call_id, created_at, id);
