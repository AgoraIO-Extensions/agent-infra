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
		await migrateDatabase(sql, migrationsDirectory);
	} finally {
		await sql.end();
	}
}
