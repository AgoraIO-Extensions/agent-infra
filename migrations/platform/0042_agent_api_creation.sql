ALTER TABLE "platform"."agent_applications" DROP CONSTRAINT "agent_application_management_state_valid";--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD COLUMN "creation_channel" varchar(32) DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD COLUMN "creator_principal_type" varchar(32);--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD COLUMN "creator_principal_id" text;--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_application_creation_provenance" CHECK ((
 "platform"."agent_applications"."creation_channel" = 'web' and "platform"."agent_applications"."creator_principal_type" is null and "platform"."agent_applications"."creator_principal_id" is null
 ) or (
 "platform"."agent_applications"."creation_channel" = 'api' and "platform"."agent_applications"."creator_principal_type" is not null and "platform"."agent_applications"."creator_principal_id" is not null and "platform"."agent_applications"."creator_principal_type" in ('user','application') and char_length("platform"."agent_applications"."creator_principal_id") > 0
 and "platform"."agent_applications"."approval_revision" is null and "platform"."agent_applications"."status" not in ('pending_approval','rejected','withdrawn')
 ));--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_application_management_state_valid" CHECK ((
				"platform"."agent_applications"."status" in ('pending_approval', 'withdrawn', 'rejected')
				and "platform"."agent_applications"."approval_revision" is null
				and "platform"."agent_applications"."desired_state" = 'stopped'
				and "platform"."agent_applications"."service_availability" is null
				and "platform"."agent_applications"."workload_revision" = 0
				and "platform"."agent_applications"."fence" = 0
				and "platform"."agent_applications"."failure_code" is null
			) or (
					"platform"."agent_applications"."status" not in ('pending_approval', 'withdrawn', 'rejected')
					and (("platform"."agent_applications"."status" = 'creating' and "platform"."agent_applications"."approval_revision" is null) or "platform"."agent_applications"."approval_revision" is not null or "platform"."agent_applications"."creation_channel" = 'api')
				and "platform"."agent_applications"."workload_revision" >= 1
				and "platform"."agent_applications"."fence" >= 1
				and (
					("platform"."agent_applications"."status" in ('creating', 'creation_failed') and "platform"."agent_applications"."desired_state" = 'running' and "platform"."agent_applications"."service_availability" is null)
					or ("platform"."agent_applications"."status" = 'available' and "platform"."agent_applications"."desired_state" = 'running' and "platform"."agent_applications"."service_availability" is not null)
					or ("platform"."agent_applications"."status" in ('stopped', 'disabled') and "platform"."agent_applications"."desired_state" = 'stopped' and "platform"."agent_applications"."service_availability" is null)
				)
			));