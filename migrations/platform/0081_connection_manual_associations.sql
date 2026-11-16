CREATE TABLE "platform"."connection_association_generations" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"last_revision" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_association_generation_revision" CHECK ("platform"."connection_association_generations"."last_revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "platform"."connection_manual_associations" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"connection_agent_id" varchar(80) NOT NULL,
	"credential_fingerprint" varchar(64) NOT NULL,
	"association_revision" bigint NOT NULL,
	"owner_id" text NOT NULL,
	"credential_ciphertext" jsonb NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_manual_association_identity" CHECK ("platform"."connection_manual_associations"."connection_agent_id" ~ '^[a-z0-9][a-z0-9-]{2,79}$'
				and "platform"."connection_manual_associations"."credential_fingerprint" ~ '^[a-f0-9]{64}$'
				and "platform"."connection_manual_associations"."association_revision" between 1 and 9007199254740991),
	CONSTRAINT "connection_manual_association_ciphertext" CHECK (jsonb_typeof("platform"."connection_manual_associations"."credential_ciphertext") = 'object'
				and "platform"."connection_manual_associations"."credential_ciphertext" @> jsonb_build_object('schemaVersion', 1,
					'agentId', "platform"."connection_manual_associations"."agent_id", 'ownerId', "platform"."connection_manual_associations"."owner_id",
					'secretVersion', "platform"."connection_manual_associations"."association_revision")
				and "platform"."connection_manual_associations"."credential_ciphertext"->'crypto'->>'dekFingerprint' ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "platform"."connection_association_generations" ADD CONSTRAINT "connection_association_generations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."connection_manual_associations" ADD CONSTRAINT "connection_manual_associations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_manual_association_agent_unique" ON "platform"."connection_manual_associations" USING btree ("connection_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_manual_association_credential_unique" ON "platform"."connection_manual_associations" USING btree ("credential_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_manual_association_dek_unique" ON "platform"."connection_manual_associations" USING btree (("credential_ciphertext"->'crypto'->>'dekFingerprint'));