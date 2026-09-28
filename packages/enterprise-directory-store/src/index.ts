import type { DirectoryStore } from "@agent-infra/enterprise-directory";
import {
	fromDirectorySnapshotV1,
	toDirectorySnapshotV1,
} from "@agent-infra/enterprise-directory";
import { desc, sql as drizzleSql } from "drizzle-orm";
import { bigint, jsonb, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const directorySchema = pgSchema("enterprise_directory");
const snapshots = directorySchema.table("snapshots", {
	revision: uuid("revision").primaryKey(),
	generation: bigint("generation", { mode: "bigint" }),
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
		async beginScan() {
			const rows = await sql`
				SELECT nextval('enterprise_directory.scan_generation') AS generation
			`;
			const value = rows[0]?.generation;
			if (value === undefined)
				throw new Error("Directory scan generation unavailable");
			return BigInt(value);
		},
		async publish(value, generation) {
			if (generation < 1n) throw new Error("Invalid directory scan generation");
			const snapshot = toDirectorySnapshotV1(value);
			return sql.begin(async (transaction) => {
				await transaction`
					SELECT pg_catalog.pg_advisory_xact_lock(
						pg_catalog.hashtextextended('agent-infra:enterprise-directory:publish', 0)
					)
				`;
				const rows = await transaction`
					SELECT generation FROM enterprise_directory.snapshots
					WHERE generation IS NOT NULL
					ORDER BY generation DESC LIMIT 1
				`;
				if (rows[0] && BigInt(rows[0].generation) >= generation)
					return "superseded" as const;
				await transaction`
					INSERT INTO enterprise_directory.snapshots
						(revision, generation, fetched_at, valid_until, contents)
					VALUES (
						${snapshot.revision}, ${generation.toString()},
						${new Date(snapshot.fetchedAt).toISOString()}::timestamptz,
						${new Date(snapshot.validUntil).toISOString()}::timestamptz,
						${JSON.stringify(snapshot)}::jsonb
					)
				`;
				return "published" as const;
			});
		},
		async latest() {
			const rows = await db
				.select({ contents: snapshots.contents })
				.from(snapshots)
				.orderBy(
					drizzleSql`${snapshots.generation} DESC NULLS LAST`,
					desc(snapshots.fetchedAt),
					desc(snapshots.revision),
				)
				.limit(1);
			return rows[0] ? fromDirectorySnapshotV1(rows[0].contents) : null;
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
		await sql`GRANT USAGE ON SEQUENCE enterprise_directory.scan_generation TO ${sql(runtimeRole)}`;
	} finally {
		await sql.end();
	}
}
