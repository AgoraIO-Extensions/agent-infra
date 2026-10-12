ALTER TABLE "platform"."skill_hub_agent_bindings" ADD COLUMN "applied_receipt" jsonb;--> statement-breakpoint
UPDATE "platform"."skill_hub_agent_bindings"
SET "state" = 'pending_sync',
    "failure_reason" = NULL,
    "updated_at" = now()
WHERE "state" = 'synced';--> statement-breakpoint
ALTER TABLE "platform"."skill_hub_agent_bindings" ADD CONSTRAINT "skill_hub_agent_binding_receipt_binding" CHECK (("platform"."skill_hub_agent_bindings"."state" = 'synced') = ("platform"."skill_hub_agent_bindings"."applied_receipt" is not null));
