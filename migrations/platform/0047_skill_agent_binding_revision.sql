ALTER TABLE "platform"."skill_hub_agent_bindings" ADD COLUMN "configuration_revision" bigint;--> statement-breakpoint
UPDATE "platform"."skill_hub_agent_bindings" AS binding
SET "configuration_revision" = agent."current_configuration_revision"
FROM "platform"."agents" AS agent
WHERE agent."id" = binding."agent_id";--> statement-breakpoint
ALTER TABLE "platform"."skill_hub_agent_bindings" ALTER COLUMN "configuration_revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."skill_hub_agent_bindings" ADD CONSTRAINT "skill_hub_agent_binding_configuration_revision_fk" FOREIGN KEY ("agent_id","configuration_revision") REFERENCES "platform"."agent_configuration_revisions"("agent_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."skill_hub_agent_bindings" ADD CONSTRAINT "skill_hub_agent_binding_configuration_revision_safe" CHECK ("platform"."skill_hub_agent_bindings"."configuration_revision" between 1 and 9007199254740991);
