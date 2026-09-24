ALTER TABLE "connection"."principals"
  ADD COLUMN "directory_checked_at" timestamp with time zone;

CREATE TABLE "connection"."browser_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "principal_id" text NOT NULL,
  "issuer" varchar(255) NOT NULL,
  "uid" varchar(255) NOT NULL,
  "recovery_generation" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "browser_sessions_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "connection"."principals" ("id"),
  CONSTRAINT "browser_sessions_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "browser_sessions_generation_positive" CHECK ("recovery_generation" > 0),
  CONSTRAINT "browser_sessions_expiry_after_creation" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "browser_session_id_non_empty" CHECK (char_length("id") > 0),
  CONSTRAINT "browser_session_issuer_non_empty" CHECK (char_length("issuer") > 0),
  CONSTRAINT "browser_session_uid_non_empty" CHECK (char_length("uid") > 0)
);

CREATE UNIQUE INDEX "browser_sessions_token_hash_unique"
  ON "connection"."browser_sessions" USING btree ("token_hash");
CREATE INDEX "browser_sessions_principal_idx"
  ON "connection"."browser_sessions" USING btree ("principal_id");
