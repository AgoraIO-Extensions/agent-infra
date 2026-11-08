CREATE TABLE "platform"."workspace_snapshot_upload_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" varchar(32) NOT NULL,
	"owner_id" text NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"status" varchar(16) DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"snapshot_id" text,
	"object_ref" text,
	"object_version" text,
	CONSTRAINT "workspace_snapshot_upload_reservation_owner_type" CHECK ("platform"."workspace_snapshot_upload_reservations"."owner_type" in ('user','application')),
	CONSTRAINT "workspace_snapshot_upload_reservation_digest_format" CHECK ("platform"."workspace_snapshot_upload_reservations"."request_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "workspace_snapshot_upload_reservation_bytes_positive" CHECK ("platform"."workspace_snapshot_upload_reservations"."reserved_bytes" > 0),
	CONSTRAINT "workspace_snapshot_upload_reservation_status" CHECK ("platform"."workspace_snapshot_upload_reservations"."status" in ('reserved','completed','released','expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_snapshot_upload_reservation_key_unique" ON "platform"."workspace_snapshot_upload_reservations" USING btree ("owner_type","owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "workspace_snapshot_upload_reservation_owner_status_idx" ON "platform"."workspace_snapshot_upload_reservations" USING btree ("owner_type","owner_id","status","expires_at");