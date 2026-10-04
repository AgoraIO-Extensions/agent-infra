import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

const migrationsFolder = resolve(
	import.meta.dirname,
	"../../../migrations/platform",
);
const migrations = readMigrationFiles({ migrationsFolder });
const journal = JSON.parse(
	readFileSync(resolve(migrationsFolder, "meta/_journal.json"), "utf8"),
) as { entries: { tag: string; when: number }[] };
const checkpointMillis = journal.entries.find(
	(entry) => entry.tag === "0034_task_status_event_source",
)?.when;
if (checkpointMillis === undefined)
	throw new Error("Missing Task status upgrade checkpoint");
const checkpoint = checkpointMillis;
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("task-status-migration");
	sql = postgres(database.databaseUrl, { max: 1 });
}, 120_000);
beforeEach(async () => {
	await sql`drop schema if exists platform cascade`;
	await sql`drop schema if exists platform_migrations cascade`;
});
afterAll(async () => {
	await sql?.end();
	await database?.stop();
});
async function legacy() {
	await sql`create schema platform_migrations`;
	await sql`create table platform_migrations.history (id serial primary key, hash text not null, created_at bigint)`;
	for (const migration of migrations.filter(
		(migration) => migration.folderMillis < checkpoint,
	)) {
		for (const statement of migration.sql) await sql.unsafe(statement);
		await sql`insert into platform_migrations.history (hash, created_at) values (${migration.hash}, ${migration.folderMillis})`;
	}
	await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values('conversation','agent','user','web','ready',1,'authorization')`;
	await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at) values('execution','conversation','agent','user','web','turn','completed',1,'authorization','2026-01-01T00:00:00Z')`;
}
async function insert(
	id: string,
	source: string,
	type: string,
	runtimeCursor: string | null,
	sequence = 1,
) {
	return sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source) values(${id},'conversation','execution',${id},${sequence},${sequence},${type},${sql.json({ type })},${"a".repeat(64)},${runtimeCursor},'2026-01-01T00:00:00Z',${source})`;
}
function rows() {
	return sql`select * from platform.conversation_events order by event_id`;
}
function history() {
	return sql`select id,hash,created_at from platform_migrations.history order by id`;
}
function constraints() {
	return sql`select conname,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='platform.conversation_events'::regclass order by conname`;
}
describe("0034 Task status source upgrade", () => {
	it("preserves runtime/fallback events and history, then admits only Platform status with NULL runtime cursor", async () => {
		await legacy();
		await insert("runtime", "runtime", "text.delta", "cursor-runtime");
		await insert("fallback", "platform", "model.selection.fell_back", null, 2);
		const before = await rows();
		const historyBefore = await history();
		const constraintsBefore = await constraints();
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		expect(await rows()).toEqual(before);
		const historyAfter = await history();
		expect(historyAfter.slice(0, historyBefore.length)).toEqual(historyBefore);
		expect(historyAfter.slice(historyBefore.length)).toMatchObject(
			migrations
				.filter((m) => m.folderMillis >= checkpoint)
				.map((m) => ({ hash: m.hash, created_at: String(m.folderMillis) })),
		);
		expect(
			(await constraints()).filter(
				(r) => r.conname !== "conversation_event_source_binding",
			),
		).toEqual(
			constraintsBefore.filter(
				(r) => r.conname !== "conversation_event_source_binding",
			),
		);
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		expect(await history()).toEqual(historyAfter);
		expect(await rows()).toEqual(before);
		await insert("status", "platform", "task.status", null, 3);
		expect(
			await sql`select event_type,source,runtime_cursor from platform.conversation_events where event_id='status'`,
		).toEqual([
			{ event_type: "task.status", source: "platform", runtime_cursor: null },
		]);
		const status = await rows();
		for (const [source, type, cursor] of [
			["runtime", "task.status", "valid-runtime-cursor"],
			["runtime", "model.selection.fell_back", "valid-runtime-cursor"],
			["platform", "text.delta", null],
			["platform", "task.status", "forged-runtime-cursor"],
			["runtime", "text.delta", ""],
			["runtime", "text.delta", null],
		] as const) {
			await expect(
				sql`update platform.conversation_events set source=${source},event_type=${type},runtime_cursor=${cursor} where event_id='status'`,
			).rejects.toMatchObject({
				constraint_name: "conversation_event_source_binding",
			});
			expect(await rows()).toEqual(status);
		}
	});
	it("refuses historical Runtime task.status and rolls back DDL/history/data", async () => {
		await legacy();
		await insert(
			"historical",
			"runtime",
			"task.status",
			"valid-runtime-cursor",
		);
		const before = await rows();
		const historyBefore = await history();
		const constraintsBefore = await constraints();
		await expect(
			migratePlatformDatabase({ databaseUrl: database.databaseUrl }),
		).rejects.toThrow("Platform migration failed");
		expect(await rows()).toEqual(before);
		expect(await history()).toEqual(historyBefore);
		expect(await constraints()).toEqual(constraintsBefore);
	});
});
