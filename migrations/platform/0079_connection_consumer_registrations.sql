CREATE TABLE "platform"."connection_consumer_registrations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"source_namespace" varchar(128) NOT NULL,
	"source_key" text NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"consumer_id" text,
	"receipt" jsonb,
	"consumer_revision" text,
	"association_revision" bigint DEFAULT 0 NOT NULL,
	"failure_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sending_at" timestamp with time zone,
	"registered_at" timestamp with time zone,
	CONSTRAINT "connection_consumer_registration_source" CHECK ("platform"."connection_consumer_registrations"."source_namespace" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and "platform"."connection_consumer_registrations"."source_key" = "platform"."connection_consumer_registrations"."agent_id"),
	CONSTRAINT "connection_consumer_registration_digest" CHECK ("platform"."connection_consumer_registrations"."request_digest" ~ '^[a-f0-9]{64}$' and "platform"."connection_consumer_registrations"."idempotency_key" ~ '^ccr-v1[.][a-f0-9]{64}$'),
	CONSTRAINT "connection_consumer_registration_status" CHECK ("platform"."connection_consumer_registrations"."status" in ('pending','sending','registered','failed','unknown')),
	CONSTRAINT "connection_consumer_registration_request" CHECK (jsonb_typeof("platform"."connection_consumer_registrations"."request") = 'object'
				and "platform"."connection_consumer_registrations"."request" @> jsonb_build_object('schemaVersion', 1,
					'operationId', "platform"."connection_consumer_registrations"."operation_id", 'platformAgentId', "platform"."connection_consumer_registrations"."agent_id",
					'sourceNamespace', "platform"."connection_consumer_registrations"."source_namespace", 'sourceKey', "platform"."connection_consumer_registrations"."source_key",
					'requestDigest', "platform"."connection_consumer_registrations"."request_digest", 'idempotencyKey', "platform"."connection_consumer_registrations"."idempotency_key")
				and "platform"."connection_consumer_registrations"."request" ?& array['platformOwnerId','consumerName','policyRevision','callbackUrl','resource','scope']
				and ("platform"."connection_consumer_registrations"."request" - array['schemaVersion','operationId','sourceNamespace','sourceKey','platformAgentId','platformOwnerId','consumerName','policyRevision','callbackUrl','resource','scope','requestDigest','idempotencyKey']) = '{}'::jsonb),
	CONSTRAINT "connection_consumer_registration_receipt" CHECK (("platform"."connection_consumer_registrations"."status" = 'registered') = ("platform"."connection_consumer_registrations"."consumer_id" is not null and "platform"."connection_consumer_registrations"."receipt" is not null and "platform"."connection_consumer_registrations"."consumer_revision" is not null and "platform"."connection_consumer_registrations"."registered_at" is not null)
				and ("platform"."connection_consumer_registrations"."receipt" is null or (jsonb_typeof("platform"."connection_consumer_registrations"."receipt") = 'object'
					and "platform"."connection_consumer_registrations"."receipt" @> jsonb_build_object('schemaVersion', 1,
						'operationId', "platform"."connection_consumer_registrations"."operation_id", 'sourceNamespace', "platform"."connection_consumer_registrations"."source_namespace",
						'sourceKey', "platform"."connection_consumer_registrations"."source_key", 'consumerId', "platform"."connection_consumer_registrations"."consumer_id",
						'consumerRevision', "platform"."connection_consumer_registrations"."consumer_revision", 'requestDigest', "platform"."connection_consumer_registrations"."request_digest")
					and "platform"."connection_consumer_registrations"."receipt" ? 'registrationId'
					and ("platform"."connection_consumer_registrations"."receipt" - array['schemaVersion','operationId','sourceNamespace','sourceKey','consumerId','consumerRevision','registrationId','requestDigest']) = '{}'::jsonb))),
	CONSTRAINT "connection_consumer_registration_revision" CHECK ("platform"."connection_consumer_registrations"."association_revision" between 0 and 9007199254740991 and ("platform"."connection_consumer_registrations"."status" = 'registered') = ("platform"."connection_consumer_registrations"."association_revision" > 0)),
	CONSTRAINT "connection_consumer_registration_failure" CHECK ("platform"."connection_consumer_registrations"."failure_code" is null or "platform"."connection_consumer_registrations"."failure_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "platform"."connection_consumer_registrations" ADD CONSTRAINT "connection_consumer_registrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_consumer_registration_agent_unique" ON "platform"."connection_consumer_registrations" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_consumer_registration_source_unique" ON "platform"."connection_consumer_registrations" USING btree ("source_namespace","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_consumer_registration_consumer_unique" ON "platform"."connection_consumer_registrations" USING btree ("consumer_id");--> statement-breakpoint
CREATE INDEX "connection_consumer_registration_status_idx" ON "platform"."connection_consumer_registrations" USING btree ("status","updated_at");