CREATE TABLE "platform"."workspace_snapshot_upload_objects" (
	"object_ref" text PRIMARY KEY NOT NULL,
	"reservation_id" text NOT NULL,
	"owner_type" varchar(32) NOT NULL,
	"owner_id" text NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"object_version" text,
	"fence_version" text,
	"scan_cursor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshot_upload_object_owner_type" CHECK ("platform"."workspace_snapshot_upload_objects"."owner_type" in ('user','application')),
	CONSTRAINT "snapshot_upload_object_state" CHECK ("platform"."workspace_snapshot_upload_objects"."state" in ('pending','published','retired')),
	CONSTRAINT "snapshot_upload_object_request_digest" CHECK ("platform"."workspace_snapshot_upload_objects"."request_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX "snapshot_upload_object_recovery_idx" ON "platform"."workspace_snapshot_upload_objects" USING btree ("updated_at","object_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_upload_object_reservation_idx" ON "platform"."workspace_snapshot_upload_objects" USING btree ("reservation_id");