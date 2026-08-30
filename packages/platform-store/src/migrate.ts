import { basename, resolve } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export interface PlatformMigrationOptions {
	databaseUrl: string;
}

const defaultMigrationsFolder = resolve(
	import.meta.dirname,
	basename(import.meta.dirname) === "src"
		? "../../../migrations/platform"
		: "migrations",
);

export function platformDatabaseUrlFromEnvironment(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const databaseUrl = environment.PLATFORM_DATABASE_URL;
	if (!databaseUrl) throw new Error("PLATFORM_DATABASE_URL is required");
	let protocol: string;
	try {
		protocol = new URL(databaseUrl).protocol;
	} catch {
		throw new Error("PLATFORM_DATABASE_URL must be a PostgreSQL URL");
	}
	if (protocol !== "postgres:" && protocol !== "postgresql:") {
		throw new Error("PLATFORM_DATABASE_URL must be a PostgreSQL URL");
	}
	return databaseUrl;
}

export async function migratePlatformDatabase({
	databaseUrl,
}: PlatformMigrationOptions): Promise<void> {
	// Keep the session lock and every migration statement on one connection.
	const client = postgres(databaseUrl, { max: 1 });
	try {
		await client`
			select pg_catalog.pg_advisory_lock(
				pg_catalog.hashtextextended('agent-infra:platform:migrations', 0)
			)
		`;
		await migrate(drizzle(client), {
			migrationsFolder: defaultMigrationsFolder,
			migrationsSchema: "platform_migrations",
			migrationsTable: "history",
		});
	} finally {
		await client.end();
	}
}
