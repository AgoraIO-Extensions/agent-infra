CREATE TABLE "platform"."agent_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"applicant_id" text NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"status" varchar(32) DEFAULT 'pending_approval' NOT NULL,
	"trace_id" text NOT NULL,
	"request_id" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_application_id_non_empty" CHECK (char_length("platform"."agent_applications"."id") > 0),
	CONSTRAINT "agent_application_applicant_non_empty" CHECK (char_length("platform"."agent_applications"."applicant_id") > 0),
	CONSTRAINT "agent_application_name_non_empty" CHECK (char_length("platform"."agent_applications"."name") > 0),
	CONSTRAINT "agent_application_description_non_empty" CHECK (char_length("platform"."agent_applications"."description") > 0),
	CONSTRAINT "agent_application_trace_id_non_empty" CHECK (char_length("platform"."agent_applications"."trace_id") > 0),
	CONSTRAINT "agent_application_request_id_non_empty" CHECK (char_length("platform"."agent_applications"."request_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."agent_configuration_revisions" (
	"agent_id" text NOT NULL,
	"revision" integer NOT NULL,
	"source_reference" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_configuration_revisions_agent_id_revision_pk" PRIMARY KEY("agent_id","revision"),
	CONSTRAINT "agent_configuration_revision_number_positive" CHECK ("platform"."agent_configuration_revisions"."revision" > 0),
	CONSTRAINT "agent_configuration_source_reference_non_empty" CHECK (char_length("platform"."agent_configuration_revisions"."source_reference") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."agent_owners" (
	"agent_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_owners_agent_id_owner_id_pk" PRIMARY KEY("agent_id","owner_id"),
	CONSTRAINT "agent_owner_id_non_empty" CHECK (char_length("platform"."agent_owners"."owner_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."agents" (
	"id" text PRIMARY KEY NOT NULL,
	"current_configuration_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_id_non_empty" CHECK (char_length("platform"."agents"."id") > 0),
	CONSTRAINT "agent_configuration_revision_positive" CHECK ("platform"."agents"."current_configuration_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "platform"."audit_events" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "platform"."audit_events" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "platform"."outbox_items" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "platform"."agent_applications" ADD CONSTRAINT "agent_applications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."agent_configuration_revisions" ADD CONSTRAINT "agent_configuration_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."agent_owners" ADD CONSTRAINT "agent_owners_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_application_agent_unique" ON "platform"."agent_applications" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "platform"."audit_events" ADD CONSTRAINT "audit_request_id_non_empty" CHECK ("platform"."audit_events"."request_id" IS NULL OR char_length("platform"."audit_events"."request_id") > 0);--> statement-breakpoint
ALTER TABLE "platform"."audit_events" ADD CONSTRAINT "audit_agent_id_non_empty" CHECK ("platform"."audit_events"."agent_id" IS NULL OR char_length("platform"."audit_events"."agent_id") > 0);--> statement-breakpoint
ALTER TABLE "platform"."outbox_items" ADD CONSTRAINT "outbox_request_id_non_empty" CHECK ("platform"."outbox_items"."request_id" IS NULL OR char_length("platform"."outbox_items"."request_id") > 0);