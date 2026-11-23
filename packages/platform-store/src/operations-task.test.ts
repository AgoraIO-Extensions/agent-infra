import { readFile } from "node:fs/promises";
import { OperationsTasksV2Schema } from "@agent-infra/contracts/pilot";
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
	sql = postgres(database.databaseUrl, { max: 1 });
	store = new PostgresOperationsTaskStoreV2(
		database.databaseUrl,
		"ops-namespace",
	);
	await sql.unsafe(
		await readFile(
			new URL(
				"../../../deploy/observability/grafana/execution-impact.sql",
				import.meta.url,
			),
			"utf8",
		),
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

it.each([
	{
		rawEvidence: 160,
		submitFailures: 7,
		regenerateFailures: 7,
		truncated: false,
		lastAt: "2026-11-02T00:02:59.000Z",
	},
	{
		rawEvidence: 161,
		submitFailures: 7,
		regenerateFailures: 8,
		truncated: true,
		lastAt: "2026-11-02T00:01:55.000Z",
	},
	{
		rawEvidence: 172,
		submitFailures: 13,
		regenerateFailures: 13,
		truncated: true,
		lastAt: "2026-11-02T00:01:51.000Z",
	},
])(
	"retains the first 160 entries from $rawEvidence projected entries",
	async ({ submitFailures, regenerateFailures, truncated, lastAt }) => {
		const execution = "ops-evidence-limit";
		await sql.begin(async (tx) => {
			await tx`alter table platform.conversation_executions disable trigger conversation_execution_terminal_observed_at`;
			await tx`insert into platform.conversation_executions
			(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,
			session_generation,authorization_revision,created_at,terminal_observed_at)
			values (${execution},'ops-session','ops-agent','ops-actor','web','turn-limit','failed',
			1,'auth','2026-11-02T00:00:00Z','2026-11-02T00:02:59Z')`;
			await tx`alter table platform.conversation_executions enable trigger conversation_execution_terminal_observed_at`;
		});
		const streams = [
			{
				id: `conversation:turn:${execution}`,
				operation: "conversation.turn.submit.v1",
				count: submitFailures,
				offset: 100,
			},
			{
				id: `conversation:regenerate:${execution}`,
				operation: "conversation.turn.regenerate.v1",
				count: regenerateFailures,
				offset: 107,
			},
		];
		const streamIds = streams.map(({ id }) => `outbox:${id}`);
		try {
			// 48 waiting/submitted pairs create 144 entries. Acceptance and terminal
			// evidence add two, and each outbox failure adds one.
			await sql`insert into platform.conversation_events
			(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,
			event_payload,event_digest,runtime_cursor,occurred_at,source)
			select 'limit-'||n,'ops-session',${execution},'limit-'||n,n,1000+n,'execution.status',
			jsonb_build_object('type','execution.status','status',case when n%2=1 then 'waiting' else 'submitted' end),
			${"0".repeat(64)},'limit-'||n,'2026-11-02T00:00:00Z'::timestamptz+n*interval '1 second','runtime'
			from generate_series(1,96) n`;
			for (const stream of streams) {
				await sql`insert into platform.outbox_items
				(id,scope_type,scope_id,operation,status,trace_id,payload)
				values (${stream.id},'conversation','ops-session',${stream.operation},'failed','trace-1',
					jsonb_build_object('executionId',${execution}::text))`;
				await sql`insert into platform.persisted_events
				(event_id,stream_id,sequence,stream_cursor,event_type,payload,trace_id,occurred_at)
				select ${stream.id}::text||':'||n,${`outbox:${stream.id}`},n,n,'outbox.failed',
					'{"errorCode":"RUNTIME_RECOVERY_TIMEOUT"}','trace-1',
					'2026-11-02T00:00:00Z'::timestamptz+(${stream.offset}::int+n)*interval '1 second'
				from generate_series(1,${stream.count}) n`;
			}
			const result = OperationsTasksV2Schema.parse(
				await store.read(
					{
						...input,
						start: "2026-11-02T00:00:00Z",
						end: "2026-11-02T00:03:00Z",
					},
					new AbortController().signal,
				),
			);
			expect(result).toMatchObject({ state: "available", truncated });
			expect(result.tasks).toHaveLength(1);
			const evidence = result.tasks[0]?.evidence ?? [];
			expect(evidence).toHaveLength(160);
			expect(evidence[0]).toMatchObject({
				stage: "acceptance",
				observedAt: "2026-11-02T00:00:00.000Z",
			});
			expect(evidence.at(-1)?.observedAt).toBe(lastAt);
		} finally {
			await sql`delete from platform.persisted_events where stream_id=any(${streamIds}::text[])`;
			await sql`delete from platform.outbox_items where id=any(${streams.map(({ id }) => id)}::text[])`;
			await sql`delete from platform.conversation_events where execution_id=${execution}`;
			await sql`delete from platform.conversation_executions where execution_id=${execution}`;
		}
	},
);
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

it.each(["timeout", "aborted"] as const)(
	"returns promptly when a full pool request is %s and skips its queued business queries",
	async (mode) => {
		const statements: string[] = [];
		const pool = postgres(database.databaseUrl, {
			max: 1,
			debug: (_connection, statement) => {
				statements.push(statement);
			},
		});
		const queued = new PostgresOperationsTaskStoreV2(
			database.databaseUrl,
			"ops-namespace",
			pool,
		);
		const occupied = await pool.reserve();
		const controller = new AbortController();
		let released = false;
		try {
			const started = performance.now();
			const request = queued.read(input, controller.signal);
			if (mode === "aborted") controller.abort();
			await expect(request).rejects.toMatchObject({
				name: mode === "timeout" ? "TimeoutError" : "AbortError",
			});
			expect(performance.now() - started).toBeLessThan(
				mode === "timeout" ? 4000 : 500,
			);
			occupied.release();
			released = true;
			// This waits behind the queued transaction and proves it released its connection.
			await pool`select 1`;
			expect(
				statements.some((statement) =>
					/from platform\.|set_config\(/.test(statement),
				),
			).toBe(false);
		} finally {
			if (!released) occupied.release();
			await queued.close();
		}
	},
	6000,
);

it("scopes Grafana to whole-window aggregates and denies ungranted roles", async () => {
	const [impact] =
		await sql`select * from platform_ops_dashboard.execution_impact(${input.start}, ${input.end}, 'total')`;
	expect(impact).toMatchObject({
		submissions: "0",
		failed: "1",
		failed_users: "1",
		failed_applications: "0",
	});
	const sessions =
		await sql`select * from platform_ops_dashboard.failed_sessions(${input.start},${input.end})`;
	expect(sessions).toMatchObject([
		{ agent: "ops-agent", session_id: "ops-session", failures: "1" },
	]);
	const trend =
		await sql`select failed,completed from platform_ops_dashboard.execution_impact(${input.start}, '2026-11-01T00:11Z','trend') order by bucket`;
	expect(trend.map((r) => r.failed)).toEqual(["1", "0", "0"]);
	await expect(
		sql`select * from platform_ops_dashboard.first_output(now()-interval '2 days',now())`,
	).rejects.toMatchObject({ code: "22023" });
	await sql`create role ops_dashboard_ungranted`;
	const [access] =
		await sql`select has_function_privilege('ops_dashboard_ungranted','platform_ops_dashboard.execution_impact(timestamptz,timestamptz,text)','execute') as allowed`;
	expect(access?.allowed).toBe(false);
});

it("exposes all three channels and empty buckets without inventing reply samples", async () => {
	const rows =
		await sql`select * from platform_ops_dashboard.reply_observations('2000-01-01T00:00Z','2000-01-01T00:10Z','trend') order by bucket,channel`;
	expect(rows.map((r) => r.channel)).toEqual([
		"API",
		"Web",
		"企微",
		"API",
		"Web",
		"企微",
	]);
	expect(
		rows.every(
			(r) =>
				r.accepted === "0" &&
				r.replied === "0" &&
				r.median_first_output_seconds === null,
		),
	).toBe(true);
});

it.each([
	["web", "Web"],
	["wecom_bot:test", "企微"],
	["api:user", "API"],
])(
	"reconciles %s waits, first text and a cancellation in the selected window",
	async (channelId, channel) => {
		await sql.begin(async (tx) => {
			await tx`alter table platform.conversation_executions disable trigger conversation_execution_terminal_observed_at`;
			const actor = "reply-test-user";
			for (const [i, status] of [
				"processing",
				"cancelled",
				"completed",
				"processing",
			].entries()) {
				const session = "reply-" + channel + "-" + i;
				await tx`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values(${session},'ops-agent',${actor},${channelId},'ready',1,'auth')`;
				const created =
					i === 0 || i === 3 ? "2001-01-01T09:59:00Z" : "2001-01-01T10:00:00Z";
				await tx`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at,terminal_observed_at)
			values(${session},${session},'ops-agent',${actor},${channelId},'turn',${status},1,'auth',${created},${i === 0 || i === 3 ? null : "2001-01-01T10:01:00Z"})`;
				if (i === 1) {
					await tx`insert into platform.conversation_events(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,occurred_at,persisted_at,source)
					values(${session + "-queue"},${session},${session},'queue',1,1,'task.status','{"type":"task.status","status":"waiting"}',${"0".repeat(64)},'2001-01-01T10:00Z','2001-01-01T10:00Z','platform')`;
				}
				if (i === 2) {
					for (const [index, body] of ["", "first", "again"].entries()) {
						const id = session + "-" + index;
						await tx`insert into platform.conversation_events(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,persisted_at,source)
					values(${id},${session},${session},${id},${index + 1},${index + 1},'text.delta',${tx.json({ text: body, type: "text.delta" })},${"0".repeat(64)},${id},${"2001-01-01T10:00:0" + index + "Z"},${"2001-01-01T10:00:0" + index + "Z"},'runtime')`;
					}
				}
			}
			await tx`alter table platform.conversation_executions enable trigger conversation_execution_terminal_observed_at`;
			const [row] =
				await tx`select * from platform_ops_dashboard.reply_observations('2001-01-01T10:00Z','2001-01-01T10:05Z','summary') where channel=${channel}`;
			expect(row).toMatchObject({
				accepted: "2",
				replied: "1",
				waiting_users: "1",
				median_first_output_seconds: 1,
				cancelled_before_output: "1",
				median_cancel_wait_seconds: 60,
				queued_executions: "1",
			});
			expect(row?.latest_first_output_at.toISOString()).toBe(
				"2001-01-01T10:00:01.000Z",
			);
			expect(row?.longest_wait_seconds).toBeGreaterThan(60);
			// A reconnect retries the same durable event key; the existing record wins.
			await tx`insert into platform.conversation_events select * from platform.conversation_events where event_id=${"reply-" + channel + "-2-1"} on conflict do nothing`;
			const repeated =
				await tx`select replied, waiting_users from platform_ops_dashboard.reply_observations('2001-01-01T10:00Z','2001-01-01T10:05Z','summary') where channel=${channel}`;
			expect(repeated[0]).toMatchObject({ replied: "1", waiting_users: "1" });
			await tx`update platform.conversation_executions set status='cancelled' where execution_id=${"reply-" + channel + "-3"}`;
			const [remaining] =
				await tx`select waiting_users from platform_ops_dashboard.reply_observations('2001-01-01T10:00Z','2001-01-01T10:05Z','summary') where channel=${channel}`;
			expect(remaining?.waiting_users).toBe("1");
		});
	},
);

it("only the granted datasource role can query reply aggregates", async () => {
	await sql`create role reply_reader`;
	await sql`create role reply_employee`;
	await sql`grant usage on schema platform_ops_dashboard to reply_reader,reply_employee`;
	await sql`grant execute on function platform_ops_dashboard.reply_observations(timestamptz,timestamptz,text) to reply_reader`;
	await expect(
		sql.begin(async (tx) => {
			await tx`set local role reply_employee`;
			await tx`select * from platform_ops_dashboard.reply_observations(now()-interval '1h',now(),'summary')`;
		}),
	).rejects.toMatchObject({ code: "42501" });
	await sql.begin(async (tx) => {
		await tx`set local role reply_reader`;
		expect(
			(
				await tx`select channel from platform_ops_dashboard.reply_observations(now()-interval '1h',now(),'summary')`
			).length,
		).toBeGreaterThanOrEqual(3);
	});
	await expect(
		sql.begin(async (tx) => {
			await tx`set local role reply_reader`;
			await tx`select actor_id from platform.conversation_executions limit 1`;
		}),
	).rejects.toMatchObject({ code: "42501" });
});
