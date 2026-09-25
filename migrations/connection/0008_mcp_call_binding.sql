CREATE TABLE "connection"."mcp_call_bindings" (
  "action_call_id" text PRIMARY KEY NOT NULL,
  "operation_nonce" text NOT NULL,
  "attempt_nonces" jsonb NOT NULL,
  "request_digest_version" text NOT NULL,
  "request_digest" varchar(64) NOT NULL,
  CONSTRAINT "mcp_call_bindings_action_call_fk" FOREIGN KEY ("action_call_id") REFERENCES "connection"."action_calls" ("id"),
  CONSTRAINT "mcp_call_bindings_digest_format" CHECK ("request_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "mcp_call_bindings_digest_version" CHECK ("request_digest_version" = 'connection-request-v1'),
  CONSTRAINT "mcp_call_bindings_attempts" CHECK (jsonb_typeof("attempt_nonces") = 'array' AND jsonb_array_length("attempt_nonces") BETWEEN 1 AND 256)
);
