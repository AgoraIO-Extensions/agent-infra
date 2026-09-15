ALTER TABLE connection_accounts
	ADD COLUMN profile_label_source text;

ALTER TABLE connection_accounts
	ADD CONSTRAINT connection_accounts_profile_label_source_check
	CHECK (profile_label_source IS NULL OR profile_label_source = 'github.login');
