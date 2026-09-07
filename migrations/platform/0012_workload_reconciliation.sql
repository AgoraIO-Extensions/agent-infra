CREATE TABLE "platform"."workload_reconciliations" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"revision" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workload_reconciliation_revision_safe" CHECK ("platform"."workload_reconciliations"."revision" between 1 and 9007199254740991),
	CONSTRAINT "workload_reconciliation_identity" CHECK (jsonb_typeof("platform"."workload_reconciliations"."state") = 'object' and "platform"."workload_reconciliations"."state" @> jsonb_build_object('schemaVersion', 1, 'agentId', "platform"."workload_reconciliations"."agent_id", 'revision', "platform"."workload_reconciliations"."revision"))
);
--> statement-breakpoint
ALTER TABLE "platform"."workload_reconciliations" ADD CONSTRAINT "workload_reconciliations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workload_reconciliation_due_idx" ON "platform"."workload_reconciliations" USING btree ("next_attempt_at");