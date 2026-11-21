CREATE TABLE "platform"."connection_manual_install_permits" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"authorization_id" text NOT NULL,
	"confirm_command_id" text NOT NULL,
	"exchange_command_id" text NOT NULL,
	"exchange_request_digest" varchar(64) NOT NULL,
	"pin_receipt_id" text NOT NULL,
	"binding" jsonb NOT NULL,
	"descriptor_digest" varchar(64) NOT NULL,
	"commit_digest" varchar(64) NOT NULL,
	"claim_owner" text NOT NULL,
	"claim_fence" bigint NOT NULL,
	"attempt_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_manual_install_permit_digest" CHECK ("platform"."connection_manual_install_permits"."exchange_request_digest" ~ '^[a-f0-9]{64}$' and "platform"."connection_manual_install_permits"."descriptor_digest" ~ '^[a-f0-9]{64}$'
				and "platform"."connection_manual_install_permits"."commit_digest" ~ '^[a-f0-9]{64}$' and "platform"."connection_manual_install_permits"."revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "platform"."connection_manual_install_permits" ADD CONSTRAINT "connection_manual_install_permit_authorization_fk" FOREIGN KEY ("authorization_id") REFERENCES "platform"."connection_installation_authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."connection_manual_install_permits" ADD CONSTRAINT "connection_manual_install_permit_receipt_fk" FOREIGN KEY ("pin_receipt_id") REFERENCES "platform"."connection_principal_pin_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_manual_install_permit_authorization_unique" ON "platform"."connection_manual_install_permits" USING btree ("authorization_id");