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
) as {
	entries: { tag: string; when: number }[];
};
const checkpointMillis = journal.entries.find(
	(entry) => entry.tag === "0033_typed_generation_principal",
)?.when;
if (checkpointMillis === undefined)
	throw new Error("Missing typed generation upgrade checkpoint");
const checkpoint = checkpointMillis;
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("typed-generation-migration");
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
}
async function execution(
	suffix: string,
	kind: "user" | "application" = "user",
) {
	const channel = kind === "application" ? "api:application" : "web";
	await sql`insert into platform.conversations (id, agent_id, actor_id, principal_type, channel_id, status, session_generation, authorization_revision) values (${`conversation-${suffix}`}, 'agent', 'same-id', ${kind}, ${channel}, 'ready', 1, 'agent-1')`;
	await sql`insert into platform.conversation_executions (execution_id, conversation_id, agent_id, actor_id, principal_type, channel_id, turn_id, status, session_generation, authorization_revision, created_at) values (${`execution-${suffix}`}, ${`conversation-${suffix}`}, 'agent', 'same-id', ${kind}, ${channel}, ${`turn-${suffix}`}, 'completed', 1, 'agent-1', '2026-01-01T00:00:00Z')`;
	await sql`insert into platform.task_authorization_records (id, execution_id, boundary) values (${`authorization-${suffix}`}, ${`execution-${suffix}`}, ${sql.json({ schemaVersion: 1 })})`;
	await sql`insert into platform.task_control_records (id, execution_id, authorization_record_id, reason) values (${`control-${suffix}`}, ${`execution-${suffix}`}, ${`authorization-${suffix}`}, 'generation_isolation')`;
}
function tombstone(
	suffix: string,
	principal: postgres.JSONValue,
	operationId = `operation-${suffix}`,
) {
	return sql`insert into platform.conversation_generation_tombstones (operation_id, conversation_id, session_generation, execution_id, item_id, control_record_id, control_source_id, original_principal, host_session_ref, failure_code) values (${operationId}, ${`conversation-${suffix}`}, 1, ${`execution-${suffix}`}, ${`item-${suffix}`}, ${`control-${suffix}`}, ${`source-${suffix}`}, ${sql.json(principal)}, ${`host-${suffix}`}, 'RUNTIME_SESSION_RECOVERY_FAILED')`;
}
function history() {
	return sql`select id, hash, created_at from platform_migrations.history order by id`;
}
function otherConstraints() {
	return sql`select conname, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'platform.conversation_generation_tombstones'::regclass and conname <> 'conversation_generation_tombstone_principal_valid' order by conname`;
}

describe("0033 typed generation tombstone upgrade", () => {
	it("preserves both legacy user statuses, every binding and old history through the real migrator", async () => {
		await legacy();
		for (const suffix of ["pending", "confirmed"]) {
			await execution(suffix);
			await tombstone(suffix, { kind: "user", id: "same-id" });
		}
		await sql`update platform.conversation_generation_tombstones set status = 'confirmed', confirmed_at = '2026-01-01T00:00:00Z' where operation_id = 'operation-confirmed'`;
		const before =
			await sql`select *, original_principal::text as principal_bytes from platform.conversation_generation_tombstones order by operation_id`;
		const executionsBefore =
			await sql`select * from platform.conversation_executions order by execution_id`;
		const controlsBefore =
			await sql`select * from platform.task_control_records order by id`;
		const historyBefore = await history();
		const constraintsBefore = await otherConstraints();
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		expect(
			await sql`select *, original_principal::text as principal_bytes from platform.conversation_generation_tombstones order by operation_id`,
		).toEqual(before);
		expect(
			await sql`select * from platform.conversation_executions order by execution_id`,
		).toEqual(executionsBefore.map((row) => ({ ...row, sandbox_id: null })));
		expect(
			await sql`select * from platform.task_control_records order by id`,
		).toEqual(controlsBefore);
		expect(await otherConstraints()).toEqual(constraintsBefore);
		const historyAfter = await history();
		expect(historyAfter.slice(0, historyBefore.length)).toEqual(historyBefore);
		expect(historyAfter.slice(historyBefore.length)).toMatchObject(
			migrations
				.filter((migration) => migration.folderMillis >= checkpoint)
				.map((migration) => ({
					hash: migration.hash,
					created_at: String(migration.folderMillis),
				})),
		);
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		expect(await history()).toEqual(historyAfter);
		expect(
			await sql`select *, original_principal::text as principal_bytes from platform.conversation_generation_tombstones order by operation_id`,
		).toEqual(before);
	});
	it("admits an application tombstone and rejects malformed JSON without changing the original row", async () => {
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		await execution("application", "application");
		await tombstone("application", { kind: "application", id: "same-id" });
		const before =
			await sql`select * from platform.conversation_generation_tombstones`;
		expect(before).toHaveLength(1);
		expect(before[0]?.original_principal).toEqual({
			kind: "application",
			id: "same-id",
		});
		for (const principal of [
			{ kind: "unknown", id: "same-id" },
			{ id: "same-id" },
			{ kind: "application" },
			{ kind: "user", id: null },
			{ kind: "application", id: 42 },
			{ kind: "user", id: "" },
			null,
			[],
		]) {
			const rejection = sql`update platform.conversation_generation_tombstones set original_principal = ${sql.json(principal)}`;
			if (principal === null) {
				await expect(
					rejection,
					JSON.stringify(principal),
				).rejects.toMatchObject({
					code: "23502",
					column_name: "original_principal",
				});
			} else {
				await expect(
					rejection,
					JSON.stringify(principal),
				).rejects.toMatchObject({
					constraint_name: "conversation_generation_tombstone_principal_valid",
				});
			}
			expect(
				await sql`select * from platform.conversation_generation_tombstones`,
			).toEqual(before);
		}
	});
	it("keeps the original execution/generation and control FKs and operation uniqueness", async () => {
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		await execution("original");
		await execution("other");
		await tombstone("original", { kind: "user", id: "same-id" });
		const before =
			await sql`select * from platform.conversation_generation_tombstones`;
		await expect(
			sql`update platform.conversation_generation_tombstones set conversation_id = 'conversation-other'`,
		).rejects.toMatchObject({
			constraint_name: "conversation_generation_execution_binding_fk",
		});
		await expect(
			sql`update platform.conversation_generation_tombstones set session_generation = 2`,
		).rejects.toMatchObject({
			constraint_name: "conversation_generation_execution_binding_fk",
		});
		await expect(
			sql`update platform.conversation_generation_tombstones set control_record_id = 'control-other'`,
		).rejects.toMatchObject({
			constraint_name: "conversation_generation_control_execution_fk",
		});
		await expect(
			tombstone("other", { kind: "user", id: "same-id" }, "operation-original"),
		).rejects.toMatchObject({ code: "23505" });
		expect(
			await sql`select * from platform.conversation_generation_tombstones`,
		).toEqual(before);
	});
	it.each([
		{ kind: "user", id: 42 },
		{ kind: "user", id: null },
		{ kind: "user" },
		{ id: "same-id" },
	])(
		"refuses malformed historical principal %j and rolls back DDL, data and history",
		async (principal) => {
			await legacy();
			await execution("legacy");
			await tombstone("legacy", principal);
			const before =
				await sql`select * from platform.conversation_generation_tombstones`;
			const historyBefore = await history();
			const checkBefore =
				await sql`select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'platform.conversation_generation_tombstones'::regclass and conname = 'conversation_generation_tombstone_principal_valid'`;
			await expect(
				migratePlatformDatabase({ databaseUrl: database.databaseUrl }),
			).rejects.toThrow("Platform migration failed");
			expect(
				await sql`select * from platform.conversation_generation_tombstones`,
			).toEqual(before);
			expect(await history()).toEqual(historyBefore);
			expect(
				await sql`select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'platform.conversation_generation_tombstones'::regclass and conname = 'conversation_generation_tombstone_principal_valid'`,
			).toEqual(checkBefore);
		},
	);
});
