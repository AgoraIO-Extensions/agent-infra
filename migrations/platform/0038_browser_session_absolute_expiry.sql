ALTER TABLE "platform"."browser_sessions" ADD COLUMN "absolute_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "platform"."browser_sessions_default_absolute_expiry"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."absolute_expires_at" IS NULL THEN
		NEW."absolute_expires_at" := NEW."expires_at";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "browser_sessions_default_absolute_expiry"
BEFORE INSERT OR UPDATE ON "platform"."browser_sessions"
FOR EACH ROW
EXECUTE FUNCTION "platform"."browser_sessions_default_absolute_expiry"();--> statement-breakpoint
UPDATE "platform"."browser_sessions"
SET "absolute_expires_at" = "expires_at"
WHERE "absolute_expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "platform"."browser_sessions" ALTER COLUMN "absolute_expires_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "browser_sessions_absolute_expires_at" ON "platform"."browser_sessions" USING btree ("absolute_expires_at");
