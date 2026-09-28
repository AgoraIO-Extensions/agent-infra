ALTER TABLE connection_oauth_transactions
ADD COLUMN IF NOT EXISTS provider_id TEXT;

ALTER TABLE connection_oauth_transactions
ALTER COLUMN provider_id SET DEFAULT 'github';

UPDATE connection_oauth_transactions
SET provider_id = 'github'
WHERE provider_id IS NULL;

ALTER TABLE connection_oauth_transactions
ALTER COLUMN provider_id SET NOT NULL;
