CREATE TABLE "platform"."workspace_snapshot_bindings" (
	"snapshot_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"configuration_revision" bigint NOT NULL,
	"name" varchar(63) NOT NULL,
	"digest" varchar(71) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_snapshot_bindings_snapshot_id_agent_id_configuration_revision_pk" PRIMARY KEY("snapshot_id","agent_id","configuration_revision"),
	CONSTRAINT "workspace_snapshot_binding_digest_format" CHECK ("platform"."workspace_snapshot_bindings"."digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "workspace_snapshot_binding_name" CHECK ("platform"."workspace_snapshot_bindings"."name" ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "platform"."workspace_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" varchar(32) NOT NULL,
	"owner_id" text NOT NULL,
	"digest" varchar(71) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"unpacked_size_bytes" bigint NOT NULL,
	"file_count" bigint NOT NULL,
	"media_type" varchar(64) NOT NULL,
	"source" jsonb NOT NULL,
	"object_ref" text NOT NULL,
	"object_version" text NOT NULL,
	"status" varchar(16) DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_snapshot_owner_type" CHECK ("platform"."workspace_snapshots"."owner_type" in ('user','application')),
	CONSTRAINT "workspace_snapshot_digest_format" CHECK ("platform"."workspace_snapshots"."digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "workspace_snapshot_sizes_positive" CHECK ("platform"."workspace_snapshots"."size_bytes" > 0 and "platform"."workspace_snapshots"."unpacked_size_bytes" > 0 and "platform"."workspace_snapshots"."file_count" > 0),
	CONSTRAINT "workspace_snapshot_status" CHECK ("platform"."workspace_snapshots"."status" in ('ready','deleting','deleted'))
);
--> statement-breakpoint
ALTER TABLE "platform"."workspace_snapshot_bindings" ADD CONSTRAINT "workspace_snapshot_bindings_snapshot_id_workspace_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "platform"."workspace_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."workspace_snapshot_bindings" ADD CONSTRAINT "workspace_snapshot_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."workspace_snapshot_bindings" ADD CONSTRAINT "workspace_snapshot_binding_revision_fk" FOREIGN KEY ("agent_id","configuration_revision") REFERENCES "platform"."agent_configuration_revisions"("agent_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_snapshot_agent_name_revision_unique" ON "platform"."workspace_snapshot_bindings" USING btree ("agent_id","configuration_revision","name");--> statement-breakpoint
CREATE INDEX "workspace_snapshot_binding_agent_idx" ON "platform"."workspace_snapshot_bindings" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_snapshot_owner_id_unique" ON "platform"."workspace_snapshots" USING btree ("owner_type","owner_id","id");--> statement-breakpoint
CREATE INDEX "workspace_snapshot_owner_idx" ON "platform"."workspace_snapshots" USING btree ("owner_type","owner_id");