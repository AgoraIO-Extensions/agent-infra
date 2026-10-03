ALTER TABLE "platform"."agent_configuration_revisions" DROP CONSTRAINT "agent_configuration_identity_matches";--> statement-breakpoint
ALTER TABLE "platform"."agent_configuration_revisions" ADD CONSTRAINT "agent_configuration_identity_matches" CHECK ("platform"."agent_configuration_revisions"."configuration" IS NULL OR (
				jsonb_typeof("platform"."agent_configuration_revisions"."configuration") = 'object'
				and "platform"."agent_configuration_revisions"."configuration" ? 'schemaVersion'
                and "platform"."agent_configuration_revisions"."configuration"->'schemaVersion' in ('1'::jsonb, '2'::jsonb)
                and "platform"."agent_configuration_revisions"."configuration" @> jsonb_build_object(
					'agentId', "platform"."agent_configuration_revisions"."agent_id",
					'revision', "platform"."agent_configuration_revisions"."revision"
				)
			));