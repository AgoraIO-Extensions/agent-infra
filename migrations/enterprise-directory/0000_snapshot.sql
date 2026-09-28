CREATE SCHEMA IF NOT EXISTS enterprise_directory;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS enterprise_directory.snapshots (
	revision uuid PRIMARY KEY,
	fetched_at timestamptz NOT NULL,
	valid_until timestamptz NOT NULL,
	contents jsonb NOT NULL,
	CONSTRAINT snapshot_age CHECK (
		valid_until > fetched_at
		AND valid_until <= fetched_at + interval '1 day'
	)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS snapshots_latest
	ON enterprise_directory.snapshots (fetched_at DESC, revision DESC);
