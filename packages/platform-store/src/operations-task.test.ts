import { OperationsScopeErrorV2 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import { PostgresOperationsTaskStoreV2 } from "./operations-task.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresOperationsTaskStoreV2;
const input = {
	agentId: "ops-agent",
	sessionId: "ops-session",
	start: "2026-11-01T00:00:05Z",
	end: "2026-11-01T00:02:00Z",
};

beforeAll(async () => {
	database = await startPostgresTestDatabase("operations-task");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl);
	store = new PostgresOperationsTaskStoreV2(
		database.databaseUrl,
		"ops-namespace",
	);
	await sql`insert into platform.agents (id,current_configuration_revision,authorization_revision)
		values ('ops-agent',1,'auth')`;
	await sql`insert into platform.conversations
		(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision)
		values ('ops-session','ops-agent','ops-actor','web','ready',1,'auth')`;
	await sql`insert into platform.session_sandbox_allocations
		(sandbox_id,conversation_id,agent_id,actor_id,channel_id,principal_type,session_generation,
		resource_name,workspace_scope,status,created_at,updated_at,resource_policy)
		values ('12345678-1234-1234-1234-123456789abc','ops-session','ops-agent','ops-actor','web','user',1,'sandbox-12345678-1234-1234-1234-123456789abc','12345678-1234-1234-1234-123456789abc',
		'ready',now(),now(),'{"namespace":"ops-namespace"}')`;
	// Keep a fixture with a terminal observation inside the historical window.
	await sql.begin(async (tx) => {
		await tx`alter table platform.conversation_executions disable trigger conversation_execution_terminal_observed_at`;
		await tx`insert into platform.conversation_executions
		(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,
		session_generation,authorization_revision,created_at,terminal_observed_at)
		values ('ops-run','ops-session','ops-agent','ops-actor','web','turn-1','failed',
		1,'auth','2026-11-01T00:00:00Z','2026-11-01T00:00:30Z')`;
		await tx`alter table platform.conversation_executions enable trigger conversation_execution_terminal_observed_at`;
	});
	await sql`insert into platform.outbox_items
		(id,scope_type,scope_id,operation,status,trace_id,payload)
		values ('conversation:turn:ops-run','conversation','ops-session',
		'conversation.turn.submit.v1','failed','trace-1','{"executionId":"ops-run","message":"private"}')`;
	await sql`insert into platform.persisted_events
		(event_id,stream_id,sequence,stream_cursor,event_type,payload,trace_id,occurred_at)
		values ('outbox-failure','outbox:conversation:turn:ops-run',1,1,'outbox.failed',
		'{"errorCode":"RUNTIME_RECOVERY_TIMEOUT","message":"private"}','trace-1','2026-11-01T00:00:29Z')`;
	for (const [sequence, type, timestamp, payload] of [
		[
			1,
			"execution.operation",
			"2026-11-01T00:00:02Z",
			{
				fact: {
					kind: "model",
					phase: "started",
					operationRef: "op-1",
					attemptRef: "try-1",
					startedAt: "2026-11-01T00:00:02Z",
				},
			},
		],
		[
			2,
			"execution.operation",
			"2026-11-01T00:00:08Z",
			{
				fact: {
					kind: "model",
					phase: "failed",
					operationRef: "op-1",
					attemptRef: "try-1",
					finishedAt: "2026-11-01T00:00:08Z",
					failureCode: "dependency_unavailable",
				},
			},
		],
		[3, "execution.status", "2026-11-01T00:00:09Z", { status: "unknown" }],
		[4, "execution.status", "2026-11-01T00:00:16Z", { status: "processing" }],
		[
			5,
			"conversation.error",
			"2026-11-01T00:00:18Z",
			{ code: "RUNTIME_FILE_INPUT_PRIVATE", message: "private" },
		],
		[
			6,
			"execution.operation",
			"2026-11-01T00:00:20Z",
			{
				fact: {
					kind: "tool",
					phase: "failed",
					operationRef: "op-2",
					attemptRef: "try-1",
					startedAt: "2026-11-01T00:00:10Z",
					finishedAt: "2026-11-01T00:00:20Z",
					failureCode: "operation_failed",
				},
			},
		],
	] as const) {
		const eventId = `fact-${sequence}`;
		await sql`insert into platform.conversation_events
			(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,
			event_payload,event_digest,runtime_cursor,occurred_at,source)
			values (${eventId},'ops-session','ops-run',${eventId},${sequence},${sequence},${type},
			${sql.json({ type, ...payload })},${"0".repeat(64)},${eventId},${timestamp},'runtime')`;
	}
	await sql`insert into platform.conversation_events
		(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,
		event_payload,event_digest,occurred_at,source)
		values ('queue-failure','ops-session','ops-run','queue-failure',7,7,'task.status',
		'{"type":"task.status","status":"failed","reason":"TASK_WAIT_TIMEOUT"}',
		${"0".repeat(64)},'2026-11-01T00:00:24Z','platform')`;
}, 120_000);

afterAll(async () => {
	await store?.close();
	await sql?.end();
	await database?.stop();
});

it("projects only bound task metadata and verified endpoint pairs", async () => {
	const result = await store.read(input, new AbortController().signal);
	expect(result).toMatchObject({
		state: "available",
		truncated: false,
		tasks: [
			{
				executionId: "ops-run",
				status: "failed",
				evidence: expect.arrayContaining([
					expect.objectContaining({
						stage: "model",
						errorCode: "dependency_unavailable",
						durationMs: 6000,
					}),
					expect.objectContaining({ stage: "verification", durationMs: 7000 }),
					expect.objectContaining({
						stage: "tool",
						errorCode: "operation_failed",
						durationMs: null,
						startedAt: null,
					}),
					expect.objectContaining({
						stage: "queue",
						errorCode: "TASK_WAIT_TIMEOUT",
					}),
					expect.objectContaining({
						stage: "dispatch",
						errorCode: "RUNTIME_RECOVERY_TIMEOUT",
					}),
					expect.objectContaining({ stage: "runtime", errorCode: null }),
					expect.objectContaining({
						stage: "result",
						finishedAt: "2026-11-01T00:00:30.000Z",
					}),
				]),
			},
		],
	});
	expect(JSON.stringify(result)).not.toMatch(/private|op-1|try-1/i);
	await expect(
		store.read(
			{ ...input, agentId: "another-agent" },
			new AbortController().signal,
		),
	).rejects.toThrow(OperationsScopeErrorV2);
	const outside = new PostgresOperationsTaskStoreV2(
		database.databaseUrl,
		"another-namespace",
	);
	try {
		await expect(
			outside.read(input, new AbortController().signal),
		).rejects.toThrow(OperationsScopeErrorV2);
	} finally {
		await outside.close();
	}
});

it("reports a completed empty query separately from cancellation", async () => {
	const empty = await store.read(
		{ ...input, start: "2026-11-01T01:00:00Z", end: "2026-11-01T02:00:00Z" },
		new AbortController().signal,
	);
	expect(empty).toEqual({
		schemaVersion: 2,
		source: "platform",
		state: "missing",
		truncated: false,
		tasks: [],
	});
	await expect(store.read(input, AbortSignal.abort())).rejects.toMatchObject({
		name: "AbortError",
	});
});

it("reports scan truncation even when only content events fill the scan budget", async () => {
	await sql`insert into platform.conversation_events
		(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,
		event_payload,event_digest,runtime_cursor,occurred_at,source)
		select 'delta-'||n,'ops-session','ops-run','delta-'||n,n,n,'text.delta',
		'{"type":"text.delta","text":"private"}',${"0".repeat(64)},'delta-'||n,'2026-11-01T00:00:15Z','runtime'
		from generate_series(8,218) n`;
	const result = await store.read(input, new AbortController().signal);
	expect(result).toMatchObject({ truncated: true, state: "available" });
	expect(JSON.stringify(result)).not.toMatch(/private|dependency_unavailable/);
});
