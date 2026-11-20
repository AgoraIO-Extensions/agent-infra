CREATE TABLE "platform"."connection_principal_pin_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"authorization_id" text NOT NULL,
	"confirm_command_id" text NOT NULL,
	"phase_command_id" text NOT NULL,
	"pin_id" text NOT NULL,
	"pin_revision" bigint NOT NULL,
	"candidate" jsonb NOT NULL,
	"candidate_digest" varchar(64) NOT NULL,
	"claim_owner" text NOT NULL,
	"claim_fence" bigint NOT NULL,
	"attempt_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_principal_pin_receipt_digest" CHECK ("platform"."connection_principal_pin_receipts"."candidate_digest" ~ '^[a-f0-9]{64}$' and "platform"."connection_principal_pin_receipts"."revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "platform"."connection_principal_pins" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"principal_id" varchar(128) NOT NULL,
	"user_id" text NOT NULL,
	"policy_ref" text NOT NULL,
	"policy_revision" text NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "connection_principal_pin_identity" CHECK (char_length("platform"."connection_principal_pins"."issuer") > 0 and "platform"."connection_principal_pins"."principal_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
				and char_length("platform"."connection_principal_pins"."user_id") > 0 and "platform"."connection_principal_pins"."revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "platform"."connection_installation_commands" DROP CONSTRAINT "connection_installation_command_valid";--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pin_receipts" ADD CONSTRAINT "connection_principal_pin_receipt_authorization_fk" FOREIGN KEY ("authorization_id") REFERENCES "platform"."connection_installation_authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pin_receipts" ADD CONSTRAINT "connection_principal_pin_receipt_pin_fk" FOREIGN KEY ("pin_id") REFERENCES "platform"."connection_principal_pins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_principal_pin_receipt_confirm_unique" ON "platform"."connection_principal_pin_receipts" USING btree ("confirm_command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_principal_pin_principal_unique" ON "platform"."connection_principal_pins" USING btree ("issuer","principal_id") WHERE "platform"."connection_principal_pins"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_principal_pin_user_unique" ON "platform"."connection_principal_pins" USING btree ("issuer","user_id") WHERE "platform"."connection_principal_pins"."released_at" is null;--> statement-breakpoint
ALTER TABLE "platform"."connection_installation_commands" ADD CONSTRAINT "connection_installation_command_valid" CHECK ("platform"."connection_installation_commands"."command" in ('begin','confirm','status','prepare','revoke','begin_status','confirm_binding_readback','confirm_exchange'));