CREATE TABLE "platform"."evaluation_datasets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."evaluation_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."evaluation_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" bigint NOT NULL,
	"digest" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."evaluation_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" uuid NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"metadata_expires_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."evaluation_grants" ADD CONSTRAINT "evaluation_grants_dataset_id_evaluation_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "platform"."evaluation_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."evaluation_versions" ADD CONSTRAINT "evaluation_versions_dataset_id_evaluation_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "platform"."evaluation_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluation_grants_dataset" ON "platform"."evaluation_grants" USING btree ("dataset_id","id");--> statement-breakpoint
CREATE INDEX "evaluation_versions_expiry" ON "platform"."evaluation_versions" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "evaluation_versions_dataset" ON "platform"."evaluation_versions" USING btree ("dataset_id","id");