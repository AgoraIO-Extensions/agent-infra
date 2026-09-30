import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.js";
import { readPlatformQueueResourceSnapshot } from "./observability-snapshot.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;

beforeAll(async () => {
	database = await startPostgresTestDatabase("observability-snapshot");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 1 });
}, 120_000);

afterAll(async () => {
	await client?.end();
	await database?.stop();
});

it("counts durable waiting Executions and queued outbox rows across Platform scopes", async () => {
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
		insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, status, trace_id)
		values
			('resource-pending', 'conversation', 'resource-conversation',
			 'resource.operation', '{}', 'pending', 'resource-trace'),
			('resource-retry', 'workload', 'resource-agent',
			 'resource.operation', '{}', 'retry_scheduled', 'resource-trace'),
			('resource-done', 'workload', 'resource-agent',
			 'resource.operation', '{}', 'succeeded', 'resource-trace')
	`;
	const before = await client`
		select id, status, attempt_count, delivery_fence from platform.outbox_items
		order by id
	`;
	const timeoutBefore = await client`show statement_timeout`;

	await expect(
		readPlatformQueueResourceSnapshot(client, AbortSignal.timeout(5000)),
	).resolves.toEqual({ taskWaiting: 1, outboxPending: 2 });
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
	await client`
		update platform.outbox_items set status = 'succeeded'
		where id = 'resource-pending'
	`;
	await expect(
		readPlatformQueueResourceSnapshot(client, AbortSignal.timeout(5000)),
	).resolves.toEqual({ taskWaiting: 0, outboxPending: 1 });
});
