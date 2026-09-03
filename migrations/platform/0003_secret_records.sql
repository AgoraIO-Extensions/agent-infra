CREATE TABLE "platform"."secret_records" (
	"agent_id" text NOT NULL,
	"secret_id" text NOT NULL,
	"secret_version" bigint NOT NULL,
	"configuration_revision" bigint NOT NULL,
	"owner_type" varchar(32) NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"lifecycle_state" varchar(32) DEFAULT 'pending' NOT NULL,
	"dek_fingerprint" varchar(64) NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "secret_records_agent_id_secret_id_secret_version_configuration_revision_pk" PRIMARY KEY("agent_id","secret_id","secret_version","configuration_revision"),
	CONSTRAINT "secret_record_agent_id_non_empty" CHECK (char_length("platform"."secret_records"."agent_id") > 0),
	CONSTRAINT "secret_record_id_non_empty" CHECK (char_length("platform"."secret_records"."secret_id") > 0),
	CONSTRAINT "secret_record_owner_id_non_empty" CHECK (char_length("platform"."secret_records"."owner_id") > 0),
	CONSTRAINT "secret_record_name_non_empty" CHECK (char_length("platform"."secret_records"."name") > 0),
	CONSTRAINT "secret_record_version_safe" CHECK ("platform"."secret_records"."secret_version" between 1 and 9007199254740991),
	CONSTRAINT "secret_record_configuration_revision_safe" CHECK ("platform"."secret_records"."configuration_revision" between 1 and 9007199254740991),
	CONSTRAINT "secret_record_owner_type" CHECK ("platform"."secret_records"."owner_type" in ('agent-owner', 'platform')),
	CONSTRAINT "secret_record_lifecycle_state" CHECK ("platform"."secret_records"."lifecycle_state" = 'pending'),
	CONSTRAINT "secret_record_dek_fingerprint_format" CHECK ("platform"."secret_records"."dek_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "secret_record_identity_matches" CHECK (jsonb_typeof("platform"."secret_records"."record") = 'object' and "platform"."secret_records"."record" @> jsonb_build_object(
				'schemaVersion', 1,
				'agentId', "platform"."secret_records"."agent_id",
				'secretId', "platform"."secret_records"."secret_id",
				'secretVersion', "platform"."secret_records"."secret_version",
				'configRevision', "platform"."secret_records"."configuration_revision",
				'ownerType', "platform"."secret_records"."owner_type",
				'ownerId', "platform"."secret_records"."owner_id",
				'name', "platform"."secret_records"."name",
				'lifecycleState', "platform"."secret_records"."lifecycle_state",
				'crypto', jsonb_build_object('dekFingerprint', "platform"."secret_records"."dek_fingerprint")
			))
);
--> statement-breakpoint
ALTER TABLE "platform"."secret_records" ADD CONSTRAINT "secret_record_configuration_revision_fk" FOREIGN KEY ("agent_id","configuration_revision") REFERENCES "platform"."agent_configuration_revisions"("agent_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "secret_record_dek_fingerprint_unique" ON "platform"."secret_records" USING btree ("dek_fingerprint");
--> statement-breakpoint
CREATE UNIQUE INDEX "secret_record_agent_secret_version_unique" ON "platform"."secret_records" USING btree ("agent_id","secret_id","secret_version");