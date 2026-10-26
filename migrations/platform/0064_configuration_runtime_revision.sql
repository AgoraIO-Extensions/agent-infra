-- Runtime revision (ADR-0028): the most recent configuration revision that
-- changed Runtime inputs. Existing rows keep their own revision, so existing
-- Workloads, Sandbox policies and Executions keep the same readiness facts.
ALTER TABLE "platform"."agent_configuration_revisions" ADD COLUMN "runtime_revision" bigint;--> statement-breakpoint
UPDATE "platform"."agent_configuration_revisions" SET "runtime_revision" = "revision";--> statement-breakpoint
-- A writer that does not set the column (for example an older Platform API
-- during a rolling deployment) is treated as having changed Runtime inputs:
-- it falls back to the previous behavior and never hides a Runtime change.
CREATE FUNCTION "platform"."default_configuration_runtime_revision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."runtime_revision" IS NULL THEN
		NEW."runtime_revision" := NEW."revision";
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "agent_configuration_runtime_revision_default"
BEFORE INSERT ON "platform"."agent_configuration_revisions"
FOR EACH ROW
EXECUTE FUNCTION "platform"."default_configuration_runtime_revision"();--> statement-breakpoint
ALTER TABLE "platform"."agent_configuration_revisions" ALTER COLUMN "runtime_revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."agent_configuration_revisions" ADD CONSTRAINT "agent_configuration_runtime_revision_fk" FOREIGN KEY ("agent_id","runtime_revision") REFERENCES "platform"."agent_configuration_revisions"("agent_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."agent_configuration_revisions" ADD CONSTRAINT "agent_configuration_runtime_revision_range" CHECK ("platform"."agent_configuration_revisions"."runtime_revision" between 1 and "platform"."agent_configuration_revisions"."revision");
