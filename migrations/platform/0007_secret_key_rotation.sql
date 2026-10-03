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
--> statement-breakpoint
ALTER TABLE "platform"."secret_records" DROP CONSTRAINT "secret_record_identity_matches";--> statement-breakpoint
ALTER TABLE "platform"."secret_records" ADD COLUMN "wrapping_key_version" text;--> statement-breakpoint
UPDATE "platform"."secret_records"
SET "wrapping_key_version" = "record" -> 'crypto' ->> 'wrappingKeyVersion';--> statement-breakpoint
ALTER TABLE "platform"."secret_records" ALTER COLUMN "wrapping_key_version" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "secret_record_wrapping_key_version_idx" ON "platform"."secret_records" USING btree ("wrapping_key_version");--> statement-breakpoint
ALTER TABLE "platform"."secret_records" ADD CONSTRAINT "secret_record_wrapping_key_version_non_empty" CHECK (char_length("platform"."secret_records"."wrapping_key_version") > 0);--> statement-breakpoint
ALTER TABLE "platform"."secret_records" ADD CONSTRAINT "secret_record_identity_matches" CHECK (jsonb_typeof("platform"."secret_records"."record") = 'object' and "platform"."secret_records"."record" @> jsonb_build_object(
				'schemaVersion', 1,
				'agentId', "platform"."secret_records"."agent_id",
				'secretId', "platform"."secret_records"."secret_id",
				'secretVersion', "platform"."secret_records"."secret_version",
				'configRevision', "platform"."secret_records"."configuration_revision",
				'ownerType', "platform"."secret_records"."owner_type",
				'ownerId', "platform"."secret_records"."owner_id",
				'name', "platform"."secret_records"."name",
				'lifecycleState', "platform"."secret_records"."lifecycle_state",
				'crypto', jsonb_build_object(
					'dekFingerprint', "platform"."secret_records"."dek_fingerprint",
					'wrappingKeyVersion', "platform"."secret_records"."wrapping_key_version"
				)
			));
