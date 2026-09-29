ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "kind" text DEFAULT 'wecom_bot' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "application" jsonb;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "encrypted_callback" jsonb;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "callback_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "probe_holder_id" text;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "probe_fence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "probe_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "bot_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD CONSTRAINT "wecom_probe_fence_safe" CHECK ("platform"."wecom_setup_sessions"."probe_fence" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD CONSTRAINT "wecom_setup_kind" CHECK ("platform"."wecom_setup_sessions"."kind" in ('wecom_bot','wecom_app'));
