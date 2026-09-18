CREATE TABLE IF NOT EXISTS connection_provider_egress_hops (
  hop_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES connection_calls(id) ON DELETE RESTRICT,
  dispatch_id TEXT REFERENCES connection_dispatches(id) ON DELETE RESTRICT,
  effect TEXT NOT NULL CHECK (effect IN ('READ', 'WRITE')),
  jti TEXT NOT NULL UNIQUE,
  assertion_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PREPARED', 'ADMITTED', 'REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (effect = 'READ' AND dispatch_id IS NULL)
    OR (effect = 'WRITE' AND dispatch_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS connection_provider_egress_hops_dispatch
ON connection_provider_egress_hops (dispatch_id)
WHERE dispatch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS connection_egress_admissions (
  hop_id TEXT PRIMARY KEY
    REFERENCES connection_provider_egress_hops(hop_id) ON DELETE RESTRICT,
  jti TEXT NOT NULL UNIQUE,
  assertion_hash TEXT NOT NULL,
  lease_proof_hash TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
