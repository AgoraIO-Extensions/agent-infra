CREATE TABLE "platform"."relay_key_subjects" (
	"purpose" text NOT NULL,
	"subject_id" text NOT NULL,
	"last_version" bigint DEFAULT 0 NOT NULL,
	"current_version" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_key_subjects_purpose_subject_id_pk" PRIMARY KEY("purpose","subject_id"),
	CONSTRAINT "relay_key_subject_purpose" CHECK ("platform"."relay_key_subjects"."purpose" in ('personal', 'agent-default')),
	CONSTRAINT "relay_key_subject_id" CHECK (char_length("platform"."relay_key_subjects"."subject_id") between 1 and 1024),
	CONSTRAINT "relay_key_subject_last_version" CHECK ("platform"."relay_key_subjects"."last_version" between 0 and 9007199254740991),
	CONSTRAINT "relay_key_subject_current_version" CHECK ("platform"."relay_key_subjects"."current_version" is null or "platform"."relay_key_subjects"."current_version" between 1 and "platform"."relay_key_subjects"."last_version")
);
--> statement-breakpoint
CREATE TABLE "platform"."relay_key_versions" (
	"purpose" text NOT NULL,
	"subject_id" text NOT NULL,
	"key_version" bigint NOT NULL,
	"key_id" text NOT NULL,
	"ciphertext" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_key_versions_purpose_subject_id_key_version_pk" PRIMARY KEY("purpose","subject_id","key_version"),
	CONSTRAINT "relay_key_version_purpose" CHECK ("platform"."relay_key_versions"."purpose" in ('personal', 'agent-default')),
	CONSTRAINT "relay_key_version_subject_id" CHECK (char_length("platform"."relay_key_versions"."subject_id") between 1 and 1024),
	CONSTRAINT "relay_key_version_key_id" CHECK (char_length("platform"."relay_key_versions"."key_id") between 1 and 1024),
	CONSTRAINT "relay_key_version_safe" CHECK ("platform"."relay_key_versions"."key_version" between 1 and 9007199254740991),
	CONSTRAINT "relay_key_version_ciphertext_binding" CHECK (("platform"."relay_key_versions"."ciphertext"->>'purpose' = "platform"."relay_key_versions"."purpose"
				and "platform"."relay_key_versions"."ciphertext"->>'subjectId' = "platform"."relay_key_versions"."subject_id"
				and "platform"."relay_key_versions"."ciphertext"->>'keyId' = "platform"."relay_key_versions"."key_id"
				and "platform"."relay_key_versions"."ciphertext"->>'keyVersion' = "platform"."relay_key_versions"."key_version"::text) is true)
);
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "execution_source" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_purpose" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_subject_id" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_id" text;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_version" bigint;--> statement-breakpoint
ALTER TABLE "platform"."relay_key_versions" ADD CONSTRAINT "relay_key_version_subject_fk" FOREIGN KEY ("purpose","subject_id") REFERENCES "platform"."relay_key_subjects"("purpose","subject_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."relay_key_versions" ADD CONSTRAINT "relay_key_version_identity_unique" UNIQUE ("purpose","subject_id","key_version","key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_key_version_key_id_unique" ON "platform"."relay_key_versions" USING btree ("key_id");--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_key_version_fk" FOREIGN KEY ("relay_key_purpose","relay_key_subject_id","relay_key_version","relay_key_id") REFERENCES "platform"."relay_key_versions"("purpose","subject_id","key_version","key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_key_binding" CHECK ((
				"platform"."conversation_executions"."execution_source" IS NULL
				AND "platform"."conversation_executions"."relay_key_purpose" IS NULL
				AND "platform"."conversation_executions"."relay_key_subject_id" IS NULL
				AND "platform"."conversation_executions"."relay_key_id" IS NULL
				AND "platform"."conversation_executions"."relay_key_version" IS NULL
			) OR (
				"platform"."conversation_executions"."execution_source" IS NOT NULL
				AND "platform"."conversation_executions"."relay_key_purpose" IS NOT NULL
				AND "platform"."conversation_executions"."relay_key_subject_id" IS NOT NULL
				AND "platform"."conversation_executions"."relay_key_id" IS NOT NULL
				AND "platform"."conversation_executions"."relay_key_version" IS NOT NULL
				AND "platform"."conversation_executions"."execution_source" in ('web', 'wecom', 'platform-api', 'eval')
				AND "platform"."conversation_executions"."relay_key_purpose" in ('personal', 'agent-default')
				AND char_length("platform"."conversation_executions"."relay_key_subject_id") > 0
				AND char_length("platform"."conversation_executions"."relay_key_id") > 0
				AND "platform"."conversation_executions"."relay_key_version" between 1 and 9007199254740991
				AND (("platform"."conversation_executions"."execution_source" in ('web', 'wecom')
					AND "platform"."conversation_executions"."relay_key_purpose" = 'personal'
					AND "platform"."conversation_executions"."relay_key_subject_id" = "platform"."conversation_executions"."actor_id")
					OR ("platform"."conversation_executions"."execution_source" in ('platform-api', 'eval')
					AND "platform"."conversation_executions"."relay_key_purpose" = 'agent-default'
					AND "platform"."conversation_executions"."relay_key_subject_id" = "platform"."conversation_executions"."agent_id"))
			));
