CREATE TABLE "platform"."skill_hub_project_contents" (
	"project_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"revision" integer NOT NULL,
	"files" jsonb NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"content_digest" char(64) NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_hub_project_content_revision_positive" CHECK ("platform"."skill_hub_project_contents"."revision" > 0),
	CONSTRAINT "skill_hub_project_content_file_count_bounded" CHECK ("platform"."skill_hub_project_contents"."file_count" between 1 and 100),
	CONSTRAINT "skill_hub_project_content_total_bytes_bounded" CHECK ("platform"."skill_hub_project_contents"."total_bytes" between 1 and 524288),
	CONSTRAINT "skill_hub_project_content_digest_hex" CHECK ("platform"."skill_hub_project_contents"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_hub_project_content_files_array" CHECK (jsonb_typeof("platform"."skill_hub_project_contents"."files") = 'array' and jsonb_array_length("platform"."skill_hub_project_contents"."files") = "platform"."skill_hub_project_contents"."file_count")
);
--> statement-breakpoint
ALTER TABLE "platform"."skill_hub_project_contents" ADD CONSTRAINT "skill_hub_project_content_project_owner_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "platform"."skill_hub_skills"("id","owner_id") ON DELETE no action ON UPDATE no action;