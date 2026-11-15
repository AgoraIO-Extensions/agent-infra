CREATE TABLE "platform"."connection_consumer_disables" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"registration_operation_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"source_namespace" varchar(128) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"status" varchar(16) DEFAULT 'waiting' NOT NULL,
	"request" jsonb,
	"request_digest" varchar(64),
	"receipt" jsonb,
	"result_revision" text,
	"failure_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sending_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "connection_consumer_disable_identity" CHECK ("platform"."connection_consumer_disables"."source_namespace" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
				and "platform"."connection_consumer_disables"."idempotency_key" ~ '^ccd-v1[.][a-f0-9]{64}$'
				and "platform"."connection_consumer_disables"."operation_id" = 'connection-consumer-disable:' || substr("platform"."connection_consumer_disables"."idempotency_key", 8)),
	CONSTRAINT "connection_consumer_disable_status" CHECK ("platform"."connection_consumer_disables"."status" in ('waiting','pending','sending','disabled','failed','unknown','not_required')),
	CONSTRAINT "connection_consumer_disable_request" CHECK (("platform"."connection_consumer_disables"."request" is null) = ("platform"."connection_consumer_disables"."status" in ('waiting','pending','not_required'))
				and ("platform"."connection_consumer_disables"."request" is null) = ("platform"."connection_consumer_disables"."request_digest" is null)
				and ("platform"."connection_consumer_disables"."request" is null or (jsonb_typeof("platform"."connection_consumer_disables"."request") = 'object'
					and "platform"."connection_consumer_disables"."request_digest" ~ '^[a-f0-9]{64}$'
					and "platform"."connection_consumer_disables"."request" @> jsonb_build_object('schemaVersion', 1,
						'operationId', "platform"."connection_consumer_disables"."operation_id", 'registrationOperationId', "platform"."connection_consumer_disables"."registration_operation_id",
						'platformAgentId', "platform"."connection_consumer_disables"."agent_id", 'sourceNamespace', "platform"."connection_consumer_disables"."source_namespace",
						'idempotencyKey', "platform"."connection_consumer_disables"."idempotency_key", 'requestDigest', "platform"."connection_consumer_disables"."request_digest")
					and "platform"."connection_consumer_disables"."request" ?& array['consumerId','registrationId','registrationKeyHash','policyRevision','expectedRevision']
					and ("platform"."connection_consumer_disables"."request" - array['schemaVersion','operationId','registrationOperationId','sourceNamespace','platformAgentId','consumerId','registrationId','registrationKeyHash','policyRevision','expectedRevision','idempotencyKey','requestDigest']) = '{}'::jsonb))),
	CONSTRAINT "connection_consumer_disable_receipt" CHECK (("platform"."connection_consumer_disables"."status" = 'disabled') = ("platform"."connection_consumer_disables"."receipt" is not null and "platform"."connection_consumer_disables"."result_revision" is not null and "platform"."connection_consumer_disables"."disabled_at" is not null)
				and ("platform"."connection_consumer_disables"."receipt" is null or (jsonb_typeof("platform"."connection_consumer_disables"."receipt") = 'object'
					and "platform"."connection_consumer_disables"."receipt" @> jsonb_build_object('schemaVersion', 1,
						'operationId', "platform"."connection_consumer_disables"."operation_id", 'resultRevision', "platform"."connection_consumer_disables"."result_revision",
						'requestDigest', "platform"."connection_consumer_disables"."request_digest")
					and "platform"."connection_consumer_disables"."receipt" ?& array['consumerId','registrationId']
					and ("platform"."connection_consumer_disables"."receipt" - array['schemaVersion','operationId','consumerId','registrationId','resultRevision','requestDigest']) = '{}'::jsonb))),
	CONSTRAINT "connection_consumer_disable_failure" CHECK ("platform"."connection_consumer_disables"."failure_code" is null or "platform"."connection_consumer_disables"."failure_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "platform"."connection_consumer_disables" ADD CONSTRAINT "connection_consumer_disables_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."connection_consumer_disables" ADD CONSTRAINT "connection_consumer_disable_registration_fk" FOREIGN KEY ("registration_operation_id") REFERENCES "platform"."connection_consumer_registrations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_consumer_disable_agent_unique" ON "platform"."connection_consumer_disables" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_consumer_disable_registration_unique" ON "platform"."connection_consumer_disables" USING btree ("registration_operation_id");--> statement-breakpoint
CREATE INDEX "connection_consumer_disable_status_idx" ON "platform"."connection_consumer_disables" USING btree ("status","updated_at");