ALTER TABLE "platform"."api_credential_delivery_grants" ADD COLUMN "pending_scopes" jsonb;--> statement-breakpoint
ALTER TABLE "platform"."api_credential_delivery_grants" ADD COLUMN "pending_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."platform_api_credentials" ADD COLUMN "recipient_user_id" text;--> statement-breakpoint
ALTER TABLE "platform"."api_credential_delivery_grants" ADD CONSTRAINT "api_credential_delivery_pending_scopes_array" CHECK ("platform"."api_credential_delivery_grants"."pending_scopes" is null or (jsonb_typeof("platform"."api_credential_delivery_grants"."pending_scopes") = 'array' and jsonb_array_length("platform"."api_credential_delivery_grants"."pending_scopes") > 0));--> statement-breakpoint
ALTER TABLE "platform"."platform_api_credentials" ADD CONSTRAINT "platform_api_credential_recipient_user_non_empty" CHECK ("platform"."platform_api_credentials"."recipient_user_id" is null or char_length("platform"."platform_api_credentials"."recipient_user_id") > 0);
--> statement-breakpoint
UPDATE "platform"."platform_api_credentials"
SET "revoked_at" = now()
WHERE "principal_type" = 'application'
  AND "recipient_user_id" IS NULL
  AND "revoked_at" IS NULL;
