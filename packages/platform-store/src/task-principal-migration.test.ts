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
	(entry) => entry.tag === "0032_typed_task_principal",
)?.when;
if (checkpointMillis === undefined)
	throw new Error("Missing typed Task upgrade checkpoint");
const checkpoint = checkpointMillis;
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("typed-task-principal-migration");
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
	await sql`create table platform_migrations.history (id serial primary key,hash text not null,created_at bigint)`;
	for (const migration of migrations.filter(
		(migration) => migration.folderMillis < checkpoint,
	)) {
		for (const statement of migration.sql) await sql.unsafe(statement);
		await sql`insert into platform_migrations.history(hash,created_at) values(${migration.hash},${migration.folderMillis})`;
	}
}
async function conversation(channel = "web") {
	await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,last_conversation_cursor) values('conversation','agent','same-id',${channel},'ready',1,'agent-1',1)`;
}
async function execution() {
	await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,last_event_sequence,created_at) values('execution','conversation','agent','same-id','web','turn','completed',1,1,'agent-1',1,'2026-01-01T00:00:00Z')`;
}
describe("0032 typed Task principal upgrade", () => {
	it("preserves legacy IDs, terminal state, events, cursor and idempotency through the real migrator", async () => {
		await legacy();
		await conversation();
		await execution();
		await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source) values('event','conversation','execution','adapter',1,1,'text.delta',${sql.json({ type: "text.delta", text: "legacy output" })},${"a".repeat(64)},'legacy-runtime',now(),'runtime')`;
		await sql`insert into platform.idempotency_records(id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result) values('idempotency','conversation','conversation','same-id','message','legacy-key',${"b".repeat(64)},'completed',${sql.json({ schemaVersion: 1, status: "accepted", conversationId: "conversation", executionId: "execution", messageId: "message" })})`;
		const idempotencyBefore =
			await sql`select * from platform.idempotency_records`;
		const before =
			await sql`select id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,last_conversation_cursor from platform.conversations`;
		const executionBefore =
			await sql`select execution_id,turn_id,status,session_generation,delivery_fence,last_event_sequence from platform.conversation_executions`;
		const eventsBefore = await sql`select * from platform.conversation_events`;
		const historyBefore =
			await sql`select hash,created_at from platform_migrations.history order by created_at`;
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		expect(
			await sql`select id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,last_conversation_cursor from platform.conversations`,
		).toEqual(before);
		expect(
			await sql`select execution_id,turn_id,status,session_generation,delivery_fence,last_event_sequence from platform.conversation_executions`,
		).toEqual(executionBefore);
		expect(await sql`select * from platform.idempotency_records`).toEqual(
			idempotencyBefore,
		);
		expect(await sql`select * from platform.conversation_events`).toEqual(
			eventsBefore,
		);
		expect(
			await sql`select principal_type from platform.conversations`,
		).toMatchObject([{ principal_type: "user" }]);
		expect(
			await sql`select principal_type from platform.conversation_executions`,
		).toMatchObject([{ principal_type: "user" }]);
		const historyAfter =
			await sql`select hash,created_at from platform_migrations.history order by created_at`;
		expect(historyAfter.slice(0, historyBefore.length)).toEqual(historyBefore);
		expect(historyAfter).toHaveLength(migrations.length);
	});
	it("refuses legacy application-channel rows without guessing a principal and rolls back the upgrade", async () => {
		await legacy();
		await conversation("api:application");
		const history =
			await sql`select hash,created_at from platform_migrations.history order by created_at`;
		await expect(
			migratePlatformDatabase({ databaseUrl: database.databaseUrl }),
		).rejects.toThrow("Platform migration failed");
		expect(
			await sql`select hash,created_at from platform_migrations.history order by created_at`,
		).toEqual(history);
		expect(
			await sql`select column_name from information_schema.columns where table_schema='platform' and table_name='conversations' and column_name='principal_type'`,
		).toHaveLength(0);
		expect(
			await sql`select id,actor_id,channel_id from platform.conversations`,
		).toMatchObject([
			{
				id: "conversation",
				actor_id: "same-id",
				channel_id: "api:application",
			},
		]);
	});
	it.each(["actor", "agent", "channel", "kind"] as const)(
		"rejects %s mismatch in the durable C/E FK",
		async (field) => {
			await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
			await conversation("api");
			await expect(
				sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,principal_type,channel_id,turn_id,status,session_generation,authorization_revision,created_at) values('execution','conversation',${field === "agent" ? "other-agent" : "agent"},${field === "actor" ? "other-id" : "same-id"},${field === "kind" ? "application" : "user"},${field === "channel" ? "api:user" : "api"},'turn','completed',1,'agent-1','2026-01-01T00:00:00Z')`,
			).rejects.toMatchObject({
				constraint_name: "conversation_execution_principal_binding_fk",
			});
			expect(
				await sql`select execution_id from platform.conversation_executions`,
			).toHaveLength(0);
		},
	);
	it.each([
		{ kind: "application", channel: "web" },
		{ kind: "user", channel: "api:application" },
		{ kind: "unknown", channel: "api" },
	])("rejects principal/channel $kind/$channel", async ({ kind, channel }) => {
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		await expect(
			sql`insert into platform.conversations(id,agent_id,actor_id,principal_type,channel_id,status,session_generation,authorization_revision) values('conversation','agent','same-id',${kind},${channel},'ready',1,'agent-1')`,
		).rejects.toMatchObject({
			constraint_name: "conversation_principal_type_valid",
		});
	});
	it("retains valid waiting metadata at terminality and rejects invalid wait bindings", async () => {
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		await conversation("api");
		const insert = (order: number | null, deadline: Date | null) =>
			sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,task_wait_order,task_wait_deadline,created_at) values('execution','conversation','agent','same-id','api','turn','waiting',1,'agent-1',${order},${deadline},'2026-01-01T00:00:00Z')`;
		for (const [order, deadline] of [
			[null, null],
			[0, new Date("2026-01-02")],
			[1, null],
			[1, new Date("2025-12-31")],
		] as const)
			await expect(insert(order, deadline)).rejects.toMatchObject({
				constraint_name: "conversation_execution_task_wait_binding",
			});
		await insert(1, new Date("2026-01-02"));
		await sql`update platform.conversation_executions set status='cancelled' where execution_id='execution'`;
		expect(
			await sql`select status,task_wait_order::text as wait_order,task_wait_deadline from platform.conversation_executions`,
		).toMatchObject([
			{
				status: "cancelled",
				wait_order: "1",
				task_wait_deadline: new Date("2026-01-02"),
			},
		]);
	});
});
