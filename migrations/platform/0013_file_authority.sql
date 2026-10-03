CREATE TABLE "platform"."file_reconciliation" (
	"id" integer PRIMARY KEY NOT NULL,
	"cursor" text
);
--> statement-breakpoint
CREATE TABLE "platform"."file_accesses" (
	"access_id" text PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"file_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"record" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "file_access_record_binding" CHECK ("platform"."file_accesses"."record"->>'accessId' = "platform"."file_accesses"."access_id" AND "platform"."file_accesses"."record"->>'fileId' = "platform"."file_accesses"."file_id" AND "platform"."file_accesses"."record"->>'conversationId' = "platform"."file_accesses"."conversation_id")
);
--> statement-breakpoint
CREATE TABLE "platform"."files" (
	"file_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "file_record_binding" CHECK ("platform"."files"."record"->>'fileId' = "platform"."files"."file_id" AND "platform"."files"."record"->>'conversationId' = "platform"."files"."conversation_id" AND "platform"."files"."record"->>'actorId' = "platform"."files"."actor_id" AND "platform"."files"."record"->>'idempotencyKey' = "platform"."files"."idempotency_key"),
	CONSTRAINT "file_state_valid" CHECK ("platform"."files"."record"->>'status' IN ('pending','available','failed','expired','deleting','deleted'))
);
--> statement-breakpoint
ALTER TABLE "platform"."file_accesses" ADD CONSTRAINT "file_accesses_file_id_files_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "platform"."files"("file_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."file_accesses" ADD CONSTRAINT "file_accesses_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "platform"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."files" ADD CONSTRAINT "files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "platform"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_access_expiry_idx" ON "platform"."file_accesses" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "file_access_idempotency_unique" ON "platform"."file_accesses" USING btree ("file_id","operation","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "file_actor_idempotency_unique" ON "platform"."files" USING btree ("actor_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "file_conversation_idx" ON "platform"."files" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_object_ref_unique" ON "platform"."files" USING btree (("record"->>'objectRef'));--> statement-breakpoint
CREATE INDEX "file_pending_reconciliation_idx" ON "platform"."files" USING btree ("updated_at") WHERE "platform"."files"."record"->>'status' = 'pending';--> statement-breakpoint
CREATE INDEX "file_message_idx" ON "platform"."files" USING btree ("conversation_id",("record"->>'messageId'));