CREATE TABLE connection_principal_roles (
  principal_id TEXT NOT NULL CONSTRAINT connection_principal_roles_principal_id_fkey
    REFERENCES connection_principals(id) ON UPDATE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('CONNECTION_ADMIN')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  grant_source TEXT NOT NULL CHECK (grant_source IN ('BOOTSTRAP', 'ADMIN')),
  granted_by_principal_id TEXT
    CONSTRAINT connection_principal_roles_granted_by_fkey
    REFERENCES connection_principals(id) ON UPDATE CASCADE,
  revoked_by_principal_id TEXT
    CONSTRAINT connection_principal_roles_revoked_by_fkey
    REFERENCES connection_principals(id) ON UPDATE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (principal_id, role),
  CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL AND revoked_by_principal_id IS NULL)
    OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX connection_principal_roles_active_role
ON connection_principal_roles (role, principal_id)
WHERE status = 'ACTIVE';
