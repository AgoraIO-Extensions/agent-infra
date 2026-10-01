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