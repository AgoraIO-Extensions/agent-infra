-- Synthetic postTask28 final schema on the unchanged main0-24 prefix.
-- Statically reconstructed DDL only: no historical revocation, deadline/backfill
-- or recovery UPDATE is replayed. Not a database dump or migration-chain runner.

ALTER TABLE "platform"."api_credential_delivery_grants" ADD COLUMN "pending_scopes" jsonb;
--> statement-breakpoint
ALTER TABLE "platform"."api_credential_delivery_grants" ADD COLUMN "pending_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform"."platform_api_credentials" ADD COLUMN "recipient_user_id" text;
--> statement-breakpoint
ALTER TABLE "platform"."api_credential_delivery_grants" ADD CONSTRAINT "api_credential_delivery_pending_scopes_array" CHECK ("platform"."api_credential_delivery_grants"."pending_scopes" is null or (jsonb_typeof("platform"."api_credential_delivery_grants"."pending_scopes") = 'array' and jsonb_array_length("platform"."api_credential_delivery_grants"."pending_scopes") > 0));
--> statement-breakpoint
ALTER TABLE "platform"."platform_api_credentials" ADD CONSTRAINT "platform_api_credential_recipient_user_non_empty" CHECK ("platform"."platform_api_credentials"."recipient_user_id" is null or char_length("platform"."platform_api_credentials"."recipient_user_id") > 0);
--> statement-breakpoint
CREATE TABLE "platform"."ldap_identity_ids" (
	"issuer" varchar(256) NOT NULL,
	"uid" varchar(256) NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "ldap_identity_ids_issuer_uid_pk" PRIMARY KEY("issuer","uid"),
	CONSTRAINT "ldap_identity_issuer_non_empty" CHECK (char_length("platform"."ldap_identity_ids"."issuer") > 0),
	CONSTRAINT "ldap_identity_uid_non_empty" CHECK (char_length("platform"."ldap_identity_ids"."uid") > 0),
	CONSTRAINT "ldap_identity_user_id_uuid_v4" CHECK ("platform"."ldap_identity_ids"."user_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "platform"."platform_user_disables" (
	"user_id" text PRIMARY KEY NOT NULL,
	"disabled_by" text NOT NULL,
	"disabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_user_disable_user_id_non_empty" CHECK (char_length("platform"."platform_user_disables"."user_id") > 0),
	CONSTRAINT "platform_user_disable_actor_non_empty" CHECK (char_length("platform"."platform_user_disables"."disabled_by") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ldap_identity_user_id_unique" ON "platform"."ldap_identity_ids" USING btree ("user_id");
--> statement-breakpoint
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
	CONSTRAINT "relay_key_version_identity_unique" UNIQUE("purpose","subject_id","key_version","key_id"),
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
ALTER TABLE "platform"."relay_key_versions" ADD CONSTRAINT "relay_key_version_subject_fk" FOREIGN KEY ("purpose","subject_id") REFERENCES "platform"."relay_key_subjects"("purpose","subject_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "relay_key_version_key_id_unique" ON "platform"."relay_key_versions" USING btree ("key_id");
--> statement-breakpoint
ALTER TYPE "platform"."conversation_execution_status" ADD VALUE 'waiting' BEFORE 'submitted';
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "task_wait_order" bigint;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "task_wait_deadline" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_execution_task_wait_order_unique" ON "platform"."conversation_executions" USING btree ("agent_id","task_wait_order") WHERE "platform"."conversation_executions"."task_wait_order" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "conversation_execution_agent_wait_idx" ON "platform"."conversation_executions" USING btree ("agent_id","task_wait_order");
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_task_wait_binding" CHECK (("platform"."conversation_executions"."task_wait_order" IS NULL AND "platform"."conversation_executions"."task_wait_deadline" IS NULL AND "platform"."conversation_executions"."status"::text <> 'waiting') OR ("platform"."conversation_executions"."task_wait_order" IS NOT NULL AND "platform"."conversation_executions"."task_wait_order" between 1 and 9007199254740991 AND "platform"."conversation_executions"."task_wait_deadline" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" DROP CONSTRAINT "conversation_event_source_binding";
--> statement-breakpoint
ALTER TABLE "platform"."conversation_events" ADD CONSTRAINT "conversation_event_source_binding" CHECK ((source = 'runtime' AND runtime_cursor IS NOT NULL AND char_length(runtime_cursor) > 0 AND event_type NOT IN ('model.selection.fell_back', 'task.status')) OR (source = 'platform' AND runtime_cursor IS NULL AND event_type IN ('model.selection.fell_back', 'task.status')));
--> statement-breakpoint
ALTER TABLE "platform"."conversation_generation_tombstones" DROP CONSTRAINT "conversation_generation_tombstone_principal_valid";
--> statement-breakpoint
ALTER TABLE "platform"."conversation_generation_tombstones" ADD CONSTRAINT "conversation_generation_tombstone_principal_valid" CHECK (jsonb_typeof("platform"."conversation_generation_tombstones"."original_principal") = 'object'
				and coalesce(jsonb_typeof("platform"."conversation_generation_tombstones"."original_principal"->'kind') = 'string', false)
				and coalesce("platform"."conversation_generation_tombstones"."original_principal"->>'kind' in ('user', 'application'), false)
				and coalesce(jsonb_typeof("platform"."conversation_generation_tombstones"."original_principal"->'id') = 'string', false)
				and char_length(coalesce("platform"."conversation_generation_tombstones"."original_principal"->>'id', '')) > 0);
--> statement-breakpoint
ALTER TABLE "platform"."conversation_stops" ADD COLUMN "confirmation_deadline" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_stops" ADD COLUMN "confirmation_timed_out_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_stops" ALTER COLUMN "confirmation_deadline" SET DEFAULT clock_timestamp() + interval '60 seconds';
--> statement-breakpoint
ALTER TABLE "platform"."conversation_stops" ALTER COLUMN "confirmation_deadline" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform"."platform_api_credentials" ADD CONSTRAINT "platform_api_credential_hash_unique" UNIQUE("credential_hash");
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "execution_source" text;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_purpose" text;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_subject_id" text;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_id" text;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "relay_key_version" bigint;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_key_version_fk" FOREIGN KEY ("relay_key_purpose","relay_key_subject_id","relay_key_version","relay_key_id") REFERENCES "platform"."relay_key_versions"("purpose","subject_id","key_version","key_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
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
				AND (("platform"."conversation_executions"."execution_source" = 'web' AND "platform"."conversation_executions"."channel_id" = 'web')
					OR ("platform"."conversation_executions"."execution_source" = 'wecom' AND ("platform"."conversation_executions"."channel_id" = 'wecom'
						OR left("platform"."conversation_executions"."channel_id", 10) = 'wecom_bot:'
						OR left("platform"."conversation_executions"."channel_id", 10) = 'wecom_app:'))
					OR ("platform"."conversation_executions"."execution_source" = 'platform-api' AND ("platform"."conversation_executions"."channel_id" = 'api'
						OR "platform"."conversation_executions"."channel_id" LIKE 'api:%'))
					OR ("platform"."conversation_executions"."execution_source" = 'eval' AND "platform"."conversation_executions"."channel_id" = 'eval'))
				AND (("platform"."conversation_executions"."execution_source" in ('web', 'wecom')
					AND "platform"."conversation_executions"."relay_key_purpose" = 'personal'
					AND "platform"."conversation_executions"."relay_key_subject_id" = "platform"."conversation_executions"."actor_id")
					OR ("platform"."conversation_executions"."execution_source" in ('platform-api', 'eval')
					AND "platform"."conversation_executions"."relay_key_purpose" = 'agent-default'
					AND "platform"."conversation_executions"."relay_key_subject_id" = "platform"."conversation_executions"."agent_id"))
			));
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "runtime_submit_protocol" text;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "original_operation_digest" text;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD COLUMN "original_submit_host_session_ref" text;
--> statement-breakpoint
ALTER TABLE "platform"."conversation_executions" ADD CONSTRAINT "conversation_execution_original_digest_binding" CHECK (("platform"."conversation_executions"."runtime_submit_protocol" IS NULL AND "platform"."conversation_executions"."original_operation_digest" IS NULL AND "platform"."conversation_executions"."original_submit_host_session_ref" IS NULL) OR ("platform"."conversation_executions"."runtime_submit_protocol" IS NOT NULL AND "platform"."conversation_executions"."original_operation_digest" IS NOT NULL AND "platform"."conversation_executions"."runtime_submit_protocol" in ('v2', 'v4') AND "platform"."conversation_executions"."original_operation_digest" ~ '^[A-Za-z0-9_-]{43}$' AND ("platform"."conversation_executions"."runtime_submit_protocol" <> 'v4' OR "platform"."conversation_executions"."execution_source" IS NOT NULL) AND ("platform"."conversation_executions"."runtime_submit_protocol" <> 'v2' OR "platform"."conversation_executions"."original_submit_host_session_ref" IS NULL)));

--> statement-breakpoint
-- The rows below are synthetic final-state sentinels. Fixed identities/references
-- follow the retained historical Web dataset; values are not original DB rows.
INSERT INTO platform.agents (id, authorization_revision, created_at)
VALUES ('checkpoint_agent', 'checkpoint_agent_revision', '2026-09-04T00:00:00Z');
--> statement-breakpoint
INSERT INTO platform.agent_applications
(id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at,
 management_revision, approval_revision, desired_state, workload_revision, fence)
VALUES ('checkpoint_application', 'checkpoint_agent', 'checkpoint_user', 'Historical Agent',
 'Synthetic historical state', 'stopped', 'checkpoint_trace', 'checkpoint_request',
 '2026-09-04T00:00:00Z', 1, 1, 'stopped', 1, 1);
--> statement-breakpoint
INSERT INTO platform.agent_configuration_revisions (agent_id, revision, source_reference, created_at)
VALUES ('checkpoint_agent', 1, 'checkpoint:source', '2026-09-04T00:00:00Z');
--> statement-breakpoint
INSERT INTO platform.agent_owners (agent_id, owner_id, created_at)
VALUES ('checkpoint_agent', 'checkpoint_user', '2026-09-04T00:00:00Z');
--> statement-breakpoint
INSERT INTO platform.platform_applications (id, name, responsible_user_id, authorization_revision)
VALUES ('checkpoint_api_application', 'Synthetic API Application', 'checkpoint_user', 'checkpoint_application_revision');
--> statement-breakpoint
INSERT INTO platform.platform_api_credentials
(id, principal_type, principal_id, credential_hash, scopes, recipient_user_id, expires_at, revoked_at)
VALUES ('checkpoint_credential', 'application', 'checkpoint_api_application', repeat('c',64),
 '["agent:read"]', 'checkpoint_user', '2027-01-01T00:00:00Z', '2026-09-04T00:00:03Z');
--> statement-breakpoint
INSERT INTO platform.api_credential_delivery_grants
(application_id, principal_type, principal_id, authorization_revision, pending_scopes, pending_expires_at)
VALUES ('checkpoint_api_application', 'user', 'checkpoint_user', 'checkpoint_delivery_revision',
 '["agent:read"]', '2027-01-01T00:00:00Z');
--> statement-breakpoint
INSERT INTO platform.ldap_identity_ids (issuer, uid, user_id)
VALUES ('ldap://checkpoint.test', 'checkpoint_user', '11111111-1111-4111-8111-111111111111');
--> statement-breakpoint
INSERT INTO platform.platform_user_disables (user_id, disabled_by, disabled_at)
VALUES ('checkpoint_user', 'checkpoint_admin', '2026-09-04T00:00:00Z');
--> statement-breakpoint
INSERT INTO platform.relay_key_subjects (purpose, subject_id, last_version, current_version, updated_at)
VALUES ('personal', 'checkpoint_user', 1, 1, '2026-09-04T00:00:00Z');
--> statement-breakpoint
INSERT INTO platform.relay_key_versions (purpose, subject_id, key_version, key_id, ciphertext, created_at)
VALUES ('personal', 'checkpoint_user', 1, 'checkpoint_relay_key',
 '{"purpose":"personal","subjectId":"checkpoint_user","keyId":"checkpoint_relay_key","keyVersion":1,"syntheticCiphertext":"checkpoint-only"}', '2026-09-04T00:00:00Z');
--> statement-breakpoint
INSERT INTO platform.conversations
(id, agent_id, actor_id, channel_id, status, session_generation, host_session_ref, authorization_revision,
 last_conversation_cursor, selected_model_option_id, selected_reasoning_level, created_at)
VALUES ('checkpoint_conversation', 'checkpoint_agent', 'checkpoint_user', 'web', 'ready', 3,
 'checkpoint_host', 'checkpoint_agent_revision', 2, 'model_primary', 'low', '2026-09-04T00:00:00Z');
--> statement-breakpoint
INSERT INTO platform.conversation_executions
(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id, status, session_generation,
 delivery_fence, authorization_revision, model_configuration_revision, model_option_id, reasoning_level,
 last_event_sequence, last_runtime_cursor, created_at)
VALUES ('checkpoint_execution', 'checkpoint_conversation', 'checkpoint_agent', 'checkpoint_user', 'web',
 'checkpoint_turn', 'completed', 3, 5, 'checkpoint_agent_revision', 7, 'model_primary', 'low', 2,
 'checkpoint_runtime_2', '2026-09-04T00:00:01Z');
--> statement-breakpoint
INSERT INTO platform.conversation_executions
(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id, status, session_generation,
 authorization_revision, created_at, task_wait_order, task_wait_deadline, execution_source,
 relay_key_purpose, relay_key_subject_id, relay_key_id, relay_key_version, runtime_submit_protocol,
 original_operation_digest, original_submit_host_session_ref)
VALUES ('checkpoint_waiting_execution', 'checkpoint_conversation', 'checkpoint_agent', 'checkpoint_user',
 'web', 'checkpoint_waiting_turn', 'waiting', 3, 'checkpoint_agent_revision', '2026-09-04T00:00:03Z',
 1, '2026-09-04T00:01:03Z', 'web', 'personal', 'checkpoint_user', 'checkpoint_relay_key', 1,
 'v4', repeat('d',43), 'checkpoint_host');
--> statement-breakpoint
INSERT INTO platform.conversation_messages
(message_id, conversation_id, actor_id, role, text, execution_id, status, created_at)
VALUES ('checkpoint_message', 'checkpoint_conversation', 'checkpoint_user', 'user',
 'Synthetic historical input', 'checkpoint_execution', 'submitted', '2026-09-04T00:00:01Z');
--> statement-breakpoint
INSERT INTO platform.conversation_events
(event_id, conversation_id, execution_id, adapter_event_key, sequence, conversation_cursor,
 event_type, event_payload, event_digest, runtime_cursor, source, occurred_at)
VALUES ('checkpoint_event_1', 'checkpoint_conversation', 'checkpoint_execution', 'checkpoint_adapter_1',
 1, 1, 'text.delta', '{"type":"text.delta","text":"Synthetic historical output"}', repeat('b',64),
 'checkpoint_runtime_1', 'runtime', '2026-09-04T00:00:02Z'),
 ('checkpoint_event_2', 'checkpoint_conversation', 'checkpoint_execution', 'checkpoint_adapter_2',
 2, 2, 'execution.status', '{"type":"execution.status","status":"completed"}', repeat('a',64),
 'checkpoint_runtime_2', 'runtime', '2026-09-04T00:00:02Z');
--> statement-breakpoint
INSERT INTO platform.conversation_audit_events
(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at)
VALUES ('checkpoint_acceptance_audit', 'checkpoint_conversation', 'checkpoint_execution',
 'checkpoint_agent', 'checkpoint_user', 'conversation.message.accepted', 'checkpoint_trace',
 'checkpoint_request', '2026-09-04T00:00:01Z');
--> statement-breakpoint
INSERT INTO platform.idempotency_records
(id, scope_type, scope_id, actor_id, command_type, idempotency_key, request_digest, status, result)
VALUES ('checkpoint_idempotency', 'conversation', 'checkpoint_conversation', 'checkpoint_user',
 'message', 'checkpoint_key', repeat('e',64), 'completed',
 '{"schemaVersion":1,"status":"submitted","messageId":"checkpoint_message","executionId":"checkpoint_execution"}');
--> statement-breakpoint
INSERT INTO platform.outbox_items
(id, scope_type, scope_id, operation, payload, trace_id, request_id, status, delivery_fence)
VALUES ('conversation:turn:checkpoint_execution', 'conversation', 'checkpoint_conversation',
 'conversation.turn.submit.v1', '{"schemaVersion":1,"conversationId":"checkpoint_conversation","executionId":"checkpoint_execution","messageId":"checkpoint_message","turnId":"checkpoint_turn","sessionGeneration":3,"modelConfigurationRevision":7,"modelOptionId":"model_primary","reasoningLevel":"low"}',
 'checkpoint_trace', 'checkpoint_request', 'succeeded', 5);
--> statement-breakpoint
INSERT INTO platform.conversation_stops
(execution_id, stop_request_id, status, created_at, confirmation_deadline, confirmation_timed_out_at)
VALUES ('checkpoint_execution', 'checkpoint_stop_request', 'completed', '2026-09-04T00:00:03Z',
 '2026-09-04T00:01:03Z', NULL);
--> statement-breakpoint
INSERT INTO platform.task_authorization_records (id, execution_id, boundary)
VALUES ('checkpoint_task_authorization', 'checkpoint_execution',
 '{"schemaVersion":1,"principal":{"kind":"user","id":"checkpoint_user"},"agentId":"checkpoint_agent","channelId":"web","identityRevision":"checkpoint_identity_revision","agentAuthorizationRevision":"checkpoint_agent_revision","accessSources":[{"kind":"organization","organizationId":"checkpoint_organization"}]}');
--> statement-breakpoint
INSERT INTO platform.task_control_records (id, execution_id, authorization_record_id, reason)
VALUES ('checkpoint_control', 'checkpoint_execution', 'checkpoint_task_authorization', 'generation_isolation');
--> statement-breakpoint
INSERT INTO platform.conversation_generation_tombstones
(operation_id, conversation_id, session_generation, execution_id, item_id, control_record_id,
 control_source_id, original_principal, host_session_ref, failure_code, created_at)
VALUES ('checkpoint_tombstone', 'checkpoint_conversation', 3, 'checkpoint_execution',
 'conversation:turn:checkpoint_execution', 'checkpoint_control', 'checkpoint_stop_request',
 '{"kind":"user","id":"checkpoint_user"}', 'checkpoint_host', 'RUNTIME_SESSION_RECOVERY_FAILED', '2026-09-04T00:00:04Z');
--> statement-breakpoint
INSERT INTO platform.audit_events
(id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
VALUES ('checkpoint_business_audit', 'checkpoint_trace', 'user', 'checkpoint_user', 'checkpoint.seed',
 'agent', 'checkpoint_agent', 'succeeded', 'checkpoint_request', 'checkpoint_agent', '{"synthetic":true}');
