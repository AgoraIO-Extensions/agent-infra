import {
	createConversationEventUseCaseV1,
	type ConversationEventUseCaseV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresConversationEventTransactionV1 } from "./conversation-events.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

type PostgresClient = ReturnType<typeof postgres>;

let client: PostgresClient;
let databaseUrl = "";
let testDatabase: PostgresTestDatabase | undefined;
let nextFixture = 1;

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("conversation-events");
	databaseUrl = testDatabase.databaseUrl;
	client = postgres(databaseUrl, { max: 10 });
	await migratePlatformDatabase({ databaseUrl });
}, 120_000);

afterAll(async () => {
	await client?.end();
	await testDatabase?.stop();
});

async function seedConversation(): Promise<{
	readonly conversationId: string;
	readonly executionId: string;
}> {
	const suffix = nextFixture++;
	const conversationId = `conversation_event_${suffix}`;
	const executionId = `execution_event_${suffix}`;
	await client`
		insert into platform.conversations
			(id, agent_id, actor_id, channel_id, status, session_generation,
			 host_session_ref, authorization_revision, last_conversation_cursor,
			 created_at, updated_at)
		values
			(${conversationId}, 'agent_event', 'actor_event', 'channel_event', 'active', 3,
			 null, 'authorization_event', 0, now(), now())
	`;
	await client`
		insert into platform.conversation_executions
			(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
			 status, session_generation, delivery_fence, authorization_revision,
			 created_at, updated_at)
		values
			(${executionId}, ${conversationId}, 'agent_event', 'actor_event',
			 'channel_event', 'turn_event', 'submitted', 3, 5,
			 'authorization_event', now(), now())
	`;
	return { conversationId, executionId };
}

function openEvents(
	eventId: string,
): {
	readonly events: ConversationEventUseCaseV1;
	readonly close: () => Promise<void>;
} {
	const transaction = new PostgresConversationEventTransactionV1({ databaseUrl });
	return {
		events: createConversationEventUseCaseV1(
			{ transaction },
			{ newId: () => eventId },
		),
		close: () => transaction.close(),
	};
}

function eventInput(
	conversationId: string,
	executionId: string,
	adapterEventKey = "adapter_event_1",
) {
	return {
		schemaVersion: 1 as const,
		conversationId,
		executionId,
		sessionGeneration: 3,
		deliveryFence: 5,
		adapterEventKey,
		runtimeCursor: `runtime_cursor_${adapterEventKey}`,
		occurredAt: "2026-09-04T00:00:00.000Z",
		event: { type: "text.delta" as const, text: "Hello" },
	};
}

describe("PostgreSQL Conversation event transaction", () => {
	it("atomically persists once, records the private runtime cursor, and replays before stale fencing", async () => {
		const { conversationId, executionId } = await seedConversation();
		const { events, close } = openEvents("event_postgres_1");
		try {
			const input = eventInput(conversationId, executionId);
			const accepted = await events.persist(input);
			if (accepted.outcome !== "accepted") {
				throw new Error("Expected the new event to be accepted");
			}
			expect(accepted.event).toMatchObject({
				eventId: "event_postgres_1",
				sequence: 1,
				conversationCursor: 1,
				event: input.event,
			});
			expect(accepted.event).not.toHaveProperty("runtimeCursor");

			expect(
				await events.persist({ ...input, deliveryFence: input.deliveryFence - 1 }),
			).toEqual({ outcome: "replayed", event: accepted.event });

			const [state] = await client`
				select
					(select count(*)::int from platform.conversation_events
						where execution_id = ${executionId}) as events,
					(select last_conversation_cursor from platform.conversations
						where id = ${conversationId}) as conversation_cursor,
					(select last_event_sequence from platform.conversation_executions
						where execution_id = ${executionId}) as execution_sequence,
					(select last_runtime_cursor from platform.conversation_executions
						where execution_id = ${executionId}) as runtime_cursor
			`;
			expect(state).toEqual({
				events: 1,
				conversation_cursor: "1",
				execution_sequence: "1",
				runtime_cursor: input.runtimeCursor,
			});
			const [stored] = await client`
				select event_payload, runtime_cursor
				from platform.conversation_events
				where execution_id = ${executionId}
			`;
			expect(stored).toEqual({
				event_payload: input.event,
				runtime_cursor: input.runtimeCursor,
			});
		} finally {
			await close();
		}
	});

	it("rejects a first stale event without advancing either cursor", async () => {
		const { conversationId, executionId } = await seedConversation();
		const { events, close } = openEvents("event_postgres_stale");
		try {
			const input = eventInput(conversationId, executionId);
			await expect(
				events.persist({ ...input, sessionGeneration: input.sessionGeneration - 1 }),
			).resolves.toEqual({ outcome: "stale" });
			await expect(
				events.persist({ ...input, deliveryFence: input.deliveryFence - 1 }),
			).resolves.toEqual({ outcome: "stale" });

			const [state] = await client`
				select
					(select count(*)::int from platform.conversation_events
						where execution_id = ${executionId}) as events,
					(select last_conversation_cursor from platform.conversations
						where id = ${conversationId}) as conversation_cursor,
					(select last_event_sequence from platform.conversation_executions
						where execution_id = ${executionId}) as execution_sequence,
					(select last_runtime_cursor from platform.conversation_executions
						where execution_id = ${executionId}) as runtime_cursor
			`;
			expect(state).toEqual({
				events: 0,
				conversation_cursor: "0",
				execution_sequence: "0",
				runtime_cursor: null,
			});
		} finally {
			await close();
		}
	});

	it("rolls back a failed new-event write without advancing either cursor", async () => {
		const { conversationId, executionId } = await seedConversation();
		const { events, close } = openEvents("event_postgres_rollback");
		const functionName = "platform.conversation_event_insert_failure";
		const triggerName = "conversation_event_insert_failure";
		await client.unsafe(`
			create function ${functionName}() returns trigger language plpgsql as $$
			begin
				raise exception 'injected conversation event insert failure';
			end
			$$
		`);
		await client.unsafe(
			`create trigger ${triggerName} before insert on platform.conversation_events
				for each row execute function ${functionName}()`,
		);
		try {
			await expect(
				events.persist(eventInput(conversationId, executionId)),
			).rejects.toMatchObject({ code: "unavailable" });
		} finally {
			await client.unsafe(
				`drop trigger if exists ${triggerName} on platform.conversation_events`,
			);
			await client.unsafe(`drop function if exists ${functionName}()`);
			await close();
		}

		const [state] = await client`
			select
				(select count(*)::int from platform.conversation_events
					where execution_id = ${executionId}) as events,
				(select last_conversation_cursor from platform.conversations
					where id = ${conversationId}) as conversation_cursor,
				(select last_event_sequence from platform.conversation_executions
					where execution_id = ${executionId}) as execution_sequence,
				(select last_runtime_cursor from platform.conversation_executions
					where execution_id = ${executionId}) as runtime_cursor
		`;
		expect(state).toEqual({
			events: 0,
			conversation_cursor: "0",
			execution_sequence: "0",
			runtime_cursor: null,
		});
	});

	it("serializes distinct adapter events and preserves their durable allocation after restart", async () => {
		const { conversationId, executionId } = await seedConversation();
		const first = openEvents("event_postgres_concurrent_1");
		const second = openEvents("event_postgres_concurrent_2");
		let firstClosed = false;
		try {
			const results = await Promise.all([
				first.events.persist(eventInput(conversationId, executionId, "adapter_event_1")),
				second.events.persist(eventInput(conversationId, executionId, "adapter_event_2")),
			]);
			const allocated = results.map((result) => {
				if (result.outcome !== "accepted") {
					throw new Error("Expected concurrent event acceptance");
				}
				return result.event;
			});
			expect(allocated.map((event) => event.sequence).toSorted()).toEqual([1, 2]);
			expect(
				allocated.map((event) => event.conversationCursor).toSorted(),
			).toEqual([1, 2]);

			await first.close();
			firstClosed = true;
			const restarted = openEvents("event_postgres_unused_after_restart");
			try {
				const replayed = await restarted.events.persist(
					eventInput(conversationId, executionId, "adapter_event_1"),
				);
				expect(replayed).toMatchObject({ outcome: "replayed" });
				if (replayed.outcome !== "replayed") {
					throw new Error("Expected persisted event replay after restart");
				}
				if (results[0]?.outcome !== "accepted") {
					throw new Error("Expected the first adapter event to be accepted");
				}
				expect(replayed.event).toEqual(results[0].event);
			} finally {
				await restarted.close();
			}
		} finally {
			if (!firstClosed) await first.close();
			await second.close();
		}
	});
});
