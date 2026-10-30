CREATE TABLE "platform"."session_sandbox_budgets" (
	"namespace" text PRIMARY KEY NOT NULL,
	"revision" bigint NOT NULL,
	"configuration" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."session_sandbox_reserves" (
	"sandbox_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"namespace" text NOT NULL,
	"profile_digest" text NOT NULL,
	"profile" jsonb NOT NULL,
	"status" varchar(16) NOT NULL,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"delivery_fence" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "session_sandbox_reserve_status_valid" CHECK ("platform"."session_sandbox_reserves"."status" in ('preparing','ready','claimed','retiring','unknown')),
	CONSTRAINT "session_sandbox_reserve_fence_safe" CHECK ("platform"."session_sandbox_reserves"."delivery_fence" between 0 and 9007199254740991),
	CONSTRAINT "session_sandbox_reserve_id_uuid" CHECK ("platform"."session_sandbox_reserves"."sandbox_id" ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
);
--> statement-breakpoint
CREATE TABLE "platform"."session_sandbox_resource_charges" (
	"sandbox_id" text PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"resources" jsonb NOT NULL,
	"compute_released" boolean DEFAULT false NOT NULL,
	"released" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_sandbox_reserve_session_unique" ON "platform"."session_sandbox_reserves" USING btree ("session_id");