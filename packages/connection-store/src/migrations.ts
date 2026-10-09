import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

/** Applies versioned Connection migrations through Drizzle's PostgreSQL migrator. */
export async function migrateDatabase(sql: Sql, migrationsDirectory: string) {
	await migrate(drizzle(sql), { migrationsFolder: migrationsDirectory });
}

/** Opens a short-lived Connection-owned database client only to run migrations. */
export async function migrateConnectionDatabase(
	databaseUrl: string,
	migrationsDirectory: string,
) {
	const sql = postgres(databaseUrl);
	try {
		const expected = readMigrationFiles({
			migrationsFolder: migrationsDirectory,
		}).map((migration) => migration.hash);
		const [existing] = await sql<
			{ present: string | null }[]
		>`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS present`;
		if (existing?.present) {
			const previous = await sql<
				{ hash: string }[]
			>`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id`;
			if (
				previous.length > expected.length ||
				previous.some((row, index) => row.hash !== expected[index])
			)
				throw new Error("Existing migration ledger is not a committed prefix");
		}
		await migrateDatabase(sql, migrationsDirectory);
		const rows = await sql<
			{ hash: string }[]
		>`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id`;
		if (
			rows.length !== expected.length ||
			expected.some((hash) => !rows.some((row) => row.hash === hash))
		)
			throw new Error(
				"Committed migration hashes do not match the database ledger",
			);
		return { migrationReceiptVersion: 1 as const, hashes: expected };
	} finally {
		await sql.end();
	}
}
