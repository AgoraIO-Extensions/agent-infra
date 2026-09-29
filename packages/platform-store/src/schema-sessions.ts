import { sql } from "drizzle-orm";
import { char, check, index, text, timestamp } from "drizzle-orm/pg-core";
import { platformSchema } from "./schema-common";

export const browserSessions = platformSchema.table(
	"browser_sessions",
	{
		tokenDigest: char("token_digest", { length: 64 }).primaryKey(),
		uid: text("uid").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		check(
			"browser_session_digest_hex",
			sql`${table.tokenDigest} ~ '^[0-9a-f]{64}$'`,
		),
		check("browser_session_uid_nonempty", sql`char_length(${table.uid}) > 0`),
		index("browser_sessions_uid").on(table.uid),
		index("browser_sessions_expires_at").on(table.expiresAt),
	],
);
