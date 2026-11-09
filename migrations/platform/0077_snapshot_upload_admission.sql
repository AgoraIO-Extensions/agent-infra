CREATE TABLE "platform"."workspace_snapshot_upload_admissions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" varchar(32) NOT NULL,
	"owner_id" text NOT NULL,
	"policy_hash" varchar(64) NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "snapshot_upload_admission_owner_type" CHECK ("platform"."workspace_snapshot_upload_admissions"."owner_type" in ('user','application')),
	CONSTRAINT "snapshot_upload_admission_id" CHECK ("platform"."workspace_snapshot_upload_admissions"."id" ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
	CONSTRAINT "snapshot_upload_admission_policy_hash" CHECK ("platform"."workspace_snapshot_upload_admissions"."policy_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "snapshot_upload_admission_bytes" CHECK ("platform"."workspace_snapshot_upload_admissions"."reserved_bytes" > 0),
	CONSTRAINT "snapshot_upload_admission_times" CHECK ("platform"."workspace_snapshot_upload_admissions"."expires_at" > "platform"."workspace_snapshot_upload_admissions"."created_at" and "platform"."workspace_snapshot_upload_admissions"."retain_until" >= "platform"."workspace_snapshot_upload_admissions"."expires_at" and ("platform"."workspace_snapshot_upload_admissions"."released_at" is null or "platform"."workspace_snapshot_upload_admissions"."released_at" >= "platform"."workspace_snapshot_upload_admissions"."created_at"))
);
--> statement-breakpoint
CREATE INDEX "snapshot_upload_admission_retention_idx" ON "platform"."workspace_snapshot_upload_admissions" USING btree ("retain_until");--> statement-breakpoint
CREATE INDEX "snapshot_upload_admission_owner_created_idx" ON "platform"."workspace_snapshot_upload_admissions" USING btree ("owner_type","owner_id","created_at");