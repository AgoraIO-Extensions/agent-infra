CREATE TABLE connection_provider_access_settings (
  provider_id TEXT PRIMARY KEY,
  approval_required BOOLEAN NOT NULL DEFAULT false,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_principal_id TEXT REFERENCES connection_principals(id)
);
--> statement-breakpoint
INSERT INTO connection_provider_access_settings (provider_id)
SELECT DISTINCT provider FROM connection_provider_releases;
--> statement-breakpoint
CREATE FUNCTION connection_provider_requires_approval(target_provider TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE required BOOLEAN;
BEGIN
  -- Shared admission lock serializes all callers with administrator changes.
  PERFORM id FROM connection_access_enforcement WHERE id = 'personal' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Access enforcement authority is unavailable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM connection_provider_releases WHERE provider = target_provider) THEN
    RAISE EXCEPTION 'Provider is unavailable';
  END IF;
  SELECT approval_required INTO required FROM connection_provider_access_settings
    WHERE provider_id = target_provider;
  RETURN COALESCE(required, false);
END;
$$;
