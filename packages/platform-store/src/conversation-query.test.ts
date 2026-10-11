import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	ConversationQueryError,
	type ConversationQueryScopeV1,
	PostgresConversationQueryV1,
} from "./conversation-query.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { seedSessionSandboxFixture } from "./session-sandbox.fixture.ts";

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
	for (const [kind, channel, suffix] of [
		["user", "api", "user-1"],
		["user", "api", "user-2"],
		["application", "api", "application-1"],
		["application", "api", "application-2"],
		["user", "api:user", "legacy-user"],
		["application", "api:application", "legacy-application"],
	] as const) {
		const conversationId = `typed-${suffix}`;
		const executionId = `execution-${conversationId}`;
		await client`
			insert into platform.conversations
				(id, agent_id, actor_id, channel_id, principal_type, status,
				 session_generation, authorization_revision, last_conversation_cursor, created_at)
			values (${conversationId}, 'agent-typed', 'shared-principal', ${channel},
				${kind}, 'active', 1, 'authorization-typed', 1, now())
		`;
		await client`
			insert into platform.conversation_executions
				(execution_id, conversation_id, agent_id, actor_id, channel_id,
				 principal_type, turn_id, status, session_generation, authorization_revision,
				 created_at)
			values (${executionId}, ${conversationId}, 'agent-typed', 'shared-principal',
				${channel}, ${kind}, ${`turn-${suffix}`}, 'completed', 1,
				'authorization-typed', now())
		`;
		await client`
			insert into platform.conversation_messages
				(message_id, conversation_id, actor_id, role, text, execution_id, status, created_at)
			values (${`message-${suffix}`}, ${conversationId}, 'shared-principal', 'user',
				${suffix}, ${executionId}, 'submitted', now())
		`;
		await client`
			insert into platform.conversation_events
				(event_id, conversation_id, execution_id, adapter_event_key, sequence,
				 conversation_cursor, event_type, event_payload, event_digest, runtime_cursor, occurred_at, source)
			values (${`event-${suffix}`}, ${conversationId}, ${executionId},
				${`adapter-${suffix}`}, 1, 1, 'text.delta',
				${client.json({ type: "text.delta", text: suffix })}, ${"b".repeat(64)}, ${`runtime-${suffix}`}, now(), 'runtime')
		`;
	}
	for (const row of await client`select id from platform.conversations`) {
		await seedSessionSandboxFixture(client, String(row.id));
	}
}, 120_000);

afterAll(async () => {
	await query?.close();
	await client?.end();
	await database?.stop();
});

const actorOne = { actorId: "actor-1", channelId: "web" };

describe("API Conversation principal binding", () => {
	const apiScope = (kind: "user" | "application", channelId = "api") => ({
		actorId: "shared-principal",
		channelId,
		principal: { kind, id: "shared-principal" },
	});

	it.each(["user", "application"] as const)(
		"isolates %s from the other principal kind with the same ID and channel",
		async (kind) => {
			const allowed = apiScope(kind);
			const denied = apiScope(kind === "user" ? "application" : "user");
			const conversationId = `typed-${kind}-1`;
			const executionId = `execution-${conversationId}`;
			expect(await query.get(allowed, conversationId)).toMatchObject({
				messages: [{ text: `${kind}-1` }],
				executions: [{ executionId }],
			});
			expect(
				await query.getExecution(allowed, conversationId, executionId),
			).toBeDefined();
			expect(
				await query.replay(allowed, conversationId, undefined),
			).toMatchObject({
				outcome: "events",
				events: [{ executionId }],
			});
			await expect(
				query.getAuthorizationTarget(denied, conversationId),
			).resolves.toBeUndefined();
			await expect(query.get(denied, conversationId)).resolves.toBeUndefined();
			await expect(
				query.getExecution(denied, conversationId, executionId),
			).resolves.toBeUndefined();
			await expect(
				query.replay(denied, conversationId, undefined),
			).resolves.toBeUndefined();
			await expect(
				query.getExecution(
					allowed,
					conversationId,
					"execution-typed-legacy-user",
				),
			).resolves.toBeUndefined();
			const page = await query.list(allowed, "agent-typed", { limit: 1 });
			expect(page.items[0]?.conversationId).toBe(conversationId);
			expect(page.nextCursor).not.toBeNull();
			await expect(
				query.list(denied, "agent-typed", {
					limit: 1,
					cursor: page.nextCursor ?? "",
				}),
			).rejects.toMatchObject({ code: "invalid_request" });
			const next = await query.list(allowed, "agent-typed", {
				limit: 1,
				cursor: page.nextCursor ?? "",
			});
			expect(next.items.map((item) => item.conversationId)).toEqual([
				`typed-${kind}-2`,
			]);
		},
	);

	it.each(["user", "application"] as const)(
		"preserves the typed legacy API channel for %s",
		async (kind) => {
			const current = apiScope(kind, `api:${kind}`);
			const id = `typed-legacy-${kind}`;
			expect(await query.get(current, id)).toBeDefined();
			expect(
				(await query.list(current, "agent-typed", { limit: 10 })).items.map(
					(item) => item.conversationId,
				),
			).toEqual([id]);
			await expect(query.get(apiScope(kind), id)).resolves.toBeUndefined();
		},
	);

	it.each(["user", "application"] as const)(
		"paginates a maximum-length opaque %s ID without changing its scope limit",
		async (kind) => {
			const actorId = "\\".repeat(1024);
			const current = {
				...apiScope(kind),
				actorId,
				principal: { kind, id: actorId },
			};
			const ids = [`opaque-${kind}-1`, `opaque-${kind}-2`];
			for (const id of ids)
				await client`insert into platform.conversations
					(id,agent_id,actor_id,channel_id,principal_type,status,session_generation,authorization_revision)
					values (${id},'agent-typed',${actorId},'api',${kind},'ready',1,'authorization-typed')`;
			for (const id of ids) await seedSessionSandboxFixture(client, id);
			const first = await query.list(current, "agent-typed", { limit: 1 });
			expect(first.items.map((item) => item.conversationId)).toEqual([ids[0]]);
			if (!first.nextCursor) throw new Error("Expected a typed list cursor");
			const second = await query.list(current, "agent-typed", {
				limit: 1,
				cursor: first.nextCursor,
			});
			expect(second.items.map((item) => item.conversationId)).toEqual([ids[1]]);
			await expect(
				query.list(
					{
						...current,
						actorId: `${actorId}x`,
						principal: { kind, id: `${actorId}x` },
					},
					"agent-typed",
					{ limit: 1 },
				),
			).rejects.toMatchObject({ code: "invalid_request" });
		},
	);

	it("rejects missing, mismatched and untrusted API principal metadata", async () => {
		let getterCalls = 0;
		const getter = {
			actorId: "shared-principal",
			channelId: "api",
			get principal() {
				getterCalls += 1;
				throw new Error("getter must not run");
			},
		};
		for (const invalid of [
			{ actorId: "shared-principal", channelId: "api" },
			{ actorId: "shared-principal", channelId: "api:user" },
			{ actorId: "shared-principal", channelId: "api:application" },
			apiScope("user", "api:application"),
			apiScope("application", "api:user"),
			apiScope("application", "web"),
			apiScope("user", "api:unknown"),
			{ ...apiScope("application"), actorId: "other-id" },
			{
				...apiScope("application"),
				principal: { kind: "owner", id: "shared-principal" },
			},
			getter,
			new Proxy(apiScope("application"), {}),
		]) {
			await expect(
				query.get(invalid as ConversationQueryScopeV1, "typed-application-1"),
			).rejects.toBeInstanceOf(ConversationQueryError);
		}
		expect(getterCalls).toBe(0);
	});

	it("replays only target E across same-C gaps and rejects another E's event/cursor", async () => {
		const conversationId = "typed-gaps";
		await client`insert into platform.conversations
			(id,agent_id,actor_id,channel_id,principal_type,status,session_generation,authorization_revision,last_conversation_cursor)
			values (${conversationId},'agent-typed','shared-principal','api','application','ready',1,'authorization-typed',6)`;
		for (const executionId of ["gaps-own", "gaps-other"]) {
			await client`insert into platform.conversation_executions
				(execution_id,conversation_id,agent_id,actor_id,channel_id,principal_type,turn_id,status,session_generation,authorization_revision,created_at)
				values (${executionId},${conversationId},'agent-typed','shared-principal','api','application',${`turn-${executionId}`},'completed',1,'authorization-typed',now())`;
		}
		for (const [cursor, executionId, sequence] of [
			[1, "gaps-own", 1],
			[2, "gaps-other", 1],
			[3, "gaps-other", 2],
			[4, "gaps-other", 3],
			[5, "gaps-own", 2],
			[6, "gaps-other", 4],
		] as const) {
			await client`insert into platform.conversation_events
				(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source)
				values (${`gap-event-${cursor}`},${conversationId},${executionId},${`gap-${cursor}`},${sequence},${cursor},'text.delta',${client.json({ type: "text.delta", text: executionId })},${"c".repeat(64)},${`gap-runtime-${cursor}`},now(),'runtime')`;
		}
		await client`update platform.conversation_events set persisted_at=now()-interval '1 hour' where execution_id='gaps-other'`;
		await seedSessionSandboxFixture(client, conversationId);
		const replay = await query.replayExecution(
			apiScope("application"),
			conversationId,
			"gaps-own",
			undefined,
		);
		expect(replay).toMatchObject({
			outcome: "events",
			events: [{ eventId: "gap-event-1" }, { eventId: "gap-event-5" }],
		});
		if (replay?.outcome !== "events")
			throw new Error("Expected target E replay");
		await expect(
			query.replayExecution(
				apiScope("application"),
				conversationId,
				"gaps-own",
				{ kind: "last-event-id", value: "gap-event-1" },
			),
		).resolves.toMatchObject({
			outcome: "events",
			events: [{ eventId: "gap-event-5" }],
		});
		await expect(
			query.replayExecution(
				apiScope("application"),
				conversationId,
				"gaps-own",
				{ kind: "cursor", value: replay.resumeCursor },
			),
		).resolves.toMatchObject({ outcome: "events", events: [] });
		await expect(
			query.replayExecution(
				apiScope("application"),
				conversationId,
				"gaps-own",
				{ kind: "last-event-id", value: "gap-event-6" },
			),
		).resolves.toMatchObject({ outcome: "reload", reason: "unknown_event_id" });
		await expect(
			query.replayExecution(
				apiScope("application"),
				conversationId,
				"gaps-other",
				{ kind: "cursor", value: replay.resumeCursor },
			),
		).resolves.toMatchObject({ outcome: "reload", reason: "cursor_expired" });
	});

	it("rejects persisted C/E principal mismatches and invalid application channels", async () => {
		for (const channel of ["web", "api:user"]) {
			await expect(client`
				insert into platform.conversations
					(id, agent_id, actor_id, channel_id, principal_type, status, session_generation, authorization_revision, created_at)
				values (${`invalid-${channel}`}, 'agent-typed', 'shared-principal', ${channel}, 'application', 'ready', 1, 'authorization-typed', now())
			`).rejects.toMatchObject({ code: "23514" });
		}
		await expect(client`
			insert into platform.conversation_executions
				(execution_id, conversation_id, agent_id, actor_id, channel_id, principal_type, turn_id, status, session_generation, authorization_revision, created_at)
			values ('invalid-kind', 'typed-application-1', 'agent-typed', 'shared-principal', 'api', 'user', 'turn-invalid', 'completed', 1, 'authorization-typed', now())
		`).rejects.toMatchObject({ code: "23503" });
	});
});

describe("PostgreSQL Conversation query", () => {
	it("projects each Sandbox readiness without hiding authorized history or changing another Session", async () => {
		const before = await query.get(actorOne, "conversation-1");
		expect(before?.conversation.sandboxReady).toBe(true);
		try {
			for (const status of [
				"allocated",
				"applying",
				"observed",
				"unknown",
				"stopped",
				"unavailable",
			]) {
				await client`update platform.session_sandbox_allocations set status = ${status} where conversation_id = 'conversation-1'`;
				const detail = await query.get(actorOne, "conversation-1");
				expect(detail?.conversation.sandboxReady).toBe(false);
				expect(detail?.conversation.sandbox).toEqual(
					before?.conversation.sandbox,
				);
				expect(detail?.messages).toEqual(before?.messages);
				expect(detail?.executions).toEqual(before?.executions);
				expect(
					(await query.get(actorOne, "conversation-3"))?.conversation
						.sandboxReady,
				).toBe(true);
				expect(
					await query.replay(actorOne, "conversation-1", undefined),
				).toBeDefined();
			}
		} finally {
			await client`update platform.session_sandbox_allocations set status = 'ready' where conversation_id = 'conversation-1'`;
		}
	});

	it("hides all query paths for a Session with an unbound persisted Execution", async () => {
		const [original] =
			await client`select sandbox_id from platform.conversation_executions
			where execution_id = 'execution-conversation-1'`;
		await client`update platform.conversation_executions set sandbox_id = null
			where execution_id = 'execution-conversation-1'`;
		try {
			await expect(
				query.get(actorOne, "conversation-1"),
			).resolves.toBeUndefined();
			await expect(
				query.getAuthorizationTarget(actorOne, "conversation-1"),
			).resolves.toBeUndefined();
			await expect(
				query.getExecution(
					actorOne,
					"conversation-1",
					"execution-conversation-1",
				),
			).resolves.toBeUndefined();
			await expect(
				query.replay(actorOne, "conversation-1", undefined),
			).resolves.toBeUndefined();
		} finally {
			await client`update platform.conversation_executions set sandbox_id = ${original?.sandbox_id}
				where execution_id = 'execution-conversation-1'`;
		}
	});

	it("hides a stale allocation generation without repairing the allocation", async () => {
		await client`update platform.session_sandbox_allocations set session_generation = 2
			where conversation_id = 'conversation-1'`;
		try {
			await expect(
				query.get(actorOne, "conversation-1"),
			).resolves.toBeUndefined();
			await expect(
				query.replay(actorOne, "conversation-1", undefined),
			).resolves.toBeUndefined();
			expect(
				await client`select session_generation::int as generation
				from platform.session_sandbox_allocations where conversation_id = 'conversation-1'`,
			).toEqual([{ generation: 2 }]);
		} finally {
			await client`update platform.session_sandbox_allocations set session_generation = 1
				where conversation_id = 'conversation-1'`;
		}
	});

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

	it("uses persistence time and returns a resumable reload after the time window", async () => {
		await client`
			update platform.conversation_events
			set occurred_at = now() - interval '1 hour'
			where event_id = 'event-3'
		`;
		const timeBounded = new PostgresConversationQueryV1({
			databaseUrl,
			replayWindow: 2,
			replayWindowMs: 60_000,
		});
		try {
			await expect(
				timeBounded.replay(actorOne, "conversation-1", {
					kind: "last-event-id",
					value: "event-2",
				}),
			).resolves.toMatchObject({
				outcome: "events",
				events: [{ eventId: "event-3" }],
			});
			await client`
				update platform.conversation_events
				set persisted_at = now() - interval '1 hour'
				where event_id = 'event-3'
			`;
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

it("preserves unallocated history and replay without treating missing or corrupt bindings as readiness", async () => {
	const scope = { actorId: "legacy-user", channelId: "web" };
	await client`insert into platform.conversations
   (id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,last_conversation_cursor)
   values ('legacy-history','legacy-agent','legacy-user','web','active',1,'legacy-auth',1)`;
	await client`insert into platform.conversation_executions
   (execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at)
   values ('legacy-execution','legacy-history','legacy-agent','legacy-user','web','legacy-turn','unknown',1,'legacy-auth',now())`;
	await client`insert into platform.conversation_events
   (event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,occurred_at,source,runtime_cursor)
   values ('legacy-event','legacy-history','legacy-execution','legacy-adapter',1,1,'text.delta',${client.json({ type: "text.delta", text: "historical output" })},${"a".repeat(64)},now(),'runtime','legacy-runtime-cursor')`;
	const detail = await query.get(scope, "legacy-history");
	expect(detail).toMatchObject({
		conversation: {
			conversationId: "legacy-history",
			status: "active",
			sandboxReady: false,
		},
		executions: [{ executionId: "legacy-execution", status: "unknown" }],
		events: [{ eventId: "legacy-event" }],
	});
	expect(detail?.conversation.sandbox).toBeUndefined();
	expect(
		(await query.list(scope, "legacy-agent", { limit: 10 })).items,
	).toHaveLength(1);
	expect(await query.getAuthorizationTarget(scope, "legacy-history")).toEqual({
		agentId: "legacy-agent",
	});
	expect(
		await query.getExecution(scope, "legacy-history", "legacy-execution"),
	).toMatchObject({
		execution: { executionId: "legacy-execution" },
		events: [{ eventId: "legacy-event" }],
	});
	expect(await query.replay(scope, "legacy-history", undefined)).toMatchObject({
		outcome: "events",
		events: [{ eventId: "legacy-event" }],
	});
	for (const denied of [
		{ actorId: "other-user", channelId: "web" },
		{ actorId: "legacy-user", channelId: "wecom" },
	]) {
		expect(await query.get(denied, "legacy-history")).toBeUndefined();
		expect(
			await query.getAuthorizationTarget(denied, "legacy-history"),
		).toBeUndefined();
		expect(
			await query.getExecution(denied, "legacy-history", "legacy-execution"),
		).toBeUndefined();
		expect(
			await query.replay(denied, "legacy-history", undefined),
		).toBeUndefined();
	}
	expect((await query.list(scope, "other-agent", { limit: 10 })).items).toEqual(
		[],
	);
	expect(
		await client`select count(*)::int as count from platform.session_sandbox_allocations where conversation_id='legacy-history'`,
	).toEqual([{ count: 0 }]);
	await client`update platform.conversation_executions set sandbox_id='11111111-1111-1111-1111-111111111111' where execution_id='legacy-execution'`;
	expect(await query.get(scope, "legacy-history")).toBeUndefined();
	expect(
		await query.getExecution(scope, "legacy-history", "legacy-execution"),
	).toBeUndefined();
	expect(
		await query.replay(scope, "legacy-history", undefined),
	).toBeUndefined();
	expect(
		(await query.list(scope, "legacy-agent", { limit: 10 })).items,
	).toEqual([]);
});

it("does not treat a newly allocated empty Session with a missing allocation as historical", async () => {
	const scope = { actorId: "new-user", channelId: "web" };
	await client`insert into platform.conversations
		(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision)
		values ('lost-allocation','new-agent','new-user','web','ready',1,'auth')`;
	await client`insert into platform.conversation_audit_events
		(id,conversation_id,agent_id,actor_id,action,trace_id,request_id,occurred_at,details)
		values ('allocation-fact','lost-allocation','new-agent','new-user','conversation.sandbox.allocated','trace','request',now(),'{}')`;
	expect(await query.get(scope, "lost-allocation")).toBeUndefined();
	expect(
		await query.getAuthorizationTarget(scope, "lost-allocation"),
	).toBeUndefined();
	expect(
		await query.replay(scope, "lost-allocation", undefined),
	).toBeUndefined();
	expect((await query.list(scope, "new-agent", { limit: 10 })).items).toEqual(
		[],
	);
	expect(
		await client`select sandbox_id from platform.session_sandbox_allocations where conversation_id='lost-allocation'`,
	).toEqual([]);
});

describe("long Conversation reads (#1732)", () => {
	const longScope = { actorId: "long-actor", channelId: "web" };
	const eventsPerExecution = 150;

	beforeAll(async () => {
		await client`insert into platform.conversations
			(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,last_conversation_cursor)
			values ('long-history','long-agent','long-actor','web','ready',1,'auth-long',${2 * eventsPerExecution})`;
		let cursor = 0;
		for (const [index, executionId] of ["long-1", "long-2"].entries()) {
			await client`insert into platform.conversation_executions
				(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at)
				values (${executionId},'long-history','long-agent','long-actor','web',${`turn-${executionId}`},'completed',1,'auth-long',${`2026-09-06T00:0${index}:00.000Z`})`;
			// The first audit record names the trace; later ones must not win.
			for (const [offset, trace] of [
				[1, `trace-${executionId}`],
				[2, `later-${executionId}`],
			] as const)
				await client`insert into platform.conversation_audit_events
					(id,conversation_id,execution_id,agent_id,actor_id,action,trace_id,request_id,occurred_at)
					values (${`audit-${executionId}-${offset}`},'long-history',${executionId},'long-agent','long-actor',
						'conversation.message.accepted',${trace},'request-long',${`2026-09-06T00:0${index}:0${offset}.000Z`})`;
			for (let sequence = 1; sequence <= eventsPerExecution; sequence++) {
				cursor++;
				await client`insert into platform.conversation_events
					(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source)
					values (${`long-event-${cursor}`},'long-history',${executionId},${`long-${cursor}`},${sequence},${cursor},'text.delta',
						${client.json({ type: "text.delta", text: `part-${cursor}` })},${"d".repeat(64)},${`long-runtime-${cursor}`},now(),'runtime')`;
			}
		}
		await seedSessionSandboxFixture(client, "long-history");
	});

	async function auditScans() {
		const [row] = await client<{ scans: string }[]>`
			select (coalesce(seq_scan, 0) + coalesce(idx_scan, 0))::text as scans
			from pg_stat_user_tables
			where schemaname = 'platform' and relname = 'conversation_audit_events'`;
		return Number(row?.scans);
	}

	/** Audit table scans made by one read on its own connections. */
	async function auditScansDuring<T>(
		read: (reader: PostgresConversationQueryV1) => Promise<T>,
	) {
		const reader = new PostgresConversationQueryV1({
			databaseUrl,
			replayWindow: 100,
		});
		const before = await auditScans();
		let result: T;
		try {
			result = await read(reader);
		} finally {
			// A backend flushes its table statistics when it exits.
			await reader.close();
		}
		let scans = before;
		for (let attempt = 0; attempt < 50 && scans === before; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			scans = await auditScans();
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
		return { result, scans: (await auditScans()) - before };
	}

	it("looks up each Execution's trace once instead of once per event", async () => {
		const { result: detail, scans } = await auditScansDuring((reader) =>
			reader.get(longScope, "long-history"),
		);
		expect(detail?.events).toHaveLength(2 * eventsPerExecution);
		expect(
			new Set(
				detail?.events.map((event) => `${event.executionId}:${event.traceId}`),
			),
		).toEqual(new Set(["long-1:trace-long-1", "long-2:trace-long-2"]));
		expect(detail?.executions.map((item) => item.traceId)).toEqual([
			"trace-long-1",
			"trace-long-2",
		]);
		// Two Executions are looked up by the event and the execution reads;
		// a per-event lookup would scan the audit table 300 times.
		expect(scans).toBeGreaterThan(0);
		expect(scans).toBeLessThanOrEqual(8);
	});

	it("looks up traces only for the Executions an incremental replay returns", async () => {
		const replays = 20;
		const { result: replay, scans } = await auditScansDuring(async (reader) => {
			let last: Awaited<ReturnType<typeof reader.replay>>;
			for (let attempt = 0; attempt < replays; attempt++)
				last = await reader.replay(longScope, "long-history", {
					kind: "last-event-id",
					value: `long-event-${2 * eventsPerExecution - 10}`,
				});
			return last;
		});
		expect(replay).toMatchObject({ outcome: "events" });
		const events = replay?.outcome === "events" ? replay.events : [];
		expect(events).toHaveLength(10);
		expect(new Set(events.map((event) => event.traceId))).toEqual(
			new Set(["trace-long-2"]),
		);
		// Each replay reads only the latest Execution's trace; reading every
		// Execution of the Conversation would double the lookups.
		expect(scans).toBeGreaterThanOrEqual(replays);
		expect(scans).toBeLessThan(replays + replays / 2);
	});

	it("cancels the database statement when the caller aborts the read", async () => {
		const locker = postgres(databaseUrl, { max: 1 });
		const holder = await locker.reserve();
		const blocked = async () => {
			const [row] = await client<{ count: number }[]>`
				select count(*)::int as count from pg_stat_activity
				where wait_event_type = 'Lock' and query like '%conversation_events%'`;
			return row?.count ?? 0;
		};
		try {
			await holder`begin`;
			await holder`lock table platform.conversation_events in access exclusive mode`;
			const controller = new AbortController();
			const reading = query.get(longScope, "long-history", controller.signal);
			const settled = reading.then(
				() => "resolved",
				(error: unknown) => error,
			);
			for (let attempt = 0; attempt < 100 && (await blocked()) === 0; attempt++)
				await new Promise((resolve) => setTimeout(resolve, 50));
			expect(await blocked()).toBe(1);
			const abortedAt = performance.now();
			controller.abort();
			expect(await settled).toBeInstanceOf(ConversationQueryError);
			expect(performance.now() - abortedAt).toBeLessThan(1_000);
			expect(await blocked()).toBe(0);
		} finally {
			await holder`rollback`.catch(() => undefined);
			holder.release();
			await locker.end();
		}
		// The pool stays usable after a cancelled read.
		expect((await query.get(longScope, "long-history"))?.events).toHaveLength(
			2 * eventsPerExecution,
		);
	});

	it("does not start a read whose caller already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			query.get(longScope, "long-history", controller.signal),
		).rejects.toBeInstanceOf(ConversationQueryError);
		await expect(
			query.replay(longScope, "long-history", undefined, controller.signal),
		).rejects.toBeInstanceOf(ConversationQueryError);
	});
});
