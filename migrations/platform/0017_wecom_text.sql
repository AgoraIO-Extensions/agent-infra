CREATE TABLE "platform"."wecom_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"request_digest" text NOT NULL,
	"scope" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"task_boundary" jsonb NOT NULL,
	"channel_revision" text NOT NULL,
	"authorization_revision" text NOT NULL,
	"acceptance_status" text NOT NULL,
	"conversation_id" text,
	"execution_id" text,
	"reply_handle" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"fence" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wecom_acceptance_status" CHECK ("platform"."wecom_receipts"."acceptance_status" in ('accepted','busy','unavailable')),
	CONSTRAINT "wecom_delivery_status" CHECK ("platform"."wecom_receipts"."delivery_status" in ('pending','claimed','sending','sent','failed','unknown','cancelled','expired','abandoned'))
);
--> statement-breakpoint
CREATE INDEX "wecom_delivery_pending" ON "platform"."wecom_receipts" USING btree ("delivery_status","created_at");