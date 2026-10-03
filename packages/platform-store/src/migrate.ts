import { basename, resolve } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";

export interface PlatformMigrationOptions {
	databaseUrl: string;
	migrationsFolder?: string;
}

// Recognize the immutable historical Task checkpoint without executing absent
// files or manufacturing history. Only the current journal publishes SQL.
const historicalMigrations = new Map([
	[
		1790724094107,
		"8d80ac3030f300f0ed93ba3692a74c67f337921c0d4d95447e13fd4f535b82b0",
	],
	[
		1790724095107,
		"714286ee36c08852ec532462e180ab83539af6b7619eed38c8f37e0d0ee665f7",
	],
	[
		1790738152673,
		"c8c44572a4a2d9a659b302646612d6d885a320fff5ed7b8f0cd38752405c8863",
	],
	[
		1790746349762,
		"cbf753db9b8040f111e0599682aef0150bc20eb84225d4ad95b335dfb3417644",
	],
]);

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
	migrationsFolder = defaultMigrationsFolder,
}: PlatformMigrationOptions): Promise<void> {
	// Keep the session lock and every migration statement on one connection.
	const client = postgres(databaseUrl, { max: 1 });
	try {
		const migrations = readMigrationFiles({ migrationsFolder });
		const sources = new Map<number, string>();
		for (const migration of migrations) {
			const historicalWhen = [...historicalMigrations].find(
				([, hash]) => hash === migration.hash,
			)?.[0];
			if (
				!Number.isSafeInteger(migration.folderMillis) ||
				migration.folderMillis <= 0 ||
				sources.has(migration.folderMillis) ||
				(historicalWhen !== undefined &&
					historicalWhen !== migration.folderMillis) ||
				(historicalMigrations.has(migration.folderMillis) &&
					historicalMigrations.get(migration.folderMillis) !== migration.hash)
			) {
				throw new Error("Invalid Platform migration source");
			}
			sources.set(migration.folderMillis, migration.hash);
		}
		await client`
			select pg_catalog.pg_advisory_lock(
				pg_catalog.hashtextextended('agent-infra:platform:migrations', 0)
			)
		`;
		await client.begin(async (transaction) => {
			await transaction`create schema if not exists platform_migrations`;
			await transaction`create table if not exists platform_migrations.history
				(id serial primary key, hash text not null, created_at bigint)`;
			const history = await transaction<
				{ hash: string; created_at: string | number | null }[]
			>`select hash, created_at from platform_migrations.history order by id`;
			const applied = new Set<number>();
			let latest = 0;
			for (const row of history) {
				const when = Number(row.created_at);
				if (
					!Number.isSafeInteger(when) ||
					when <= 0 ||
					applied.has(when) ||
					(sources.get(when) ?? historicalMigrations.get(when)) !== row.hash
				) {
					throw new Error("Invalid Platform migration history");
				}
				applied.add(when);
				latest = Math.max(latest, when);
			}
			const missing = migrations.filter(
				(migration) => !applied.has(migration.folderMillis),
			);
			// Only the four retained migrations may fill a hole below the current
			// checkpoint. A missing earlier foundation is not safe to replay.
			if (
				missing.some(
					(migration) =>
						migration.folderMillis < latest &&
						!historicalMigrations.has(migration.folderMillis),
				)
			) {
				throw new Error("Invalid Platform migration history");
			}
			for (const migration of missing) {
				for (const statement of migration.sql) {
					await transaction.unsafe(statement);
				}
				await transaction`insert into platform_migrations.history (hash, created_at)
					values (${migration.hash}, ${migration.folderMillis})`;
			}
		});
	} catch {
		// PostgreSQL errors can include SQL values; do not expose them at startup.
		throw new Error("Platform migration failed");
	} finally {
		await client.end();
	}
}
