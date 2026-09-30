import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPlatformQueueResourceSnapshot } from "./index.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;

async function waitFor(check: () => boolean, attempts = 100) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Timed out waiting for PostgreSQL observation");
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("observability-snapshot");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 1 });
}, 120_000);

afterAll(async () => {
	await client?.end();
	await database?.stop();
});

it("counts the current-generation unreserved Turn backlog once per Execution", async () => {
	await client`
		insert into platform.conversations
			(id, agent_id, actor_id, channel_id, status, session_generation,
			 authorization_revision)
		values ('resource-conversation', 'resource-agent', 'resource-actor',
			'web', 'active', 1, 'resource-revision')
	`;
	await client`
		insert into platform.conversation_executions
			(execution_id, conversation_id, agent_id, actor_id, channel_id,
			 turn_id, status, session_generation, authorization_revision, created_at)
		values ('resource-execution', 'resource-conversation', 'resource-agent',
			'resource-actor', 'web', 'resource-turn', 'submitted', 1,
			'resource-revision', now())
	`;
	await client`
		insert into platform.conversation_messages
			(message_id, conversation_id, actor_id, role, text, execution_id,
			 status, created_at)
		values ('resource-message', 'resource-conversation', 'resource-actor',
			'user', 'synthetic body', 'resource-execution', 'submitted', now())
	`;
	await client`
		insert into platform.conversations
			(id, agent_id, actor_id, channel_id, status, session_generation,
			 authorization_revision)
		values
			('resource-stopped-conversation', 'resource-agent', 'resource-actor',
			 'web', 'active', 1, 'resource-revision'),
			('resource-revoked-conversation', 'resource-agent', 'resource-actor',
			 'web', 'active', 1, 'resource-revision')
	`;
	await client`
		insert into platform.conversation_executions
			(execution_id, conversation_id, agent_id, actor_id, channel_id,
			 turn_id, status, session_generation, authorization_revision, created_at)
		values
			('resource-stopped-execution', 'resource-stopped-conversation',
			 'resource-agent', 'resource-actor', 'web', 'resource-stopped-turn',
			 'submitted', 1, 'resource-revision', now()),
			('resource-revoked-execution', 'resource-revoked-conversation',
			 'resource-agent', 'resource-actor', 'web', 'resource-revoked-turn',
			 'submitted', 1, 'resource-revision', now())
	`;
	await client`
		insert into platform.conversation_messages
			(message_id, conversation_id, actor_id, role, text, execution_id,
			 status, created_at)
		values
			('resource-stopped-message', 'resource-stopped-conversation',
			 'resource-actor', 'user', 'synthetic body', 'resource-stopped-execution',
			 'submitted', now()),
			('resource-revoked-message', 'resource-revoked-conversation',
			 'resource-actor', 'user', 'synthetic body', 'resource-revoked-execution',
			 'submitted', now())
	`;
	await client`
		insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, status, trace_id)
		values
			('resource-pending', 'conversation', 'resource-conversation',
			 'conversation.turn.submit.v1', ${client.json({
					schemaVersion: 1,
					conversationId: "resource-conversation",
					executionId: "resource-execution",
					messageId: "resource-message",
					turnId: "resource-turn",
					sessionGeneration: 1,
				})}, 'pending', 'resource-trace'),
			('resource-regenerate', 'conversation', 'resource-conversation',
			 'conversation.turn.regenerate.v1', ${client.json({
					schemaVersion: 1,
					conversationId: "resource-conversation",
					executionId: "resource-execution",
					messageId: "resource-message",
					turnId: "resource-turn",
					sessionGeneration: 1,
				})}, 'pending', 'resource-trace'),
			('resource-stopped', 'conversation', 'resource-stopped-conversation',
			 'conversation.turn.submit.v1', ${client.json({
					schemaVersion: 1,
					conversationId: "resource-stopped-conversation",
					executionId: "resource-stopped-execution",
					messageId: "resource-stopped-message",
					turnId: "resource-stopped-turn",
					sessionGeneration: 1,
				})}, 'pending', 'resource-trace'),
			('resource-revoked', 'conversation', 'resource-revoked-conversation',
			 'conversation.turn.submit.v1', ${client.json({
					schemaVersion: 1,
					conversationId: "resource-revoked-conversation",
					executionId: "resource-revoked-execution",
					messageId: "resource-revoked-message",
					turnId: "resource-revoked-turn",
					sessionGeneration: 1,
				})}, 'pending', 'resource-trace'),
			('resource-retry', 'workload', 'resource-agent',
			 'resource.operation', '{}', 'retry_scheduled', 'resource-trace'),
			('resource-done', 'workload', 'resource-agent',
			 'resource.operation', '{}', 'succeeded', 'resource-trace')
	`;
	await client`
		update platform.outbox_items
		set status = 'processing', lease_owner = 'resource-worker',
			lease_expires_at = now() + interval '30 seconds'
		where id = 'resource-regenerate'
	`;
	await client`
		insert into platform.conversation_stops
			(execution_id, stop_request_id, status, created_at)
		values ('resource-stopped-execution', 'resource-stop', 'submitted', now())
	`;
	await client`
		insert into platform.task_authorization_records
			(id, execution_id, boundary, revoked_at)
		values ('resource-revoked-auth', 'resource-revoked-execution',
			${client.json({ schemaVersion: 1 })}, now())
	`;
	const before = await client`
		select id, status, attempt_count, delivery_fence from platform.outbox_items
		order by id
	`;
	const timeoutBefore = await client`show statement_timeout`;

	await expect(
		readPlatformQueueResourceSnapshot(client, AbortSignal.timeout(5000)),
	).resolves.toEqual({ taskWaiting: 1, outboxPending: 4 });
	expect(
		await client`
			select id, status, attempt_count, delivery_fence from platform.outbox_items
			order by id
		`,
	).toEqual(before);
	expect(await client`show statement_timeout`).toEqual(timeoutBefore);

	await client`
		update platform.conversation_executions set status = 'processing'
		where execution_id = 'resource-execution'
	`;
	await expect(
		readPlatformQueueResourceSnapshot(client, AbortSignal.timeout(5000)),
	).resolves.toEqual({ taskWaiting: 0, outboxPending: 4 });
});

it("bounds a saturated max:1 pool and cancels a running count query", async () => {
	if (!database) throw new Error("PostgreSQL fixture is unavailable");
	const observedQueries: string[] = [];
	const pool = postgres(database.databaseUrl, {
		max: 1,
		debug: (_connection, query) => observedQueries.push(query),
	});
	const beginPromises: Promise<unknown>[] = [];
	const originalBegin = pool.begin.bind(pool);
	pool.begin = ((...args: unknown[]) => {
		const promise = (
			originalBegin as (...values: unknown[]) => Promise<unknown>
		)(...args);
		beginPromises.push(promise);
		return promise;
	}) as typeof pool.begin;
	let reserved: postgres.ReservedSql | undefined;
	try {
		reserved = await pool.reserve();
		const callerAbortBegin = beginPromises.length;
		const first = readPlatformQueueResourceSnapshot(
			pool,
			AbortSignal.timeout(100),
		);
		const firstFailure = expect(first).rejects.toThrow(
			"Platform resource snapshot is unavailable",
		);
		await expect(
			readPlatformQueueResourceSnapshot(pool, AbortSignal.timeout(100)),
		).rejects.toThrow("Platform resource snapshot is unavailable");
		await expect(
			readPlatformQueueResourceSnapshot(pool, AbortSignal.timeout(100)),
		).rejects.toThrow("Platform resource snapshot is unavailable");
		await firstFailure;
		expect(
			observedQueries.filter((query) => /^\s*begin read only\s*$/i.test(query)),
		).toHaveLength(0);

		reserved.release();
		reserved = undefined;
		await waitFor(() =>
			observedQueries.some((query) => /^\s*begin read only\s*$/i.test(query)),
		);
		await waitFor(() =>
			observedQueries.some((query) => /^\s*rollback\s*$/i.test(query)),
		);
		await expect(beginPromises[callerAbortBegin]).rejects.toThrow(
			"Platform resource snapshot is unavailable",
		);
		const delayedQueries = observedQueries.map((query) => query.toLowerCase());
		expect(
			delayedQueries.filter((query) => /^\s*begin read only\s*$/.test(query)),
		).toHaveLength(1);
		expect(
			delayedQueries.filter((query) =>
				query.includes("set local statement_timeout"),
			),
		).toHaveLength(0);
		expect(
			delayedQueries.filter((query) =>
				query.includes("from platform.conversation_executions"),
			),
		).toHaveLength(0);

		await pool`select 1`;

		reserved = await pool.reserve();
		const deadlineSignal = new AbortController();
		const deadlineBegin = beginPromises.length;
		const deadlineQueries = observedQueries.length;
		const deadlineStartedAt = Date.now();
		const deadlineSnapshot = readPlatformQueueResourceSnapshot(
			pool,
			deadlineSignal.signal,
		);
		let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			const watchdog = new Promise<never>((_, reject) => {
				watchdogTimer = setTimeout(
					() => reject(new Error("PostgreSQL deadline watchdog expired")),
					5_000,
				);
			});
			await expect(Promise.race([deadlineSnapshot, watchdog])).rejects.toThrow(
				"Platform resource snapshot is unavailable",
			);
		} finally {
			if (watchdogTimer) clearTimeout(watchdogTimer);
		}
		expect(deadlineSignal.signal.aborted).toBe(false);
		expect(Date.now() - deadlineStartedAt).toBeGreaterThanOrEqual(1_800);
		reserved.release();
		reserved = undefined;
		await waitFor(() =>
			observedQueries
				.slice(deadlineQueries)
				.some((query) => /^\s*begin read only\s*$/i.test(query)),
		);
		await expect(beginPromises[deadlineBegin]).rejects.toThrow(
			"Platform resource snapshot is unavailable",
		);
		await pool`select 1`;
		const expected = await readPlatformQueueResourceSnapshot(
			pool,
			AbortSignal.timeout(5000),
		);

		const targetPidRows = await pool<{ pid: string }[]>`
			select pg_backend_pid()::text as pid
		`;
		const targetPid = targetPidRows[0]?.pid;
		if (!targetPid) throw new Error("PostgreSQL target PID was not observed");
		const lockConnection = postgres(database.databaseUrl, { max: 1 });
		try {
			await lockConnection.begin(async (transaction) => {
				const pidRows = await transaction<{ pid: string }[]>`
					select pg_backend_pid()::text as pid
				`;
				const lockPid = pidRows[0]?.pid;
				if (!lockPid) throw new Error("PostgreSQL lock PID was not observed");
				await transaction`lock table platform.outbox_items in access exclusive mode`;
				const controller = new AbortController();
				const cancellationBegin = beginPromises.length;
				const pending = readPlatformQueueResourceSnapshot(
					pool,
					controller.signal,
				);
				let blocked = false;
				for (let attempt = 0; attempt < 40; attempt += 1) {
					await transaction`select pg_stat_clear_snapshot()`;
					const activities = await transaction<
						{
							pid: string;
							state: string;
							wait_event_type: string | null;
							wait_event: string | null;
						}[]
					>`
						select s.pid::text, s.state, s.wait_event_type, s.wait_event
						from pg_stat_activity s
						where s.pid = ${Number(targetPid)}
							and s.state = 'active'
							and s.wait_event_type = 'Lock'
							and ${Number(lockPid)} = any(pg_blocking_pids(s.pid))
					`;
					blocked = activities.length === 1;
					if (blocked) break;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				expect(blocked).toBe(true);
				// The public helper redacts the driver error; the original transaction
				// Promise settles with PostgreSQL's cancellation error while the lock
				// is still held.
				const cancellationPromise = beginPromises[cancellationBegin];
				if (!cancellationPromise)
					throw new Error("PostgreSQL transaction Promise was not observed");
				let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
				try {
					const watchdog = new Promise<never>((_, reject) => {
						watchdogTimer = setTimeout(
							() =>
								reject(new Error("PostgreSQL cancellation watchdog expired")),
							1_000,
						);
					});
					controller.abort();
					await expect(pending).rejects.toThrow(
						"Platform resource snapshot is unavailable",
					);
					await expect(
						Promise.race([cancellationPromise, watchdog]),
					).rejects.toMatchObject({
						code: "57014",
						message: expect.stringContaining(
							"canceling statement due to user request",
						),
					});
				} finally {
					if (watchdogTimer) clearTimeout(watchdogTimer);
				}
			});
		} finally {
			await lockConnection.end();
		}
		await pool`select 1`;
		await expect(
			readPlatformQueueResourceSnapshot(pool, AbortSignal.timeout(5000)),
		).resolves.toEqual(expected);
	} finally {
		reserved?.release();
		await pool.end();
	}
}, 30_000);
