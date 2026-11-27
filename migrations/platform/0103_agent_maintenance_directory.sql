CREATE TABLE "platform"."agent_maintenance_ssh_grants" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"token_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_maintenance_ssh_grants_token_digest_unique" UNIQUE("token_digest")
);
--> statement-breakpoint
ALTER TABLE "platform"."agents" ADD COLUMN "maintenance_activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."agents" ADD COLUMN "maintenance_directory_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."session_sandbox_allocations" ADD COLUMN "maintenance_directory_id" uuid;--> statement-breakpoint
ALTER TABLE "platform"."session_sandbox_allocations" ADD COLUMN "maintenance_bound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."session_sandbox_allocations" ADD COLUMN "maintenance_view_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "platform"."agent_maintenance_ssh_grants" ADD CONSTRAINT "agent_maintenance_ssh_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."agents" ADD CONSTRAINT "agents_maintenance_directory_id_unique" UNIQUE("maintenance_directory_id");