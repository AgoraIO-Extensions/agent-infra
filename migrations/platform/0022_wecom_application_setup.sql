ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "kind" text DEFAULT 'wecom_bot' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "application" jsonb;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "encrypted_callback" jsonb;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD COLUMN "callback_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD CONSTRAINT "wecom_setup_kind" CHECK ("platform"."wecom_setup_sessions"."kind" in ('wecom_bot','wecom_app'));