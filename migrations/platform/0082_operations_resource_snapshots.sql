CREATE TABLE "platform"."operations_resource_snapshots" (
	"cluster_id" text NOT NULL,
	"namespace" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "operations_resource_snapshots_cluster_id_namespace_pk" PRIMARY KEY("cluster_id","namespace")
);
