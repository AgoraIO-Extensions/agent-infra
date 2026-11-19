CREATE TABLE "platform"."connection_host_supplies" (
	"agent_id" text NOT NULL,
	"association_revision" bigint NOT NULL,
	"system_fingerprint" varchar(64) NOT NULL,
	"state" text NOT NULL,
	"ref" varchar(128),
	"revision" varchar(128),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_host_supplies_agent_id_association_revision_pk" PRIMARY KEY("agent_id","association_revision"),
	CONSTRAINT "connection_host_supply_state" CHECK (
			"platform"."connection_host_supplies"."state" in ('writing', 'available', 'cleanup_pending', 'cleanup_unknown', 'closed')
			and ("platform"."connection_host_supplies"."state" <> 'available' or ("platform"."connection_host_supplies"."ref" is not null and "platform"."connection_host_supplies"."revision" is not null))
		)
);
--> statement-breakpoint
ALTER TABLE "platform"."connection_host_supplies" ADD CONSTRAINT "connection_host_supplies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agents"("id") ON DELETE no action ON UPDATE no action;