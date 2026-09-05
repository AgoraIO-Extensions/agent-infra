CREATE TYPE "platform"."secret_key_rotation_state" AS ENUM('pending', 'rewrapping', 'verifying', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "platform"."retired_secret_wrapping_keys" (
	"key_version" text PRIMARY KEY NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retired_secret_wrapping_key_non_empty" CHECK (char_length("platform"."retired_secret_wrapping_keys"."key_version") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."secret_key_rotations" (
	"rotation_id" text PRIMARY KEY NOT NULL,
	"source_key_versions" text[] NOT NULL,
	"target_key_version" text NOT NULL,
	"state" "platform"."secret_key_rotation_state" DEFAULT 'pending' NOT NULL,
	"processed_secrets" bigint DEFAULT 0 NOT NULL,
	"remaining_secrets" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_key_rotation_id_non_empty" CHECK (char_length("platform"."secret_key_rotations"."rotation_id") > 0),
	CONSTRAINT "secret_key_rotation_sources_non_empty" CHECK (cardinality("platform"."secret_key_rotations"."source_key_versions") > 0),
	CONSTRAINT "secret_key_rotation_target_non_empty" CHECK (char_length("platform"."secret_key_rotations"."target_key_version") > 0),
	CONSTRAINT "secret_key_rotation_counts_safe" CHECK ("platform"."secret_key_rotations"."processed_secrets" between 0 and 9007199254740991 and "platform"."secret_key_rotations"."remaining_secrets" between 0 and 9007199254740991),
	CONSTRAINT "secret_key_rotation_completed_empty" CHECK ("platform"."secret_key_rotations"."state" <> 'completed' or "platform"."secret_key_rotations"."remaining_secrets" = 0)
);
