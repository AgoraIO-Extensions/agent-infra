import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export function connectionDatabaseUrlFromEnvironment(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const databaseUrl = environment.CONNECTION_DATABASE_URL;
	if (!databaseUrl) throw new Error("CONNECTION_DATABASE_URL is required");
	let protocol: string;
	try {
		protocol = new URL(databaseUrl).protocol;
	} catch {
		throw new Error("CONNECTION_DATABASE_URL must be a PostgreSQL URL");
	}
	if (protocol !== "postgres:" && protocol !== "postgresql:")
		throw new Error("CONNECTION_DATABASE_URL must be a PostgreSQL URL");
	return databaseUrl;
}

// The package is built into `packages/connection-store/dist`, while the
// migration authority remains at the repository root. Keep the runtime path
// identical for source and built execution so a successful build cannot hide
// a missing migration directory.
const defaultMigrationsFolder = resolve(
	import.meta.dirname,
	"../../../migrations/connection",
);

export async function migrateConnectionDatabase(
	databaseUrl: string,
): Promise<void> {
	const client = postgres(databaseUrl, { max: 1 });
	try {
		await client`select pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended('agent-infra:connection:migrations', 0))`;
		await migrate(drizzle(client), {
			migrationsFolder: defaultMigrationsFolder,
			migrationsSchema: "connection_migrations",
			migrationsTable: "history",
		});
	} finally {
		await client.end();
	}
}
