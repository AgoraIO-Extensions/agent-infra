CREATE TABLE "platform"."oidc_logout_receipts" (
	"digest" varchar(64) PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "oidc_logout_receipts_expiry" ON "platform"."oidc_logout_receipts" USING btree ("expires_at");