ALTER TABLE "platform"."skill_hub_agent_bindings" DROP CONSTRAINT "skill_hub_agent_binding_pk";
--> statement-breakpoint
ALTER TABLE "platform"."skill_hub_agent_bindings" ADD CONSTRAINT "skill_hub_agent_binding_pk" PRIMARY KEY("agent_id","agent_version","configuration_revision","skill_version_id");