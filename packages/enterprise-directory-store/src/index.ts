import type { DirectoryStore } from "@agent-infra/enterprise-directory";
import { validateSnapshot } from "@agent-infra/enterprise-directory";
import { desc } from "drizzle-orm";
import { jsonb, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const directorySchema = pgSchema("enterprise_directory");
const snapshots = directorySchema.table("snapshots", {
	revision: uuid("revision").primaryKey(),
	fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
	validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
	contents: jsonb("contents").notNull(),
});

export function createPostgresDirectoryStore(
	databaseUrl: string,
): DirectoryStore {
	const sql = postgres(databaseUrl, { max: 4 });
	const db = drizzle(sql);
	return {
		async publish(value) {
			const snapshot = validateSnapshot(value);
			await db.insert(snapshots).values({
				revision: snapshot.revision,
				fetchedAt: new Date(snapshot.fetchedAt),
				validUntil: new Date(snapshot.validUntil),
				contents: snapshot,
			});
		},
		async latest() {
			const rows = await db
				.select({ contents: snapshots.contents })
				.from(snapshots)
				.orderBy(desc(snapshots.fetchedAt), desc(snapshots.revision))
				.limit(1);
			return rows[0]?.contents ?? null;
		},
		close: () => sql.end(),
	};
}

export async function migrateDirectoryStore(
	databaseUrl: string,
	migration: string,
): Promise<void> {
	const sql = postgres(databaseUrl, { max: 1 });
	try {
		await sql.unsafe(migration);
	} finally {
		await sql.end();
	}
}
