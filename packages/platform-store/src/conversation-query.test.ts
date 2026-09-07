import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	ConversationQueryError,
	PostgresConversationQueryV1,
} from "./conversation-query.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let databaseUrl = "";
let client: ReturnType<typeof postgres>;
let database: PostgresTestDatabase | undefined;
let query: PostgresConversationQueryV1;

beforeAll(async () => {
	database = await startPostgresTestDatabase("conversation-query");
	databaseUrl = database.databaseUrl;
	client = postgres(databaseUrl, { max: 10 });
	await migratePlatformDatabase({ databaseUrl });
	query = new PostgresConversationQueryV1({
		databaseUrl,
		replayWindow: 2,
	});

	for (const [conversationId, actorId] of [
		["conversation-1", "actor-1"],
		["conversation-2", "actor-2"],
		["conversation-3", "actor-1"],
	] as const) {
		await client`
			insert into platform.conversations
				(id, agent_id, actor_id, channel_id, status, session_generation,
				 authorization_revision, last_conversation_cursor, created_at, updated_at)
			values
				(${conversationId}, 'agent-1', ${actorId}, 'web', 'active', 1,
				 'authorization-1', 0, '2026-09-06T00:00:00.000Z',
				 '2026-09-06T00:00:00.000Z')
		`;
		await client`
			insert into platform.conversation_executions
				(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
				 status, session_generation, delivery_fence, authorization_revision,
				 created_at, updated_at)
			values
				(${`execution-${conversationId}`}, ${conversationId}, 'agent-1', ${actorId},
				 'web', ${`turn-${conversationId}`}, 'completed', 1, 1,
				 'authorization-1', '2026-09-06T00:00:01.000Z',
				 '2026-09-06T00:00:04.000Z')
		`;
		await client`
			insert into platform.conversation_messages
				(message_id, conversation_id, actor_id, role, text, execution_id, status,
				 created_at, updated_at)
			values
				(${`message-${conversationId}`}, ${conversationId}, ${actorId}, 'user',
				 'bounded fixture', ${`execution-${conversationId}`}, 'submitted',
				 '2026-09-06T00:00:01.000Z', '2026-09-06T00:00:01.000Z')
		`;
		await client`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, trace_id, request_id,
				 available_at, created_at, updated_at)
			values
				(${`outbox-${conversationId}`}, 'conversation', ${conversationId},
				 'conversation.turn.submit.v1', ${client.json({
						schemaVersion: 1,
						conversationId,
						executionId: `execution-${conversationId}`,
						messageId: `message-${conversationId}`,
						turnId: `turn-${conversationId}`,
						sessionGeneration: 1,
					})}, 'trace-1', 'request-1', '2026-09-06T00:00:01.000Z',
				 '2026-09-06T00:00:01.000Z', '2026-09-06T00:00:01.000Z')
		`;
		await client`
			insert into platform.conversation_audit_events
				(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id,
				 request_id, occurred_at)
			values
				(${`audit-${conversationId}`}, ${conversationId},
				 ${`execution-${conversationId}`}, 'agent-1', ${actorId},
				 'conversation.message.accepted', 'trace-1', 'request-1',
				 '2026-09-06T00:00:01.000Z')
		`;
	}

	for (const cursor of [1, 2, 3]) {
		await client`
			insert into platform.conversation_events
				(event_id, conversation_id, execution_id, adapter_event_key, sequence,
				 conversation_cursor, event_type, event_payload, event_digest,
				 runtime_cursor, occurred_at, source)
			values
				(${`event-${cursor}`}, 'conversation-1', 'execution-conversation-1',
				 ${`adapter-${cursor}`}, ${cursor}, ${cursor}, 'text.delta',
				 ${client.json({ type: "text.delta", text: `part-${cursor}` })},
				 ${String(cursor).repeat(64)}, ${`runtime-${cursor}`},
				 now(), 'runtime')
		`;
	}
	await client`
		update platform.conversations set last_conversation_cursor = 3
		where id = 'conversation-1'
	`;
	await client`
		update platform.conversation_executions
		set last_event_sequence = 3, last_runtime_cursor = 'runtime-3'
		where execution_id = 'execution-conversation-1'
	`;
	await client`
		insert into platform.conversation_events
			(event_id, conversation_id, execution_id, adapter_event_key, sequence,
			 conversation_cursor, event_type, event_payload, event_digest,
			 runtime_cursor, occurred_at, source)
		values
			('event-conversation-2', 'conversation-2', 'execution-conversation-2',
			 'adapter-conversation-2', 1, 1, 'text.delta',
			 ${client.json({ type: "text.delta", text: "other" })}, ${"a".repeat(64)},
			 'runtime-conversation-2', now(), 'runtime')
	`;
	await client`
		update platform.conversations set last_conversation_cursor = 1
		where id = 'conversation-2'
	`;
}, 120_000);

afterAll(async () => {
	await query?.close();
	await client?.end();
	await database?.stop();
});

const actorOne = { actorId: "actor-1", channelId: "web" };

describe("PostgreSQL Conversation query", () => {
	it("binds list, history, and execution detail to actor and channel", async () => {
		const page = await query.list(actorOne, "agent-1", { limit: 1 });
		expect(page.items).toEqual([
			expect.objectContaining({
				conversationId: "conversation-1",
				lastConversationCursor: expect.stringMatching(/^v1\./),
			}),
		]);
		const detail = await query.get(actorOne, "conversation-1");
		expect(detail).toMatchObject({
			messages: [{ messageId: "message-conversation-1" }],
			executions: [
				{
					executionId: "execution-conversation-1",
					sourceMessageId: "message-conversation-1",
					traceId: "trace-1",
				},
			],
		});
		expect(
			await query.getExecution(
				actorOne,
				"conversation-1",
				"execution-conversation-1",
			),
		).toMatchObject({ execution: { status: "completed" } });

		for (const deniedScope of [
			{ actorId: "actor-2", channelId: "web" },
			{ actorId: "actor-1", channelId: "wecom" },
		]) {
			await expect(query.get(deniedScope, "conversation-1")).resolves.toBe(
				undefined,
			);
			await expect(
				query.getExecution(
					deniedScope,
					"conversation-1",
					"execution-conversation-1",
				),
			).resolves.toBe(undefined);
		}
	});

	it("maps Last-Event-ID and bound cursor replay from persisted rows", async () => {
		const byEvent = await query.replay(actorOne, "conversation-1", {
			kind: "last-event-id",
			value: "event-1",
		});
		expect(byEvent).toMatchObject({
			outcome: "events",
			events: [
				{ eventId: "event-2", sequence: 2 },
				{ eventId: "event-3", sequence: 3 },
			],
		});
		if (byEvent?.outcome !== "events") throw new Error("Expected replay");
		const cursor = byEvent.events[0]?.conversationCursor;
		if (!cursor) throw new Error("Expected cursor");
		await expect(
			query.replay(actorOne, "conversation-1", {
				kind: "cursor",
				value: cursor,
			}),
		).resolves.toMatchObject({
			outcome: "events",
			events: [{ eventId: "event-3" }],
		});
	});

	it("returns bounded reload controls without disclosing other conversations", async () => {
		await expect(
			query.replay(actorOne, "conversation-1", undefined),
		).resolves.toMatchObject({
			outcome: "reload",
			reason: "cursor_expired",
		});
		await expect(
			query.replay(actorOne, "conversation-1", {
				kind: "last-event-id",
				value: "event-missing",
			}),
		).resolves.toMatchObject({
			outcome: "reload",
			reason: "unknown_event_id",
		});
		await expect(
			query.replay(actorOne, "conversation-1", {
				kind: "last-event-id",
				value: "event-conversation-2",
			}),
		).resolves.toMatchObject({
			outcome: "reload",
			reason: "unknown_event_id",
		});
	});

	it("rejects malformed or cross-scope cursors before querying another scope", async () => {
		await expect(
			query.replay(actorOne, "conversation-1", {
				kind: "cursor",
				value: "not-a-cursor",
			}),
		).rejects.toBeInstanceOf(ConversationQueryError);
		const replay = await query.replay(actorOne, "conversation-1", {
			kind: "last-event-id",
			value: "event-2",
		});
		if (replay?.outcome !== "events") throw new Error("Expected replay cursor");
		await expect(
			query.replay({ actorId: "actor-2", channelId: "web" }, "conversation-2", {
				kind: "cursor",
				value: replay.resumeCursor,
			}),
		).resolves.toMatchObject({
			outcome: "reload",
			reason: "cross_conversation_cursor",
		});
		const page = await query.list(actorOne, "agent-1", { limit: 1 });
		if (!page.nextCursor) throw new Error("Expected a bound list cursor");
		await expect(
			query.list({ actorId: "actor-2", channelId: "web" }, "agent-1", {
				limit: 1,
				cursor: page.nextCursor,
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
	});

	it("returns reload when a cursor exceeds the configured time window", async () => {
		await client`
			update platform.conversation_events
			set occurred_at = now() - interval '1 hour'
			where event_id = 'event-3'
		`;
		const timeBounded = new PostgresConversationQueryV1({
			databaseUrl,
			replayWindow: 2,
			replayWindowMs: 1,
		});
		try {
			const expired = await timeBounded.replay(actorOne, "conversation-1", {
				kind: "last-event-id",
				value: "event-2",
			});
			expect(expired).toMatchObject({
				outcome: "reload",
				reason: "cursor_expired",
			});
			if (expired?.outcome !== "reload") throw new Error("Expected reload");
			await expect(
				timeBounded.replay(actorOne, "conversation-1", {
					kind: "cursor",
					value: expired.resumeCursor,
				}),
			).resolves.toMatchObject({
				outcome: "events",
				events: [],
			});
		} finally {
			await timeBounded.close();
		}
	});
});
