CREATE TABLE "platform"."wecom_conversation_rotations" (
	"mapping_key" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"rotation" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wecom_conversation_rotation_positive" CHECK ("platform"."wecom_conversation_rotations"."rotation" between 1 and 2147483647)
);
--> statement-breakpoint
ALTER TABLE "platform"."wecom_receipts" DROP CONSTRAINT "wecom_acceptance_status";--> statement-breakpoint
ALTER TABLE "platform"."wecom_conversation_rotations" ADD CONSTRAINT "wecom_conversation_rotations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."wecom_receipts" ADD CONSTRAINT "wecom_acceptance_status" CHECK ("platform"."wecom_receipts"."acceptance_status" in ('accepted','busy','unavailable','new_conversation'));