CREATE TABLE "platform"."runtime_safety_evidence" (
	"evidence_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"challenge_ref" text NOT NULL,
	"record" jsonb NOT NULL,
	"record_sha256" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "runtime_safety_evidence_challenge" UNIQUE("kind","challenge_ref"),
	CONSTRAINT "runtime_safety_evidence_kind" CHECK ("platform"."runtime_safety_evidence"."kind" in ('isolation_observation', 'original_admission_check')),
	CONSTRAINT "runtime_safety_evidence_code" CHECK (("platform"."runtime_safety_evidence"."kind" = 'isolation_observation' and "platform"."runtime_safety_evidence"."code" = 'RUNTIME_ISOLATION_EVIDENCE_V1')
				or ("platform"."runtime_safety_evidence"."kind" = 'original_admission_check' and "platform"."runtime_safety_evidence"."code" = 'RUNTIME_ORIGINAL_ADMISSION_CHECK_V1')),
	CONSTRAINT "runtime_safety_evidence_references" CHECK (char_length("platform"."runtime_safety_evidence"."evidence_id") between 1 and 128
				and char_length("platform"."runtime_safety_evidence"."challenge_ref") between 1 and 128
				and char_length("platform"."runtime_safety_evidence"."agent_id") between 1 and 1024
				and char_length("platform"."runtime_safety_evidence"."conversation_id") between 1 and 1024
				and char_length("platform"."runtime_safety_evidence"."execution_id") between 1 and 1024),
	CONSTRAINT "runtime_safety_evidence_digest" CHECK ("platform"."runtime_safety_evidence"."record_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "runtime_safety_evidence_record_object" CHECK (jsonb_typeof("platform"."runtime_safety_evidence"."record") = 'object')
);
--> statement-breakpoint
CREATE INDEX "runtime_safety_evidence_execution" ON "platform"."runtime_safety_evidence" USING btree ("conversation_id","execution_id");
--> statement-breakpoint
-- Spec §18.5.1: safety evidence is append-only. A duplicate delivery reads the original row;
-- nothing rewrites or removes a stored record.
CREATE FUNCTION "platform"."runtime_safety_evidence_append_only"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'runtime safety evidence is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "runtime_safety_evidence_append_only"
BEFORE UPDATE OR DELETE
ON "platform"."runtime_safety_evidence"
FOR EACH ROW EXECUTE FUNCTION "platform"."runtime_safety_evidence_append_only"();
