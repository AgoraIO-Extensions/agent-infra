ALTER TABLE "connection"."consumers"
  ADD COLUMN "redirect_uris" text[] DEFAULT '{}' NOT NULL,
  ADD COLUMN "allowed_scopes" text[] DEFAULT '{}' NOT NULL,
  ADD COLUMN "pat_approved" boolean DEFAULT false NOT NULL;

ALTER TABLE "connection"."consumer_instances"
  ADD COLUMN "installation_key_thumbprint" varchar(64);

CREATE UNIQUE INDEX "consumer_instances_key_thumbprint_unique"
  ON "connection"."consumer_instances" ("installation_key_thumbprint")
  WHERE "installation_key_thumbprint" IS NOT NULL;

CREATE TABLE "connection"."dpop_proofs" (
  "key_thumbprint" varchar(64) NOT NULL,
  "jti" varchar(128) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "dpop_proofs_pk" PRIMARY KEY ("key_thumbprint", "jti")
);
CREATE INDEX "dpop_proofs_expires_at_idx"
  ON "connection"."dpop_proofs" ("expires_at");

CREATE TABLE "connection"."oauth_installation_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "consumer_id" text NOT NULL REFERENCES "connection"."consumers" ("id"),
  "redirect_uri" text NOT NULL,
  "client_state" text NOT NULL,
  "code_challenge" varchar(128) NOT NULL,
  "audience" text NOT NULL,
  "scopes" text[] NOT NULL,
  "installation_key" jsonb NOT NULL,
  "key_thumbprint" varchar(64) NOT NULL,
  "browser_session_hash" varchar(64),
  "principal_id" text REFERENCES "connection"."principals" ("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  CONSTRAINT "oauth_installation_requests_lifetime" CHECK ("expires_at" > "created_at")
);
CREATE INDEX "oauth_installation_requests_expires_at_idx"
  ON "connection"."oauth_installation_requests" ("expires_at");

CREATE TABLE "connection"."oauth_authorization_codes" (
  "code_hash" varchar(64) PRIMARY KEY NOT NULL,
  "principal_id" text NOT NULL REFERENCES "connection"."principals" ("id"),
  "consumer_id" text NOT NULL REFERENCES "connection"."consumers" ("id"),
  "consumer_instance_id" text NOT NULL REFERENCES "connection"."consumer_instances" ("id"),
  "actor_id" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "code_challenge" varchar(128) NOT NULL,
  "audience" text NOT NULL,
  "scopes" text[] NOT NULL,
  "key_thumbprint" varchar(64) NOT NULL,
  "principal_generation" bigint NOT NULL,
  "instance_generation" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  CONSTRAINT "oauth_authorization_codes_lifetime" CHECK ("expires_at" > "created_at")
);
CREATE INDEX "oauth_authorization_codes_expires_at_idx"
  ON "connection"."oauth_authorization_codes" ("expires_at");

CREATE TABLE "connection"."client_token_families" (
  "id" text PRIMARY KEY NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "client_token_families_status" CHECK ("status" IN ('active', 'revoked'))
);

CREATE TABLE "connection"."client_credentials" (
  "id" text PRIMARY KEY NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "family_id" text REFERENCES "connection"."client_token_families" ("id"),
  "principal_id" text NOT NULL REFERENCES "connection"."principals" ("id"),
  "consumer_id" text NOT NULL REFERENCES "connection"."consumers" ("id"),
  "consumer_instance_id" text NOT NULL REFERENCES "connection"."consumer_instances" ("id"),
  "actor_id" text NOT NULL,
  "audience" text NOT NULL,
  "scopes" text[] NOT NULL,
  "key_thumbprint" varchar(64) NOT NULL,
  "principal_generation" bigint NOT NULL,
  "instance_generation" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "client_credentials_kind" CHECK ("kind" IN ('access', 'refresh', 'pat')),
  CONSTRAINT "client_credentials_family" CHECK (("kind" = 'pat') = ("family_id" IS NULL)),
  CONSTRAINT "client_credentials_lifetime" CHECK ("expires_at" > "created_at")
);
CREATE UNIQUE INDEX "client_credentials_token_hash_unique"
  ON "connection"."client_credentials" ("token_hash");
CREATE INDEX "client_credentials_family_idx"
  ON "connection"."client_credentials" ("family_id");
CREATE INDEX "client_credentials_instance_idx"
  ON "connection"."client_credentials" ("consumer_instance_id");
