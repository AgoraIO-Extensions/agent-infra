import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import { startPostgresTestDatabase } from "./postgres-test.js";

it.each(["lock", "build", "remaining-transaction"] as const)(
	"rolls back the outbox index and history on %s expiry and allows retry",
	async (fault) => {
		const db = await startPostgresTestDatabase("outbox-index-budget");
		const sql = postgres(db.databaseUrl, { max: 1 });
		const blocker = postgres(db.databaseUrl, { max: 1 });
		const folder = await mkdtemp(join(tmpdir(), "outbox-index-budget-"));
		let release: (() => void) | undefined;
		let holding: Promise<unknown> | undefined;
		try {
			await cp(
				resolve(import.meta.dirname, "../../../migrations/platform"),
				folder,
				{ recursive: true },
			);
			const journalFile = join(folder, "meta/_journal.json");
			const journal = JSON.parse(await readFile(journalFile, "utf8"));
			const target = journal.entries.find((entry: { tag: string }) =>
				entry.tag.endsWith("_operations_outbox_scope"),
			);
			expect(target).toBeDefined();
			await writeFile(
				journalFile,
				JSON.stringify({
					...journal,
					entries: journal.entries.filter(
						(entry: { idx: number }) => entry.idx < target.idx,
					),
				}),
			);
			await migratePlatformDatabase({
				databaseUrl: db.databaseUrl,
				migrationsFolder: folder,
			});
			const baseline =
				await sql`select * from platform_migrations.history order by id`;
			await sql`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id)
				select n::text,'conversation',n::text,'conversation.sandbox.reconcile.v1','{}','fixture'
				from generate_series(1,443) n`;
			const targetFile = join(folder, `${target.tag}.sql`);
			const original = await readFile(targetFile, "utf8");
			const marker =
				"create table platform.outbox_budget_marker(id integer);\n--> statement-breakpoint\n";
			await writeFile(targetFile, marker + original);
			if (fault === "build") {
				await sql`create function platform.outbox_slow_index(value text) returns text
					language plpgsql immutable as $$ begin perform pg_sleep(2); return value; end $$`;
				await writeFile(
					targetFile,
					marker +
						original.replace(
							'("scope_type","scope_id","operation","id")',
							'((platform.outbox_slow_index("id")))',
						),
				);
			} else if (fault === "remaining-transaction") {
				await writeFile(
					targetFile,
					marker +
						original +
						"\n--> statement-breakpoint\n" +
						Array(4)
							.fill("select pg_sleep(0.75);")
							.join("\n--> statement-breakpoint\n"),
				);
			} else {
				let locked!: () => void;
				const ready = new Promise<void>((resolve) => {
					locked = resolve;
				});
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				holding = blocker.begin(async (tx) => {
					await tx`lock table platform.outbox_items in row exclusive mode`;
					locked();
					await gate;
				});
				await ready;
			}
			await writeFile(journalFile, JSON.stringify(journal));
			const started = Date.now();
			await expect(
				migratePlatformDatabase({
					databaseUrl: db.databaseUrl,
					migrationsFolder: folder,
				}),
			).rejects.toThrow("Platform migration failed");
			expect(Date.now() - started).toBeLessThan(5000);
			expect(
				await sql`select * from platform_migrations.history order by id`,
			).toEqual(baseline);
			expect(
				await sql`select to_regclass('platform.outbox_scope_operation_idx') as index`,
			).toEqual([{ index: null }]);
			expect(
				await sql`select to_regclass('platform.outbox_budget_marker') as marker`,
			).toEqual([{ marker: null }]);
			release?.();
			await holding;
			await writeFile(targetFile, original);
			await migratePlatformDatabase({
				databaseUrl: db.databaseUrl,
				migrationsFolder: folder,
			});
			const [index] = await sql`select indisvalid from pg_index
				where indexrelid='platform.outbox_scope_operation_idx'::regclass`;
			expect(index?.indisvalid).toBe(true);
			const completedHistory =
				await sql`select * from platform_migrations.history order by id`;
			expect(completedHistory).toHaveLength(journal.entries.length);
			expect(completedHistory.slice(0, baseline.length)).toEqual(baseline);
		} finally {
			release?.();
			await holding;
			await blocker.end();
			await sql.end();
			await db.stop();
			await rm(folder, { recursive: true, force: true });
		}
	},
	120000,
);
