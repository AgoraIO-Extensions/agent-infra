-- Historical LDAP authority already created this table. Preserve its fields,
-- disable records and migration history while fresh main gains the same gate.
CREATE TABLE IF NOT EXISTS "platform"."platform_user_disables" (
	"user_id" text PRIMARY KEY NOT NULL,
	"disabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_user_disable_user_non_empty" CHECK (char_length("platform"."platform_user_disables"."user_id") > 0)
);
--> statement-breakpoint
DO $$
DECLARE
	authority regclass := 'platform.platform_user_disables'::regclass;
	user_column smallint;
BEGIN
	SELECT attnum INTO user_column FROM pg_catalog.pg_attribute
	WHERE attrelid = authority AND attname = 'user_id' AND NOT attisdropped
		AND atttypid = 'text'::regtype AND attnotnull;
	IF user_column IS NULL
		OR NOT EXISTS (
			SELECT 1 FROM pg_catalog.pg_class
			WHERE oid = authority AND relkind = 'r' AND relpersistence = 'p'
		)
		OR NOT EXISTS (
			SELECT 1 FROM pg_catalog.pg_attribute
			WHERE attrelid = authority AND attname = 'disabled_at' AND NOT attisdropped
				AND atttypid = 'timestamptz'::regtype AND attnotnull
		)
		OR NOT EXISTS (
			SELECT 1 FROM pg_catalog.pg_constraint
			WHERE conrelid = authority AND contype = 'p'
				AND conkey = ARRAY[user_column]
		)
	THEN
		RAISE EXCEPTION 'Incompatible Platform user disable authority';
	END IF;
	IF EXISTS (SELECT 1 FROM platform.platform_user_disables WHERE char_length(user_id) = 0) THEN
		RAISE EXCEPTION 'Invalid Platform user disable authority records';
	END IF;
END $$;
