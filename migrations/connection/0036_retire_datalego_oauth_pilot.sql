-- Retain immutable catalogs and user history; retire the duplicate Provider.
UPDATE connection_provider_releases
SET status = 'DISABLED'
WHERE provider = 'datalego-oauth-pilot';
