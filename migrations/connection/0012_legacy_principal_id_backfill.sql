UPDATE connection_principals
SET id = gen_random_uuid()::text
WHERE id ~ '^principal-[0-9a-f]{64}$';
