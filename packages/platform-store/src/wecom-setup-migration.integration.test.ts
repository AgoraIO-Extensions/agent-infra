import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

for (const nextMigration of [
	"0022_wecom_application_setup",
	"0023_wecom_replacement_probe",
])
	it(`upgrades a Platform database through ${nextMigration}`, async () => {
		const folder = resolve(import.meta.dirname, "../../../migrations/platform");
		const journal = JSON.parse(
			await readFile(join(folder, "meta/_journal.json"), "utf8"),
		) as { entries: { tag: string }[] };
		const index = journal.entries.findIndex(
			(entry) => entry.tag === nextMigration,
		);
		if (index < 1) throw new Error(`Migration ${nextMigration} is missing`);
		const previous = journal.entries.slice(0, index);
		const temporary = await mkdtemp(join(tmpdir(), "wecom-setup-migrations-"));
		const db = await startPostgresTestDatabase("wecom-upgrade");
		const sql = postgres(db.databaseUrl, { max: 1 });
		try {
			await mkdir(join(temporary, "meta"));
			await writeFile(
				join(temporary, "meta/_journal.json"),
				JSON.stringify({ ...journal, entries: previous }),
			);
			for (const entry of previous)
				await copyFile(
					join(folder, `${entry.tag}.sql`),
					join(temporary, `${entry.tag}.sql`),
				);
			await migrate(drizzle(sql), {
				migrationsFolder: temporary,
				migrationsSchema: "platform_migrations",
				migrationsTable: "history",
			});
			const columns = async () =>
				(
					await sql<
						{ column_name: string }[]
					>`select column_name from information_schema.columns where table_schema='platform' and table_name='wecom_setup_sessions'`
				).map((row) => row.column_name);
			expect((await columns()).includes("callback_verified_at")).toBe(
				nextMigration === "0023_wecom_replacement_probe",
			);
			expect(await columns()).not.toContain("bot_verified_at");
			await migratePlatformDatabase(db);
			expect(await columns()).toEqual(
				expect.arrayContaining([
					"kind",
					"application",
					"encrypted_callback",
					"callback_verified_at",
					"probe_holder_id",
					"probe_fence",
					"probe_lease_until",
					"bot_verified_at",
				]),
			);
			const [history] = await sql<
				{ count: string }[]
			>`select count(*)::text as count from platform_migrations.history`;
			expect(Number(history?.count)).toBe(journal.entries.length);
		} finally {
			await sql.end();
			await db.stop();
			await rm(temporary, { recursive: true, force: true });
		}
	}, 30000);
