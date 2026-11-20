ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "verification_state" varchar(16) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "verification_deadline" timestamp with time zone DEFAULT clock_timestamp() NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "verification_actor_id" text;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "verification_reference" text;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "overdue_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "release_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "release_reason" varchar(16);--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "release_actor_id" text;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "release_reference" text;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD COLUMN "rule_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."connection_principal_pins" ADD CONSTRAINT "connection_principal_pin_rules" CHECK ("platform"."connection_principal_pins"."verification_state" in ('pending', 'verified', 'mismatch')
				and ("platform"."connection_principal_pins"."verification_state" = 'verified') = ("platform"."connection_principal_pins"."verified_at" is not null)
				and ("platform"."connection_principal_pins"."verification_state" = 'pending') = ("platform"."connection_principal_pins"."verification_actor_id" is null)
				and ("platform"."connection_principal_pins"."verification_actor_id" is null) = ("platform"."connection_principal_pins"."verification_reference" is null)
				and ("platform"."connection_principal_pins"."release_requested_at" is null) = ("platform"."connection_principal_pins"."release_reason" is null)
				and ("platform"."connection_principal_pins"."release_reason" is null) = ("platform"."connection_principal_pins"."release_actor_id" is null)
				and ("platform"."connection_principal_pins"."release_actor_id" is null) = ("platform"."connection_principal_pins"."release_reference" is null)
				and ("platform"."connection_principal_pins"."release_reason" is null or "platform"."connection_principal_pins"."release_reason" in ('administrator', 'mismatch'))
				and ("platform"."connection_principal_pins"."verification_state" <> 'mismatch' or "platform"."connection_principal_pins"."release_reason" = 'mismatch')
				and ("platform"."connection_principal_pins"."released_at" is null or "platform"."connection_principal_pins"."release_requested_at" is not null)
				and "platform"."connection_principal_pins"."rule_revision" between 1 and 9007199254740991);