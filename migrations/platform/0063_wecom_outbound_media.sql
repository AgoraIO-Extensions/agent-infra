CREATE TABLE "platform"."wecom_receipt_media" (
	"receipt_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"file_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wecom_receipt_media_receipt_id_ordinal_pk" PRIMARY KEY("receipt_id","ordinal"),
	CONSTRAINT "wecom_receipt_media_ordinal" CHECK ("platform"."wecom_receipt_media"."ordinal" between 0 and 9),
	CONSTRAINT "wecom_receipt_media_kind" CHECK ("platform"."wecom_receipt_media"."kind" in ('image','video','file')),
	CONSTRAINT "wecom_receipt_media_status" CHECK ("platform"."wecom_receipt_media"."status" in ('pending','sending','sent','failed','unknown'))
);
--> statement-breakpoint
ALTER TABLE "platform"."wecom_receipt_media" ADD CONSTRAINT "wecom_receipt_media_receipt_id_wecom_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "platform"."wecom_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wecom_receipt_media_file" ON "platform"."wecom_receipt_media" USING btree ("receipt_id","file_id");