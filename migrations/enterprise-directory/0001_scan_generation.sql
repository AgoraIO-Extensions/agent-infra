CREATE SEQUENCE enterprise_directory.scan_generation AS bigint;

--> statement-breakpoint
ALTER TABLE enterprise_directory.snapshots
	ADD COLUMN generation bigint;

--> statement-breakpoint
CREATE UNIQUE INDEX snapshots_generation
	ON enterprise_directory.snapshots (generation)
	WHERE generation IS NOT NULL;

--> statement-breakpoint
CREATE INDEX snapshots_latest_generation
	ON enterprise_directory.snapshots
	(generation DESC NULLS LAST, fetched_at DESC, revision DESC);
