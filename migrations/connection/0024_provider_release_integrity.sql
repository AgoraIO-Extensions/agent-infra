ALTER TABLE connection_provider_releases
  ADD COLUMN executor_digest TEXT NOT NULL DEFAULT 'legacy:unrecorded',
  ADD COLUMN catalog_checksum TEXT NOT NULL DEFAULT 'legacy:unrecorded';

UPDATE connection_provider_releases
SET
  deployment_profile = jsonb_build_object(
    'apiOrigin', 'https://api.github.com',
    'deployment', 'cloud',
    'product', 'GitHub'
  ),
  auth_profile = jsonb_build_object(
    'type', 'oauth2',
    'tokenTransport', 'bearer'
  )
WHERE provider = 'github'
  AND deployment_profile = '{}'::jsonb
  AND auth_profile = '{}'::jsonb;

ALTER TABLE connection_provider_releases
  ADD CONSTRAINT connection_provider_releases_executor_digest_check
    CHECK (
      executor_digest = 'legacy:unrecorded'
      OR executor_digest ~ '^sha256:[a-f0-9]{64}$'
    ),
  ADD CONSTRAINT connection_provider_releases_catalog_checksum_check
    CHECK (
      catalog_checksum = 'legacy:unrecorded'
      OR catalog_checksum ~ '^connection-json-v[0-9]+:[a-f0-9]{64}$'
    );
