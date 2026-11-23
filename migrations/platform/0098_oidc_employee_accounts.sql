CREATE TABLE "platform"."oidc_employee_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"employee_id" varchar(256) NOT NULL,
	"email" varchar(320) NOT NULL,
	"issuer" text,
	"subject" varchar(255),
	CONSTRAINT "oidc_complete_binding" CHECK (("platform"."oidc_employee_accounts"."issuer" is null) = ("platform"."oidc_employee_accounts"."subject" is null))
);
--> statement-breakpoint
CREATE TABLE "platform"."oidc_login_transactions" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"nonce" varchar(128) NOT NULL,
	"verifier" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_employee_accounts_employee_id_unique" ON "platform"."oidc_employee_accounts" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_employee_accounts_email_unique" ON "platform"."oidc_employee_accounts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_bound_subject" ON "platform"."oidc_employee_accounts" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "oidc_login_expiry" ON "platform"."oidc_login_transactions" USING btree ("expires_at");