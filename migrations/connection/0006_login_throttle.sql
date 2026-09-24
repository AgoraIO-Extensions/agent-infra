CREATE TABLE "connection"."login_throttle_attempts" (
  "id" text PRIMARY KEY NOT NULL,
  "environment" varchar(100) NOT NULL,
  "source_marker" varchar(64) NOT NULL,
  "account_marker" varchar(64) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "login_throttle_attempts_environment_non_empty" CHECK (char_length("environment") > 0),
  CONSTRAINT "login_throttle_attempts_source_marker_check" CHECK ("source_marker" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "login_throttle_attempts_account_marker_check" CHECK ("account_marker" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "login_throttle_attempts_environment_expiry_idx"
  ON "connection"."login_throttle_attempts" USING btree ("environment", "expires_at");
CREATE INDEX "login_throttle_attempts_source_idx"
  ON "connection"."login_throttle_attempts" USING btree ("environment", "source_marker", "expires_at");
CREATE INDEX "login_throttle_attempts_account_idx"
  ON "connection"."login_throttle_attempts" USING btree ("environment", "account_marker", "expires_at");

CREATE TABLE "connection"."login_throttle_failures" (
  "environment" varchar(100) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "marker" varchar(64) NOT NULL,
  "failures" integer NOT NULL,
  "window_until" timestamp with time zone NOT NULL,
  "next_allowed_at" timestamp with time zone,
  CONSTRAINT "login_throttle_failures_pk" PRIMARY KEY ("environment", "kind", "marker"),
  CONSTRAINT "login_throttle_failures_kind_check" CHECK ("kind" IN ('source', 'account', 'environment')),
  CONSTRAINT "login_throttle_failures_count_positive" CHECK ("failures" > 0),
  CONSTRAINT "login_throttle_failures_environment_non_empty" CHECK (char_length("environment") > 0),
  CONSTRAINT "login_throttle_failures_marker_check" CHECK ("marker" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "login_throttle_failures_expiry_idx"
  ON "connection"."login_throttle_failures" USING btree ("environment", "window_until");
