CREATE TABLE connection_call_diagnostics (
  execution_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES connection_calls(id),
  diagnostic JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX connection_call_diagnostics_call_time
ON connection_call_diagnostics (call_id, created_at DESC, execution_id DESC);
