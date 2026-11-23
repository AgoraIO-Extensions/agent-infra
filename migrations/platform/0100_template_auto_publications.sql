CREATE TABLE "platform"."template_publication_catalog" (
	"template_id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"revision" bigint NOT NULL,
	CONSTRAINT "template_publication_catalog_revision" CHECK ("platform"."template_publication_catalog"."revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "platform"."template_publication_nonces" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."template_publication_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"batch_ref" text NOT NULL,
	"agent_id" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"target" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"configuration_revision" bigint,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_publication_target_attempt" UNIQUE("publication_id","agent_id","attempt"),
	CONSTRAINT "template_publication_target_state" CHECK ("platform"."template_publication_targets"."status" in ('pending','unknown','applied','rejected')),
	CONSTRAINT "template_publication_target_attempt_positive" CHECK ("platform"."template_publication_targets"."attempt" between 1 and 2147483647)
);
--> statement-breakpoint
CREATE TABLE "platform"."template_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"binding" jsonb NOT NULL,
	"request_digest" text NOT NULL,
	"approved_by" text NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"worker_ready" boolean DEFAULT false NOT NULL,
	"cursor" text,
	"discovery_complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_publication_state" CHECK ("platform"."template_publications"."status" in ('prepared','active','partial','blocked','completed','revoked','superseded')),
	CONSTRAINT "template_publication_digest" CHECK ("platform"."template_publications"."request_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "template_publication_binding" CHECK (("platform"."template_publications"."binding"->>'schemaVersion' = '1') is true)
);
--> statement-breakpoint
ALTER TABLE "platform"."template_publication_catalog" ADD CONSTRAINT "template_publication_catalog_publication_id_template_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "platform"."template_publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."template_publication_nonces" ADD CONSTRAINT "template_publication_nonces_publication_id_template_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "platform"."template_publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."template_publication_targets" ADD CONSTRAINT "template_publication_targets_publication_id_template_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "platform"."template_publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."template_publication_targets" ADD CONSTRAINT "template_publication_targets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "template_publication_nonce_expiry" ON "platform"."template_publication_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "template_publication_target_pending" ON "platform"."template_publication_targets" USING btree ("publication_id","status","id");--> statement-breakpoint
CREATE INDEX "template_publication_template" ON "platform"."template_publications" USING btree ("template_id");