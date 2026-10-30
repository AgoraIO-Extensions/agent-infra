ALTER TABLE "platform"."session_sandbox_allocations" ADD COLUMN "admission_profile_digest" text;
--> statement-breakpoint
UPDATE "platform"."session_sandbox_allocations" a
SET "admission_profile_digest" = r.profile_digest
FROM "platform"."session_sandbox_reserves" r
WHERE r.sandbox_id = a.sandbox_id AND r.session_id = a.conversation_id
  AND r.agent_id = a.agent_id AND r.status = 'claimed';
