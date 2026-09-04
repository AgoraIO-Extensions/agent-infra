CREATE TABLE "platform"."conversation_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"adapter_event_key" text NOT NULL,
	"sequence" bigint NOT NULL,
	"conversation_cursor" bigint NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"event_payload" jsonb NOT NULL,
	"event_digest" varchar(64) NOT NULL,
	"runtime_cursor" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_event_id_non_empty" CHECK (char_length("platform"."conversation_events"."event_id") > 0),
	CONSTRAINT "conversation_event_adapter_key_non_empty" CHECK (char_length("platform"."conversation_events"."adapter_event_key") > 0),
	CONSTRAINT "conversation_event_sequence_safe" CHECK ("platform"."conversation_events"."sequence" between 1 and 9007199254740991),
	CONSTRAINT "conversation_event_cursor_safe" CHECK ("platform"."conversation_events"."conversation_cursor" between 1 and 9007199254740991),
	CONSTRAINT "conversation_event_type_non_empty" CHECK (char_length("platform"."conversation_events"."event_type") > 0),
	CONSTRAINT "conversation_event_digest_format" CHECK ("platform"."conversation_events"."event_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "conversation_event_runtime_cursor_non_empty" CHECK (char_length("platform"."conversation_events"."runtime_cursor") > 0)
);
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "last_event_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "last_runtime_cursor" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" ADD CONSTRAINT "conversation_event_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "platform"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" ADD CONSTRAINT "conversation_event_execution_fk" FOREIGN KEY ("execution_id") REFERENCES "platform"."conversation_executions"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_event_execution_adapter_key_unique" ON "platform"."conversation_events" USING btree ("execution_id","adapter_event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_event_execution_sequence_unique" ON "platform"."conversation_events" USING btree ("execution_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_event_conversation_cursor_unique" ON "platform"."conversation_events" USING btree ("conversation_id","conversation_cursor");--> statement-breakpoint
CREATE INDEX "conversation_event_conversation_cursor_idx" ON "platform"."conversation_events" USING btree ("conversation_id","conversation_cursor");--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_last_event_sequence_safe" CHECK ("platform"."conversation_executions"."last_event_sequence" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_last_runtime_cursor_non_empty" CHECK ("platform"."conversation_executions"."last_runtime_cursor" IS NULL OR char_length("platform"."conversation_executions"."last_runtime_cursor") > 0);