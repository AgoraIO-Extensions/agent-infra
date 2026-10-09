CREATE TABLE "platform"."connection_installation_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"user_id" text NOT NULL,
	"confirmation_revision" text NOT NULL,
	"binding" jsonb NOT NULL,
	"identity_revision" text NOT NULL,
	"agent_authorization_revision" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_installation_status_valid" CHECK ("platform"."connection_installation_authorizations"."status" in ('awaiting_confirmation','confirmed','revoked','expired','unknown')),
	CONSTRAINT "connection_installation_revision_safe" CHECK ("platform"."connection_installation_authorizations"."revision" between 1 and 9007199254740991),
	CONSTRAINT "connection_installation_binding_user" CHECK (("platform"."connection_installation_authorizations"."binding"->'principal'->>'kind' = 'user' and "platform"."connection_installation_authorizations"."binding"->'principal'->>'id' = "platform"."connection_installation_authorizations"."user_id") is true),
	CONSTRAINT "connection_installation_binding_execution" CHECK (("platform"."connection_installation_authorizations"."binding"->'reference'->>'executionId' = "platform"."connection_installation_authorizations"."execution_id") is true),
	CONSTRAINT "connection_installation_ids_nonempty" CHECK (char_length("platform"."connection_installation_authorizations"."user_id") > 0 and char_length("platform"."connection_installation_authorizations"."confirmation_revision") > 0 and char_length("platform"."connection_installation_authorizations"."identity_revision") > 0 and char_length("platform"."connection_installation_authorizations"."agent_authorization_revision") > 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."connection_installation_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"authorization_id" text NOT NULL,
	"command" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_installation_command_valid" CHECK ("platform"."connection_installation_commands"."command" in ('begin','confirm','status')),
	CONSTRAINT "connection_installation_delivery_valid" CHECK ("platform"."connection_installation_commands"."status" in ('pending','sending','completed','unknown','rejected')),
	CONSTRAINT "connection_installation_digest_valid" CHECK ("platform"."connection_installation_commands"."request_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "platform"."connection_installation_authorizations" ADD CONSTRAINT "connection_installation_execution_fk" FOREIGN KEY ("execution_id") REFERENCES "platform"."conversation_executions"("execution_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."connection_installation_commands" ADD CONSTRAINT "connection_installation_command_authorization_fk" FOREIGN KEY ("authorization_id") REFERENCES "platform"."connection_installation_authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_installation_user_execution_idx" ON "platform"."connection_installation_authorizations" USING btree ("user_id","execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_installation_command_key_unique" ON "platform"."connection_installation_commands" USING btree ("authorization_id","command","idempotency_key");--> statement-breakpoint
CREATE INDEX "connection_installation_pending_idx" ON "platform"."connection_installation_commands" USING btree ("status","authorization_id");