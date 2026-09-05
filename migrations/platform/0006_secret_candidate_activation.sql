ALTER TABLE "platform"."secret_records" DROP CONSTRAINT "secret_record_lifecycle_state";--> statement-breakpoint
ALTER TABLE "platform"."secret_records" ADD COLUMN "activation_fence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."secret_records" ADD COLUMN "activation_owner" text;--> statement-breakpoint
ALTER TABLE "platform"."secret_records" ADD COLUMN "activation_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "secret_record_activation_idx" ON "platform"."secret_records" USING btree ("lifecycle_state","activation_lease_expires_at");--> statement-breakpoint
ALTER TABLE "platform"."secret_records" ADD CONSTRAINT "secret_record_activation_fence_safe" CHECK ("platform"."secret_records"."activation_fence" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "platform"."secret_records" ADD CONSTRAINT "secret_record_activation_claim_valid" CHECK ((
				"platform"."secret_records"."activation_owner" is null
				and "platform"."secret_records"."activation_lease_expires_at" is null
			) or (
				char_length("platform"."secret_records"."activation_owner") > 0
				and "platform"."secret_records"."activation_lease_expires_at" is not null
				and "platform"."secret_records"."activation_fence" >= 1
			));--> statement-breakpoint
ALTER TABLE "platform"."secret_records" ADD CONSTRAINT "secret_record_lifecycle_state" CHECK ("platform"."secret_records"."lifecycle_state" in ('pending', 'applying', 'observed', 'active', 'failed'));