CREATE TABLE "platform"."conversation_generation_tombstones" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"session_generation" bigint NOT NULL,
	"execution_id" text NOT NULL,
	"item_id" text NOT NULL,
	"control_record_id" text NOT NULL,
	"control_source_id" text NOT NULL,
	"original_principal" jsonb NOT NULL,
	"host_session_ref" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "conversation_generation_tombstone_generation_safe" CHECK ("platform"."conversation_generation_tombstones"."session_generation" between 1 and 9007199254740990),
	CONSTRAINT "conversation_generation_tombstone_status_valid" CHECK (("platform"."conversation_generation_tombstones"."status" = 'pending' and "platform"."conversation_generation_tombstones"."confirmed_at" is null) or ("platform"."conversation_generation_tombstones"."status" = 'confirmed' and "platform"."conversation_generation_tombstones"."confirmed_at" is not null)),
	CONSTRAINT "conversation_generation_tombstone_reason_valid" CHECK ("platform"."conversation_generation_tombstones"."failure_code" = 'RUNTIME_SESSION_RECOVERY_FAILED'),
	CONSTRAINT "conversation_generation_tombstone_principal_valid" CHECK ("platform"."conversation_generation_tombstones"."original_principal"->>'kind' = 'user' and char_length("platform"."conversation_generation_tombstones"."original_principal"->>'id') > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_generation_tombstone_unique" ON "platform"."conversation_generation_tombstones" USING btree ("conversation_id","session_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_generation_control_unique" ON "platform"."conversation_generation_tombstones" USING btree ("control_record_id");--> statement-breakpoint
CREATE INDEX "conversation_generation_pending_idx" ON "platform"."conversation_generation_tombstones" USING btree ("status","item_id");