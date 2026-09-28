import type { DirectoryStore } from "@agent-infra/enterprise-directory";
import { validateSnapshot } from "@agent-infra/enterprise-directory";
import { desc } from "drizzle-orm";
import { jsonb, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
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
	migrationsFolder: string,
	runtimeRole: string,
): Promise<void> {
	if (
		!/^[a-z_][a-z0-9_]{0,62}$/u.test(runtimeRole) ||
		runtimeRole === decodeURIComponent(new URL(databaseUrl).username)
	)
		throw new Error("DIRECTORY_RUNTIME_DATABASE_ROLE is invalid");
	const sql = postgres(databaseUrl, { max: 1 });
	try {
		await sql`
			select pg_catalog.pg_advisory_lock(
				pg_catalog.hashtextextended('agent-infra:enterprise-directory:migrations', 0)
			)
		`;
		await migrate(drizzle(sql), {
			migrationsFolder,
			migrationsSchema: "enterprise_directory_migrations",
			migrationsTable: "history",
		});
		await sql`GRANT USAGE ON SCHEMA enterprise_directory TO ${sql(runtimeRole)}`;
		await sql`GRANT SELECT, INSERT ON TABLE enterprise_directory.snapshots TO ${sql(runtimeRole)}`;
	} finally {
		await sql.end();
	}
}
