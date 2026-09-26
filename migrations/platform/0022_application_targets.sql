ALTER TYPE "platform"."agent_availability_target_type" ADD VALUE 'application';--> statement-breakpoint
CREATE TABLE "platform"."agent_principal_grants" (
	"agent_id" text NOT NULL,
	"principal_type" varchar(32) NOT NULL,
	"principal_id" text NOT NULL,
	"grant_type" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"authorization_revision" text NOT NULL,
	CONSTRAINT "agent_principal_grants_agent_id_principal_type_principal_id_grant_type_pk" PRIMARY KEY("agent_id","principal_type","principal_id","grant_type"),
	CONSTRAINT "agent_principal_grant_principal_type_valid" CHECK ("platform"."agent_principal_grants"."principal_type" in ('user', 'application')),
	CONSTRAINT "agent_principal_grant_type_valid" CHECK ("platform"."agent_principal_grants"."grant_type" in ('manage', 'use')),
	CONSTRAINT "agent_principal_grant_principal_id_non_empty" CHECK (char_length("platform"."agent_principal_grants"."principal_id") > 0),
	CONSTRAINT "agent_principal_grant_revision_non_empty" CHECK (char_length("platform"."agent_principal_grants"."authorization_revision") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."api_credential_delivery_grants" (
	"application_id" text NOT NULL,
	"principal_type" varchar(32) NOT NULL,
	"principal_id" text NOT NULL,
	"authorization_revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_credential_delivery_grants_application_id_principal_type_principal_id_pk" PRIMARY KEY("application_id","principal_type","principal_id"),
	CONSTRAINT "api_credential_delivery_principal_type_valid" CHECK ("platform"."api_credential_delivery_grants"."principal_type" in ('user', 'application')),
	CONSTRAINT "api_credential_delivery_principal_id_non_empty" CHECK (char_length("platform"."api_credential_delivery_grants"."principal_id") > 0),
	CONSTRAINT "api_credential_delivery_revision_non_empty" CHECK (char_length("platform"."api_credential_delivery_grants"."authorization_revision") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."platform_api_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_type" varchar(32) NOT NULL,
	"principal_id" text NOT NULL,
	"credential_hash" varchar(64) NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "platform_api_credential_id_non_empty" CHECK (char_length("platform"."platform_api_credentials"."id") > 0),
	CONSTRAINT "platform_api_credential_principal_type_valid" CHECK ("platform"."platform_api_credentials"."principal_type" in ('user', 'application')),
	CONSTRAINT "platform_api_credential_principal_id_non_empty" CHECK (char_length("platform"."platform_api_credentials"."principal_id") > 0),
	CONSTRAINT "platform_api_credential_hash_format" CHECK ("platform"."platform_api_credentials"."credential_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_api_credential_scopes_array" CHECK (jsonb_typeof("platform"."platform_api_credentials"."scopes") = 'array')
);
--> statement-breakpoint
CREATE TABLE "platform"."platform_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"responsible_user_id" text NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"authorization_revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_application_id_non_empty" CHECK (char_length("platform"."platform_applications"."id") > 0),
	CONSTRAINT "platform_application_name_non_empty" CHECK (char_length("platform"."platform_applications"."name") > 0),
	CONSTRAINT "platform_application_responsible_non_empty" CHECK (char_length("platform"."platform_applications"."responsible_user_id") > 0),
	CONSTRAINT "platform_application_status_valid" CHECK ("platform"."platform_applications"."status" in ('active', 'disabled')),
	CONSTRAINT "platform_application_revision_non_empty" CHECK (char_length("platform"."platform_applications"."authorization_revision") > 0)
);
--> statement-breakpoint
UPDATE "platform"."agents"
SET "authorization_revision" = 'legacy:' || "platform"."agents"."id"
WHERE "platform"."agents"."authorization_revision" IS NULL;
--> statement-breakpoint
INSERT INTO "platform"."agent_principal_grants" (
	"agent_id",
	"principal_type",
	"principal_id",
	"grant_type",
	"created_at",
	"authorization_revision"
)
SELECT
	owners."agent_id",
	'user',
	owners."owner_id",
	grant_types."grant_type",
	owners."created_at",
	agents."authorization_revision"
FROM "platform"."agent_owners" AS owners
JOIN "platform"."agents" AS agents ON agents."id" = owners."agent_id"
CROSS JOIN (VALUES ('manage'), ('use')) AS grant_types("grant_type");
--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" DROP CONSTRAINT "agent_application_management_state_valid";--> statement-breakpoint
ALTER TABLE "platform"."agent_principal_grants" ADD CONSTRAINT "agent_principal_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."api_credential_delivery_grants" ADD CONSTRAINT "api_credential_delivery_application_fk" FOREIGN KEY ("application_id") REFERENCES "platform"."platform_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_principal_grant_lookup_idx" ON "platform"."agent_principal_grants" USING btree ("principal_type","principal_id","grant_type","revoked_at");--> statement-breakpoint
CREATE INDEX "api_credential_delivery_lookup_idx" ON "platform"."api_credential_delivery_grants" USING btree ("principal_type","principal_id","revoked_at");--> statement-breakpoint
CREATE INDEX "platform_api_credential_principal_idx" ON "platform"."platform_api_credentials" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "platform_api_credential_active_idx" ON "platform"."platform_api_credentials" USING btree ("credential_hash","revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX "platform_application_responsible_idx" ON "platform"."platform_applications" USING btree ("responsible_user_id");--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_application_management_state_valid" CHECK ((
				"platform"."agent_applications"."status" in ('pending_approval', 'withdrawn', 'rejected')
				and "platform"."agent_applications"."approval_revision" is null
				and "platform"."agent_applications"."desired_state" = 'stopped'
				and "platform"."agent_applications"."service_availability" is null
				and "platform"."agent_applications"."workload_revision" = 0
				and "platform"."agent_applications"."fence" = 0
				and "platform"."agent_applications"."failure_code" is null
			) or (
					"platform"."agent_applications"."status" not in ('pending_approval', 'withdrawn', 'rejected')
					and (("platform"."agent_applications"."status" = 'creating' and "platform"."agent_applications"."approval_revision" is null) or "platform"."agent_applications"."approval_revision" is not null)
				and "platform"."agent_applications"."workload_revision" >= 1
				and "platform"."agent_applications"."fence" >= 1
				and (
					("platform"."agent_applications"."status" in ('creating', 'creation_failed') and "platform"."agent_applications"."desired_state" = 'running' and "platform"."agent_applications"."service_availability" is null)
					or ("platform"."agent_applications"."status" = 'available' and "platform"."agent_applications"."desired_state" = 'running' and "platform"."agent_applications"."service_availability" is not null)
					or ("platform"."agent_applications"."status" in ('stopped', 'disabled') and "platform"."agent_applications"."desired_state" = 'stopped' and "platform"."agent_applications"."service_availability" is null)
				)
			));
