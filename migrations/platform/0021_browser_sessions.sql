CREATE TABLE "platform"."browser_sessions" (
	"token_digest" char(64) PRIMARY KEY NOT NULL,
	"uid" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "browser_session_digest_hex" CHECK ("platform"."browser_sessions"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "browser_session_uid_nonempty" CHECK (char_length("platform"."browser_sessions"."uid") > 0)
);
--> statement-breakpoint
CREATE INDEX "browser_sessions_uid" ON "platform"."browser_sessions" USING btree ("uid");