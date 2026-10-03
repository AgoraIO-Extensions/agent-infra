CREATE TYPE "platform"."conversation_execution_status" AS ENUM('submitted', 'processing', 'unknown', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "platform"."conversation_message_status" AS ENUM('submitted');--> statement-breakpoint
CREATE TYPE "platform"."conversation_status" AS ENUM('ready', 'active', 'unavailable');--> statement-breakpoint
CREATE TYPE "platform"."conversation_stop_status" AS ENUM('submitted', 'completed');--> statement-breakpoint
CREATE TABLE "platform"."conversation_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" varchar(128) NOT NULL,
	"trace_id" text NOT NULL,
	"request_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_audit_id_non_empty" CHECK (char_length("platform"."conversation_audit_events"."id") > 0),
	CONSTRAINT "conversation_audit_agent_id_non_empty" CHECK (char_length("platform"."conversation_audit_events"."agent_id") > 0),
	CONSTRAINT "conversation_audit_actor_id_non_empty" CHECK (char_length("platform"."conversation_audit_events"."actor_id") > 0),
	CONSTRAINT "conversation_audit_action_non_empty" CHECK (char_length("platform"."conversation_audit_events"."action") > 0),
	CONSTRAINT "conversation_audit_trace_id_non_empty" CHECK (char_length("platform"."conversation_audit_events"."trace_id") > 0),
	CONSTRAINT "conversation_audit_request_id_non_empty" CHECK (char_length("platform"."conversation_audit_events"."request_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."conversation_executions" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"status" "platform"."conversation_execution_status" NOT NULL,
	"session_generation" bigint NOT NULL,
	"delivery_fence" bigint DEFAULT 0 NOT NULL,
	"authorization_revision" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_execution_id_non_empty" CHECK (char_length("platform"."conversation_executions"."execution_id") > 0),
	CONSTRAINT "conversation_execution_agent_id_non_empty" CHECK (char_length("platform"."conversation_executions"."agent_id") > 0),
	CONSTRAINT "conversation_execution_actor_id_non_empty" CHECK (char_length("platform"."conversation_executions"."actor_id") > 0),
	CONSTRAINT "conversation_execution_channel_id_non_empty" CHECK (char_length("platform"."conversation_executions"."channel_id") > 0),
	CONSTRAINT "conversation_execution_turn_id_non_empty" CHECK (char_length("platform"."conversation_executions"."turn_id") > 0),
	CONSTRAINT "conversation_execution_session_generation_safe" CHECK ("platform"."conversation_executions"."session_generation" between 1 and 9007199254740991),
	CONSTRAINT "conversation_execution_delivery_fence_safe" CHECK ("platform"."conversation_executions"."delivery_fence" between 0 and 9007199254740991),
	CONSTRAINT "conversation_execution_authorization_revision_non_empty" CHECK (char_length("platform"."conversation_executions"."authorization_revision") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."conversation_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"role" varchar(16) NOT NULL,
	"text" text NOT NULL,
	"execution_id" text NOT NULL,
	"status" "platform"."conversation_message_status" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_message_id_non_empty" CHECK (char_length("platform"."conversation_messages"."message_id") > 0),
	CONSTRAINT "conversation_message_actor_id_non_empty" CHECK (char_length("platform"."conversation_messages"."actor_id") > 0),
	CONSTRAINT "conversation_message_role_user" CHECK ("platform"."conversation_messages"."role" = 'user'),
	CONSTRAINT "conversation_message_text_non_empty" CHECK (char_length("platform"."conversation_messages"."text") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."conversation_stops" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"stop_request_id" text NOT NULL,
	"status" "platform"."conversation_stop_status" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_stop_request_id_non_empty" CHECK (char_length("platform"."conversation_stops"."stop_request_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"status" "platform"."conversation_status" NOT NULL,
	"session_generation" bigint NOT NULL,
	"host_session_ref" text,
	"authorization_revision" text NOT NULL,
	"last_conversation_cursor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_id_non_empty" CHECK (char_length("platform"."conversations"."id") > 0),
	CONSTRAINT "conversation_agent_id_non_empty" CHECK (char_length("platform"."conversations"."agent_id") > 0),
	CONSTRAINT "conversation_actor_id_non_empty" CHECK (char_length("platform"."conversations"."actor_id") > 0),
	CONSTRAINT "conversation_channel_id_non_empty" CHECK (char_length("platform"."conversations"."channel_id") > 0),
	CONSTRAINT "conversation_session_generation_safe" CHECK ("platform"."conversations"."session_generation" between 1 and 9007199254740991),
	CONSTRAINT "conversation_host_session_ref_non_empty" CHECK ("platform"."conversations"."host_session_ref" IS NULL OR char_length("platform"."conversations"."host_session_ref") > 0),
	CONSTRAINT "conversation_authorization_revision_non_empty" CHECK (char_length("platform"."conversations"."authorization_revision") > 0),
	CONSTRAINT "conversation_cursor_non_negative" CHECK ("platform"."conversations"."last_conversation_cursor" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "platform"."conversation_audit_events" ADD CONSTRAINT "conversation_audit_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "platform"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."conversation_audit_events" ADD CONSTRAINT "conversation_audit_execution_fk" FOREIGN KEY ("execution_id") REFERENCES "platform"."conversation_executions"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "platform"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."conversation_messages" ADD CONSTRAINT "conversation_message_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "platform"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."conversation_messages" ADD CONSTRAINT "conversation_message_execution_fk" FOREIGN KEY ("execution_id") REFERENCES "platform"."conversation_executions"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."conversation_stops" ADD CONSTRAINT "conversation_stop_execution_fk" FOREIGN KEY ("execution_id") REFERENCES "platform"."conversation_executions"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_audit_trace_idx" ON "platform"."conversation_audit_events" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "conversation_audit_conversation_idx" ON "platform"."conversation_audit_events" USING btree ("conversation_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_active_execution_unique" ON "platform"."conversation_executions" USING btree ("conversation_id") WHERE "platform"."conversation_executions"."status" in ('submitted', 'processing', 'unknown');--> statement-breakpoint
CREATE INDEX "conversation_execution_conversation_idx" ON "platform"."conversation_executions" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_message_conversation_idx" ON "platform"."conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_stop_request_unique" ON "platform"."conversation_stops" USING btree ("stop_request_id");--> statement-breakpoint
CREATE INDEX "conversation_actor_lookup_idx" ON "platform"."conversations" USING btree ("actor_id","agent_id","channel_id");