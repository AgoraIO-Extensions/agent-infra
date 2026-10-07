CREATE TABLE "platform"."skill_hub_agent_bindings" (
	"agent_id" text NOT NULL,
	"agent_version" varchar(128) NOT NULL,
	"skill_version_id" text NOT NULL,
	"grant" jsonb NOT NULL,
	"sync_revision" bigint DEFAULT 1 NOT NULL,
	"state" varchar(16) NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_hub_agent_binding_pk" PRIMARY KEY("agent_id","agent_version","skill_version_id"),
	CONSTRAINT "skill_hub_agent_binding_version_non_empty" CHECK (char_length("platform"."skill_hub_agent_bindings"."agent_version") > 0),
	CONSTRAINT "skill_hub_agent_binding_sync_revision_safe" CHECK ("platform"."skill_hub_agent_bindings"."sync_revision" between 1 and 9007199254740991),
	CONSTRAINT "skill_hub_agent_binding_state_valid" CHECK ("platform"."skill_hub_agent_bindings"."state" in ('pending_sync', 'synced', 'failed', 'revoked')),
	CONSTRAINT "skill_hub_agent_binding_failure_binding" CHECK (("platform"."skill_hub_agent_bindings"."state" = 'failed') = ("platform"."skill_hub_agent_bindings"."failure_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "platform"."skill_hub_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_type" varchar(16) NOT NULL,
	"principal_id" text NOT NULL,
	"skill_version_id" text NOT NULL,
	"state" varchar(16) NOT NULL,
	"need_upgrade" boolean DEFAULT false NOT NULL,
	"installed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_hub_installation_id_non_empty" CHECK (char_length("platform"."skill_hub_installations"."id") > 0),
	CONSTRAINT "skill_hub_installation_principal_non_empty" CHECK (char_length("platform"."skill_hub_installations"."principal_id") > 0),
	CONSTRAINT "skill_hub_installation_principal_type_valid" CHECK ("platform"."skill_hub_installations"."principal_type" in ('user', 'organization')),
	CONSTRAINT "skill_hub_installation_state_valid" CHECK ("platform"."skill_hub_installations"."state" in ('installed', 'uninstalled', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "platform"."skill_hub_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(63) NOT NULL,
	"owner_id" text NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_hub_skill_id_non_empty" CHECK (char_length("platform"."skill_hub_skills"."id") > 0),
	CONSTRAINT "skill_hub_skill_name_non_empty" CHECK (char_length("platform"."skill_hub_skills"."name") > 0),
	CONSTRAINT "skill_hub_skill_owner_non_empty" CHECK (char_length("platform"."skill_hub_skills"."owner_id") > 0),
	CONSTRAINT "skill_hub_skill_status_valid" CHECK ("platform"."skill_hub_skills"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "platform"."skill_hub_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"version" varchar(128) NOT NULL,
	"provider" varchar(16) NOT NULL,
	"visibility" varchar(16) NOT NULL,
	"state" varchar(16) NOT NULL,
	"package_object_version" text NOT NULL,
	"package_digest" char(64) NOT NULL,
	"manifest_digest" char(64) NOT NULL,
	"signature_digest" char(64) NOT NULL,
	"need_upgrade" boolean DEFAULT false NOT NULL,
	"reviewed_by" text,
	"review_reason" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_hub_version_id_non_empty" CHECK (char_length("platform"."skill_hub_versions"."id") > 0),
	CONSTRAINT "skill_hub_version_owner_non_empty" CHECK (char_length("platform"."skill_hub_versions"."owner_id") > 0),
	CONSTRAINT "skill_hub_version_object_version_non_empty" CHECK (char_length("platform"."skill_hub_versions"."package_object_version") > 0),
	CONSTRAINT "skill_hub_version_provider_valid" CHECK ("platform"."skill_hub_versions"."provider" in ('system', 'my_library', 'market', 'clawhub', 'skillhub', 'npx', 'github')),
	CONSTRAINT "skill_hub_version_visibility_valid" CHECK ("platform"."skill_hub_versions"."visibility" in ('PRIVATE', 'MEMBER', 'ORGANIZATION', 'MARKET')),
	CONSTRAINT "skill_hub_version_state_valid" CHECK ("platform"."skill_hub_versions"."state" in ('published', 'pending_review', 'rejected', 'revoked')),
	CONSTRAINT "skill_hub_version_package_digest_hex" CHECK ("platform"."skill_hub_versions"."package_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_hub_version_manifest_digest_hex" CHECK ("platform"."skill_hub_versions"."manifest_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_hub_version_signature_digest_hex" CHECK ("platform"."skill_hub_versions"."signature_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_hub_version_review_binding" CHECK ("platform"."skill_hub_versions"."state" = 'pending_review' or ("platform"."skill_hub_versions"."state" in ('published', 'rejected') and ("platform"."skill_hub_versions"."visibility" = 'PRIVATE' or "platform"."skill_hub_versions"."reviewed_by" is not null)) or ("platform"."skill_hub_versions"."state" = 'revoked' and "platform"."skill_hub_versions"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_hub_skill_id_owner_unique" ON "platform"."skill_hub_skills" USING btree ("id","owner_id");--> statement-breakpoint
ALTER TABLE "platform"."skill_hub_agent_bindings" ADD CONSTRAINT "skill_hub_agent_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."skill_hub_agent_bindings" ADD CONSTRAINT "skill_hub_agent_binding_skill_version_fk" FOREIGN KEY ("skill_version_id") REFERENCES "platform"."skill_hub_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."skill_hub_installations" ADD CONSTRAINT "skill_hub_installation_skill_version_fk" FOREIGN KEY ("skill_version_id") REFERENCES "platform"."skill_hub_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."skill_hub_versions" ADD CONSTRAINT "skill_hub_versions_skill_id_skill_hub_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "platform"."skill_hub_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."skill_hub_versions" ADD CONSTRAINT "skill_hub_version_skill_owner_fk" FOREIGN KEY ("skill_id","owner_id") REFERENCES "platform"."skill_hub_skills"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_hub_agent_binding_agent_idx" ON "platform"."skill_hub_agent_bindings" USING btree ("agent_id","agent_version");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_hub_installation_principal_version_unique" ON "platform"."skill_hub_installations" USING btree ("principal_type","principal_id","skill_version_id");--> statement-breakpoint
CREATE INDEX "skill_hub_installation_principal_idx" ON "platform"."skill_hub_installations" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_hub_skill_owner_name_unique" ON "platform"."skill_hub_skills" USING btree ("owner_id","name");--> statement-breakpoint
CREATE INDEX "skill_hub_skill_owner_idx" ON "platform"."skill_hub_skills" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_hub_version_skill_version_unique" ON "platform"."skill_hub_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX "skill_hub_version_state_idx" ON "platform"."skill_hub_versions" USING btree ("state");