import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let legacy: string;
async function execution(status = "unknown") {
	const id = randomUUID();
	await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision)values(${id},'agent','user','web','active',1,'auth')`;
	await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,created_at)values(${id},${id},'agent','user','web',${id},${status},1,1,'auth',clock_timestamp())`;
	return id;
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("evaluation-terminal-time");
	sql = postgres(database.databaseUrl, { max: 2 });
	const previous = await mkdtemp(join(tmpdir(), "evaluation-terminal-before-"));
	try {
		await cp(
			resolve(import.meta.dirname, "../../../migrations/platform"),
			previous,
			{ recursive: true },
		);
		const journalPath = join(previous, "meta/_journal.json");
		const journal = JSON.parse(await readFile(journalPath, "utf8"));
		journal.entries = journal.entries.filter(
			(v: { idx: number }) => v.idx < 71,
		);
		await writeFile(journalPath, JSON.stringify(journal));
		await migratePlatformDatabase({ ...database, migrationsFolder: previous });
		legacy = await execution("completed");
		await migratePlatformDatabase(database);
	} finally {
		await rm(previous, { recursive: true, force: true });
	}
}, 120000);
afterAll(async () => {
	await sql?.end();
	await database?.stop();
});
async function time(id: string) {
	const [row] =
		await sql`select terminal_observed_at from platform.conversation_executions where execution_id=${id}`;
	return row?.terminal_observed_at as Date | null;
}
it("does not invent a timestamp for legacy terminal rows or accept caller supplied terminal timestamps", async () => {
	expect(await time(legacy)).toBeNull();
	await sql`update platform.conversation_executions set status='completed',terminal_observed_at='2001-01-01' where execution_id=${legacy}`;
	expect(await time(legacy)).toBeNull();
	const id = await execution();
	await sql`update platform.conversation_executions set terminal_observed_at='2001-01-01' where execution_id=${id}`;
	expect(await time(id)).toBeNull();
});
it.each(["completed", "failed", "cancelled"])(
	"observes %s in the original transaction even without a terminal event",
	async (status) => {
		const id = await execution();
		const [before] = await sql`select clock_timestamp() as now`;
		await sql`update platform.conversation_executions set status=${status},terminal_observed_at='2001-01-01' where execution_id=${id}`;
		const first = await time(id);
		expect(first).toBeInstanceOf(Date);
		expect(Number(first)).toBeGreaterThanOrEqual(Number(before?.now));
		expect(
			await sql`select event_id from platform.conversation_events where execution_id=${id}`,
		).toHaveLength(0);
		await sql`update platform.conversation_executions set status=${status},updated_at=clock_timestamp(),last_event_sequence=last_event_sequence+1,terminal_observed_at=clock_timestamp() where execution_id=${id}`;
		expect(await time(id)).toEqual(first);
	},
);
it("rolls terminal observation back with the business transition", async () => {
	const id = await execution();
	await expect(
		sql.begin(async (tx) => {
			await tx`update platform.conversation_executions set status='failed' where execution_id=${id}`;
			throw new Error("synthetic rollback");
		}),
	).rejects.toThrow("synthetic rollback");
	expect(await time(id)).toBeNull();
	await sql`update platform.conversation_executions set status='completed' where execution_id=${id}`;
	expect(await time(id)).toBeInstanceOf(Date);
});
