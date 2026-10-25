ALTER TABLE "platform"."conversation_executions" ADD COLUMN "unknown_since" timestamp with time zone;--> statement-breakpoint
-- #3373：unknown 恢复按墙钟预算收敛。所有状态写入都经过这个触发器：进入 unknown 时记录当时的
-- 数据库时间，保持 unknown 时不变，离开 unknown 时清除。
CREATE FUNCTION "platform"."conversation_execution_unknown_since"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.status = 'unknown' THEN
		IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'unknown' OR NEW.unknown_since IS NULL THEN
			NEW.unknown_since := clock_timestamp();
		END IF;
	ELSE
		NEW.unknown_since := NULL;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "conversation_execution_unknown_since"
BEFORE INSERT OR UPDATE OF "status" ON "platform"."conversation_executions"
FOR EACH ROW EXECUTE FUNCTION "platform"."conversation_execution_unknown_since"();--> statement-breakpoint
-- 迁移前已处于 unknown 的 Execution 从迁移时开始计时。
UPDATE "platform"."conversation_executions" SET "unknown_since" = clock_timestamp() WHERE "status" = 'unknown';
