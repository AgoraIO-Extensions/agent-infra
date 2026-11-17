CREATE TABLE "platform"."operations_resource_identities" (
	"cluster_id" text NOT NULL,
	"namespace" text NOT NULL,
	"uid" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"agent_id" text,
	"session_id" text,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	CONSTRAINT "operations_resource_identities_cluster_id_namespace_uid_pk" PRIMARY KEY("cluster_id","namespace","uid")
);
--> statement-breakpoint
CREATE INDEX "operations_identity_agent_idx" ON "platform"."operations_resource_identities" USING btree ("cluster_id","namespace","agent_id","last_seen");