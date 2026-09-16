CREATE TABLE "platform"."wecom_connections" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"binding_reference" text NOT NULL,
	"holder_id" text NOT NULL,
	"fence" bigint NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "wecom_connection_fence_safe" CHECK ("platform"."wecom_connections"."fence" between 1 and 9007199254740991),
	CONSTRAINT "wecom_connection_status" CHECK ("platform"."wecom_connections"."status" in ('verifying','connected','disconnected','auth_failed'))
);
--> statement-breakpoint
CREATE TABLE "platform"."wecom_setup_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"configuration_revision" bigint NOT NULL,
	"authorization_revision" text NOT NULL,
	"state_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"bot_id" text,
	"encrypted_credential" jsonb,
	CONSTRAINT "wecom_setup_status" CHECK ("platform"."wecom_setup_sessions"."status" in ('awaiting_input','verifying','active','auth_failed','conflict','cancelled','expired'))
);
--> statement-breakpoint
ALTER TABLE "platform"."wecom_receipts" ADD COLUMN "connection_bot_id" text;--> statement-breakpoint
ALTER TABLE "platform"."wecom_receipts" ADD COLUMN "connection_fence" bigint;--> statement-breakpoint
ALTER TABLE "platform"."wecom_connections" ADD CONSTRAINT "wecom_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."wecom_setup_sessions" ADD CONSTRAINT "wecom_setup_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wecom_setup_pending" ON "platform"."wecom_setup_sessions" USING btree ("status","expires_at");