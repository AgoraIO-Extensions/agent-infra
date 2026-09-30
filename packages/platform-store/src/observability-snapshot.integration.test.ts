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
