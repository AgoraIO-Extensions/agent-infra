import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { expect, it } from "vitest";
import { migrateConnectionDatabase } from "./migrations";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const url = process.env.CONNECTION_MIGRATION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(url, process.env.DATABASE_URL);
(url ? it : it.skip)(
	"emits exact native ledger receipts and rejects drift before migration",
	async () => {
		if (!url) return;
		const directory = resolve(
			import.meta.dirname,
			"../../../migrations/connection",
		);
		const expected = readMigrationFiles({ migrationsFolder: directory }).map(
			(migration) => migration.hash,
		);
		const first = await migrateConnectionDatabase(url, directory);
		expect(first).toEqual({ migrationReceiptVersion: 1, hashes: expected });
		expect(await migrateConnectionDatabase(url, directory)).toEqual(first);
		const sql = postgres(url);
		const [original] = await sql<
			{ id: number; hash: string }[]
		>`SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 1`;
		if (!original) throw new Error("Missing migration fixture");
		try {
			await sql`UPDATE drizzle.__drizzle_migrations SET hash = 'drift' WHERE id = ${original.id}`;
			await expect(migrateConnectionDatabase(url, directory)).rejects.toThrow(
				"not a committed prefix",
			);
			const [{ count } = { count: "0" }] = await sql<
				{ count: string }[]
			>`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`;
			expect(Number(count)).toBe(expected.length);
		} finally {
			await sql`UPDATE drizzle.__drizzle_migrations SET hash = ${original.hash} WHERE id = ${original.id}`;
			await sql.end();
		}
	},
);
