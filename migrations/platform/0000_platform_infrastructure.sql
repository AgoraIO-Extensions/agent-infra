CREATE SCHEMA "platform";
--> statement-breakpoint
CREATE TYPE "platform"."audit_outcome" AS ENUM('succeeded', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "platform"."idempotency_status" AS ENUM('reserved', 'completed');--> statement-breakpoint
CREATE TYPE "platform"."outbox_status" AS ENUM('pending', 'processing', 'retry_scheduled', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "platform"."audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"actor_type" varchar(64) NOT NULL,
	"actor_id" text NOT NULL,
	"action" varchar(128) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" text NOT NULL,
	"outcome" "platform"."audit_outcome" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_id_non_empty" CHECK (char_length("platform"."audit_events"."id") > 0),
	CONSTRAINT "audit_trace_id_non_empty" CHECK (char_length("platform"."audit_events"."trace_id") > 0),
	CONSTRAINT "audit_actor_id_non_empty" CHECK (char_length("platform"."audit_events"."actor_id") > 0),
	CONSTRAINT "audit_target_id_non_empty" CHECK (char_length("platform"."audit_events"."target_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."idempotency_records" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" varchar(64) NOT NULL,
	"scope_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"command_type" varchar(64) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"status" "platform"."idempotency_status" DEFAULT 'reserved' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_id_non_empty" CHECK (char_length("platform"."idempotency_records"."id") > 0),
	CONSTRAINT "idempotency_scope_id_non_empty" CHECK (char_length("platform"."idempotency_records"."scope_id") > 0),
	CONSTRAINT "idempotency_actor_id_non_empty" CHECK (char_length("platform"."idempotency_records"."actor_id") > 0),
	CONSTRAINT "idempotency_key_format" CHECK ("platform"."idempotency_records"."idempotency_key" ~ '^[A-Za-z0-9._~-]{1,128}$'),
	CONSTRAINT "idempotency_digest_format" CHECK ("platform"."idempotency_records"."request_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "idempotency_result_state" CHECK (("platform"."idempotency_records"."status" = 'reserved' AND "platform"."idempotency_records"."result" IS NULL) OR ("platform"."idempotency_records"."status" = 'completed' AND "platform"."idempotency_records"."result" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "platform"."outbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" varchar(64) NOT NULL,
	"scope_id" text NOT NULL,
	"operation" varchar(128) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "platform"."outbox_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"delivery_fence" bigint DEFAULT 0 NOT NULL,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_id_non_empty" CHECK (char_length("platform"."outbox_items"."id") > 0),
	CONSTRAINT "outbox_scope_id_non_empty" CHECK (char_length("platform"."outbox_items"."scope_id") > 0),
	CONSTRAINT "outbox_trace_id_non_empty" CHECK (char_length("platform"."outbox_items"."trace_id") > 0),
	CONSTRAINT "outbox_attempt_count_non_negative" CHECK ("platform"."outbox_items"."attempt_count" >= 0),
	CONSTRAINT "outbox_delivery_fence_non_negative" CHECK ("platform"."outbox_items"."delivery_fence" >= 0),
	CONSTRAINT "outbox_lease_pair" CHECK (("platform"."outbox_items"."lease_owner" IS NULL) = ("platform"."outbox_items"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "platform"."persisted_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"stream_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"stream_cursor" bigint NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"payload" jsonb NOT NULL,
	"trace_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persisted_event_id_non_empty" CHECK (char_length("platform"."persisted_events"."event_id") > 0),
	CONSTRAINT "persisted_event_stream_id_non_empty" CHECK (char_length("platform"."persisted_events"."stream_id") > 0),
	CONSTRAINT "persisted_event_trace_id_non_empty" CHECK (char_length("platform"."persisted_events"."trace_id") > 0),
	CONSTRAINT "persisted_event_sequence_non_negative" CHECK ("platform"."persisted_events"."sequence" >= 0),
	CONSTRAINT "persisted_event_cursor_non_negative" CHECK ("platform"."persisted_events"."stream_cursor" >= 0)
);
--> statement-breakpoint
CREATE INDEX "audit_trace_idx" ON "platform"."audit_events" USING btree ("trace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_key_unique" ON "platform"."idempotency_records" USING btree ("scope_type","scope_id","actor_id","command_type","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_eligibility_idx" ON "platform"."outbox_items" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "persisted_event_stream_sequence_unique" ON "platform"."persisted_events" USING btree ("stream_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "persisted_event_stream_cursor_unique" ON "platform"."persisted_events" USING btree ("stream_id","stream_cursor");