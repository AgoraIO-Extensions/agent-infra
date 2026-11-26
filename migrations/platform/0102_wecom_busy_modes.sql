CREATE TABLE "platform"."wecom_conversation_busy_modes" (
	"mapping_key" text NOT NULL,
	"rotation" integer NOT NULL,
	"agent_id" text NOT NULL,
	"mode" text DEFAULT 'interrupt' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wecom_conversation_busy_modes_mapping_key_rotation_pk" PRIMARY KEY("mapping_key","rotation"),
	CONSTRAINT "wecom_busy_mode_rotation_safe" CHECK ("platform"."wecom_conversation_busy_modes"."rotation" between 0 and 2147483647),
	CONSTRAINT "wecom_busy_mode_value" CHECK ("platform"."wecom_conversation_busy_modes"."mode" in ('interrupt','steer','queue'))
);
--> statement-breakpoint
ALTER TABLE "platform"."wecom_receipts" DROP CONSTRAINT "wecom_acceptance_status";--> statement-breakpoint
ALTER TABLE "platform"."wecom_receipts" ADD COLUMN "busy_mode" text;--> statement-breakpoint
ALTER TABLE "platform"."wecom_receipts" ADD COLUMN "busy_command" text;--> statement-breakpoint
ALTER TABLE "platform"."wecom_conversation_busy_modes" ADD CONSTRAINT "wecom_conversation_busy_modes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."wecom_receipts" ADD CONSTRAINT "wecom_busy_mode_metadata" CHECK (("platform"."wecom_receipts"."acceptance_status" = 'busy_mode') = ("platform"."wecom_receipts"."busy_mode" is not null and "platform"."wecom_receipts"."busy_command" is not null) and ("platform"."wecom_receipts"."busy_mode" is null or "platform"."wecom_receipts"."busy_mode" in ('interrupt','steer','queue')) and ("platform"."wecom_receipts"."busy_command" is null or "platform"."wecom_receipts"."busy_command" in ('query','set','invalid')));--> statement-breakpoint
ALTER TABLE "platform"."wecom_receipts" ADD CONSTRAINT "wecom_acceptance_status" CHECK ("platform"."wecom_receipts"."acceptance_status" in ('accepted','busy','unavailable','new_conversation','busy_mode','media_rejected'));