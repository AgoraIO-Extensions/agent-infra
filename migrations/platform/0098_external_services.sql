CREATE TABLE "platform"."external_service_versions" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"url" text NOT NULL,
	"credential" jsonb NOT NULL,
	CONSTRAINT "external_service_versions_id_revision_pk" PRIMARY KEY("id","revision")
);
--> statement-breakpoint
CREATE TABLE "platform"."external_services" (
	"id" text PRIMARY KEY NOT NULL,
	"model_endpoint_id" text,
	"enabled_once" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"active" integer,
	"verified" integer,
	CONSTRAINT "external_services_model_endpoint_id_unique" UNIQUE("model_endpoint_id")
);
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "external_service_id" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "external_service_revision" integer;--> statement-breakpoint
ALTER TABLE "platform"."external_service_versions" ADD CONSTRAINT "external_service_versions_id_external_services_id_fk" FOREIGN KEY ("id") REFERENCES "platform"."external_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "execution_external_service_version_fk" FOREIGN KEY ("external_service_id","external_service_revision") REFERENCES "platform"."external_service_versions"("id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Bind at admission, under the same transaction as the Execution and outbox.
-- A retry updates the original Execution and never resolves the active version again.
CREATE FUNCTION platform.bind_external_service_execution() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  service platform.external_services%ROWTYPE;
BEGIN
  NEW.external_service_id := NULL;
  NEW.external_service_revision := NULL;
  SELECT s.* INTO service
    FROM platform.agent_configuration_revisions r
    CROSS JOIN LATERAL jsonb_array_elements(r.configuration->'modelConfiguration'->'options') opt
    JOIN platform.external_services s ON s.model_endpoint_id = opt->>'endpointId'
    WHERE r.agent_id = NEW.agent_id AND r.revision = NEW.model_configuration_revision
      AND opt->>'optionId' = NEW.model_option_id
    FOR SHARE OF s;
  IF FOUND AND service.enabled_once THEN
    IF service.active IS NULL THEN
      RAISE EXCEPTION 'external service disabled' USING ERRCODE = '23514';
    END IF;
    NEW.external_service_id := service.id;
    NEW.external_service_revision := service.active;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bind_external_service_execution BEFORE INSERT ON platform.conversation_executions
FOR EACH ROW WHEN (NEW.relay_key_id IS NOT NULL AND NEW.model_option_id IS NOT NULL)
EXECUTE FUNCTION platform.bind_external_service_execution();
