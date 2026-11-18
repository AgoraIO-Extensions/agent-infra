CREATE TABLE "platform"."connection_machine_client_bindings" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"association_revision" bigint NOT NULL,
	"client_id" varchar(128) NOT NULL,
	"callback_url" text NOT NULL,
	"profile_fingerprint" varchar(64) NOT NULL,
	"source_ref" text NOT NULL,
	"source_revision" varchar(128) NOT NULL,
	"registration_key_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_machine_client_binding_identity" CHECK ("platform"."connection_machine_client_bindings"."association_revision" between 1 and 9007199254740991
				and "platform"."connection_machine_client_bindings"."client_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
				and "platform"."connection_machine_client_bindings"."profile_fingerprint" ~ '^[a-f0-9]{64}$'
				and "platform"."connection_machine_client_bindings"."source_revision" <> ''
				and ("platform"."connection_machine_client_bindings"."registration_key_hash" is null or "platform"."connection_machine_client_bindings"."registration_key_hash" ~ '^[a-f0-9]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "platform"."connection_machine_client_bindings" ADD CONSTRAINT "connection_machine_client_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_machine_client_binding_client_unique" ON "platform"."connection_machine_client_bindings" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_machine_client_binding_registration_hash_unique" ON "platform"."connection_machine_client_bindings" USING btree ("registration_key_hash");