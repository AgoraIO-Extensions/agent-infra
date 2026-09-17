UPDATE connection_action_versions
SET status = 'DISABLED'
WHERE id IN (
	'github.rerequest_check_run@v7',
	'github.rerequest_check_suite@v7'
);

UPDATE connection_provider_releases
SET status = 'DISABLED'
WHERE id = 'github-openconnector-0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674-connection-v7';
