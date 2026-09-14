CREATE TABLE "platform"."task_authorization_records" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"boundary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "task_authorization_id_non_empty" CHECK (char_length("platform"."task_authorization_records"."id") > 0),
	CONSTRAINT "task_authorization_boundary_version" CHECK ("platform"."task_authorization_records"."boundary"->>'schemaVersion' = '1')
);
--> statement-breakpoint
CREATE TABLE "platform"."task_control_records" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"authorization_record_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_control_id_non_empty" CHECK (char_length("platform"."task_control_records"."id") > 0),
	CONSTRAINT "task_control_reason_valid" CHECK ("platform"."task_control_records"."reason" in ('stop', 'authorization_revoked', 'recovery', 'generation_isolation'))
);
--> statement-breakpoint
ALTER TABLE "platform"."task_authorization_records" ADD CONSTRAINT "task_authorization_execution_fk" FOREIGN KEY ("execution_id") REFERENCES "platform"."conversation_executions"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."task_control_records" ADD CONSTRAINT "task_control_execution_fk" FOREIGN KEY ("execution_id") REFERENCES "platform"."conversation_executions"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."task_control_records" ADD CONSTRAINT "task_control_authorization_fk" FOREIGN KEY ("authorization_record_id") REFERENCES "platform"."task_authorization_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_authorization_execution_unique" ON "platform"."task_authorization_records" USING btree ("execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_control_execution_reason_unique" ON "platform"."task_control_records" USING btree ("execution_id","reason");