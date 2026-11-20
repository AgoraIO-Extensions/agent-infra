CREATE TABLE "platform"."connection_host_supplies" (
	"agent_id" text NOT NULL,
	"association_revision" bigint NOT NULL,
	"attempt_id" varchar(36) NOT NULL,
	"approval_source_ref" text NOT NULL,
	"approval_source_revision" text NOT NULL,
	"system_fingerprint" varchar(64) NOT NULL,
	"state" text NOT NULL,
	"ref" varchar(128),
	"revision" varchar(128),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_host_supplies_agent_id_association_revision_pk" PRIMARY KEY("agent_id","association_revision"),
	CONSTRAINT "connection_host_supply_state" CHECK (
			"platform"."connection_host_supplies"."state" in ('writing', 'available', 'cleanup_pending', 'cleanup_unknown', 'closed')
			and ("platform"."connection_host_supplies"."state" <> 'available' or ("platform"."connection_host_supplies"."ref" is not null and "platform"."connection_host_supplies"."revision" is not null))
		)
);
--> statement-breakpoint
CREATE TABLE "platform"."connection_manual_installations" (
	"authorization_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"association_revision" bigint NOT NULL,
	"connection_agent_id" varchar(80) NOT NULL,
	"preparation" jsonb NOT NULL,
	"template" jsonb,
	"template_digest" varchar(64),
	"registration_key" text,
	"registration_key_hash" varchar(64),
	"supply_attempt_id" varchar(64),
	"supply_state" text DEFAULT 'pending' NOT NULL,
	"registration_state" text DEFAULT 'pending' NOT NULL,
	"receipt" jsonb,
	"consumer_id" varchar(128),
	"client_id" varchar(128),
	"instance_id" varchar(128),
	"configuration" jsonb,
	"revoke_state" text DEFAULT 'not_required' NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_manual_installation_states" CHECK ("platform"."connection_manual_installations"."supply_state" in ('pending','sending','confirmed','unknown','closed')
				and "platform"."connection_manual_installations"."registration_state" in ('pending','sending','registered','failed','unknown','closed')
				and "platform"."connection_manual_installations"."revoke_state" in ('not_required','pending','sending','revoked','unknown')),
	CONSTRAINT "connection_manual_installation_fixed" CHECK (("platform"."connection_manual_installations"."template" is null and "platform"."connection_manual_installations"."template_digest" is null and "platform"."connection_manual_installations"."registration_key" is null
					and "platform"."connection_manual_installations"."registration_key_hash" is null and "platform"."connection_manual_installations"."supply_attempt_id" is null
					and "platform"."connection_manual_installations"."supply_state" = 'pending' and "platform"."connection_manual_installations"."registration_state" in ('pending','failed','closed'))
				or ("platform"."connection_manual_installations"."template" is not null and "platform"."connection_manual_installations"."template_digest" ~ '^[a-f0-9]{64}$'
					and "platform"."connection_manual_installations"."registration_key" ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$'
					and "platform"."connection_manual_installations"."registration_key_hash" ~ '^[a-f0-9]{64}$' and "platform"."connection_manual_installations"."supply_attempt_id" is not null)),
	CONSTRAINT "connection_manual_installation_receipt" CHECK (("platform"."connection_manual_installations"."registration_state" <> 'registered' or ("platform"."connection_manual_installations"."receipt" is not null and "platform"."connection_manual_installations"."client_id" is not null
					and "platform"."connection_manual_installations"."consumer_id" is not null and "platform"."connection_manual_installations"."instance_id" is not null))
				and ("platform"."connection_manual_installations"."configuration" is null or "platform"."connection_manual_installations"."registration_state" in ('registered','closed'))),
	CONSTRAINT "connection_manual_installation_identity" CHECK (char_length("platform"."connection_manual_installations"."user_id") > 0 and char_length("platform"."connection_manual_installations"."execution_id") > 0
				and "platform"."connection_manual_installations"."connection_agent_id" ~ '^[a-z0-9][a-z0-9-]{2,79}$'
				and "platform"."connection_manual_installations"."association_revision" between 1 and 9007199254740991
				and "platform"."connection_manual_installations"."revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "platform"."connection_installation_authorizations" DROP CONSTRAINT "connection_installation_status_valid";--> statement-breakpoint
ALTER TABLE "platform"."connection_installation_commands" DROP CONSTRAINT "connection_installation_command_valid";--> statement-breakpoint
ALTER TABLE "platform"."connection_installation_commands" ADD COLUMN "delivery_digest" varchar(64);--> statement-breakpoint
ALTER TABLE "platform"."connection_host_supplies" ADD CONSTRAINT "connection_host_supplies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."connection_manual_installations" ADD CONSTRAINT "connection_manual_installations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."connection_manual_installations" ADD CONSTRAINT "connection_manual_installation_authorization_fk" FOREIGN KEY ("authorization_id") REFERENCES "platform"."connection_installation_authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_manual_installation_key_unique" ON "platform"."connection_manual_installations" USING btree ("registration_key");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_manual_installation_key_hash_unique" ON "platform"."connection_manual_installations" USING btree ("registration_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_manual_installation_supply_unique" ON "platform"."connection_manual_installations" USING btree ("supply_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_manual_installation_client_unique" ON "platform"."connection_manual_installations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "connection_manual_installation_agent_idx" ON "platform"."connection_manual_installations" USING btree ("agent_id","association_revision");--> statement-breakpoint
ALTER TABLE "platform"."connection_installation_authorizations" ADD CONSTRAINT "connection_installation_status_valid" CHECK ("platform"."connection_installation_authorizations"."status" in ('awaiting_confirmation','confirmed','revoked','expired','unknown','preparing'));--> statement-breakpoint
ALTER TABLE "platform"."connection_installation_commands" ADD CONSTRAINT "connection_installation_delivery_digest_valid" CHECK ("platform"."connection_installation_commands"."delivery_digest" is null or "platform"."connection_installation_commands"."delivery_digest" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "platform"."connection_installation_commands" ADD CONSTRAINT "connection_installation_command_valid" CHECK ("platform"."connection_installation_commands"."command" in ('begin','confirm','status','prepare','revoke','begin_status'));