import {
	type ConversationEventTransactionPortV1,
	type ConversationEventUseCaseV1,
	type ConversationOperationFactV2,
	createConversationEventUseCaseV1,
	type FileRecordV1,
} from "@agent-infra/platform-core";
import { conversationEventConformanceV1 } from "@agent-infra/platform-core/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresConversationEventTransactionV1 } from "./conversation-events.ts";
import { PostgresConversationQueryV1 } from "./conversation-query.ts";
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

const conformanceConversationId = "conversation_event_fixture";
const conformanceExecutionId = "execution_event_fixture";
const eventFailureFunction = "platform.conversation_event_conformance_failure";
const eventFailureTrigger = "conversation_event_conformance_failure";

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

async function seedConformanceConversation(): Promise<void> {
	await client`delete from platform.files where conversation_id = ${conformanceConversationId}`;
	await client`
		delete from platform.conversation_events
		where conversation_id = ${conformanceConversationId}
	`;
	await client`
		delete from platform.conversation_executions
		where conversation_id = ${conformanceConversationId}
	`;
	await client`
		delete from platform.conversations where id = ${conformanceConversationId}
	`;
	await client`
		insert into platform.conversations
			(id, agent_id, actor_id, channel_id, status, session_generation,
			 host_session_ref, authorization_revision, last_conversation_cursor,
			 created_at, updated_at)
		values
			(${conformanceConversationId}, 'agent_event_fixture',
			 'actor_event_fixture', 'channel_event_fixture', 'active', 3,
			 null, 'authorization_event_fixture', 0, now(), now())
	`;
	await client`
		insert into platform.conversation_executions
			(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
			 status, session_generation, delivery_fence, authorization_revision,
			 created_at, updated_at)
		values
			(${conformanceExecutionId}, ${conformanceConversationId},
			 'agent_event_fixture', 'actor_event_fixture', 'channel_event_fixture',
			 'turn_event_fixture', 'unknown', 3, 5,
			 'authorization_event_fixture', now(), now())
	`;
	const file: FileRecordV1 = {
		fileId: "file_fixture",
		objectRef: "00000000-0000-4000-8000-000000000001",
		kind: "result",
		idempotencyKey: "result_fixture",
		actorId: "actor_event_fixture",
		agentId: "agent_event_fixture",
		channelId: "channel_event_fixture",
		conversationId: conformanceConversationId,
		executionId: conformanceExecutionId,
		messageId: null,
		sessionGeneration: 3,
		status: "available",
		descriptor: {
			name: "fixture.txt",
			mediaType: "text/plain",
			sizeBytes: 16,
			sha256: "0".repeat(64),
		},
		objectVersion: "version_fixture",
		etag: "etag_fixture",
		createdAt: "2026-09-04T00:00:00Z",
		updatedAt: "2026-09-04T00:00:00Z",
		expiresAt: "2026-09-04T01:00:00Z",
		revision: 1,
	};
	await client`insert into platform.files (file_id, actor_id, conversation_id, idempotency_key, record, updated_at)
        values (${file.fileId}, ${file.actorId}, ${file.conversationId}, ${file.idempotencyKey}, ${client.json(file as unknown as Parameters<typeof client.json>[0])}, now())`;
}

async function armEventCommitFailure(): Promise<void> {
	await client.unsafe(`
		create function ${eventFailureFunction}() returns trigger language plpgsql as $$
		begin
			raise exception 'injected conversation event conformance failure';
		end
		$$
	`);
	await client.unsafe(
		`create trigger ${eventFailureTrigger}
			before update on platform.conversation_executions
			for each row execute function ${eventFailureFunction}()`,
	);
}

async function disarmEventCommitFailure(): Promise<void> {
	await client.unsafe(
		`drop trigger if exists ${eventFailureTrigger}
			on platform.conversation_executions`,
	);
	await client.unsafe(`drop function if exists ${eventFailureFunction}()`);
}

conversationEventConformanceV1("PostgreSQL", async () => {
	await seedConformanceConversation();
	let nextEventId = 1;
	let failureCleanupRequired = false;
	let loseNextResponse = false;
	const adapter = new PostgresConversationEventTransactionV1({ databaseUrl });
	const transaction: ConversationEventTransactionPortV1 = {
		async persistEvent(request, decide) {
			try {
				return await adapter.persistEvent(request, decide);
			} finally {
				if (failureCleanupRequired) {
					try {
						await disarmEventCommitFailure();
					} finally {
						failureCleanupRequired = false;
					}
				}
			}
		},
	};
	const inner = createConversationEventUseCaseV1(
		{ transaction },
		{ newId: () => `event_fixture_${nextEventId++}` },
	);
	const events: ConversationEventUseCaseV1 = {
		async persist(command) {
			const decision = await inner.persist(command);
			if (loseNextResponse) {
				loseNextResponse = false;
				throw new Error("Injected response loss");
			}
			return decision;
		},
	};
	return {
		events,
		async failNextCommit() {
			failureCleanupRequired = true;
			await armEventCommitFailure();
		},
		loseNextResponseAfterCommit() {
			loseNextResponse = true;
		},
		async snapshot() {
			const [state] = await client`
				select
					(select count(*)::int from platform.conversation_events
						where conversation_id = ${conformanceConversationId}) as events,
					c.last_conversation_cursor::int as conversation_cursor,
					e.last_event_sequence::int as execution_sequence,
					e.last_runtime_cursor as runtime_cursor
				from platform.conversations c
				join platform.conversation_executions e
					on e.conversation_id = c.id
				where c.id = ${conformanceConversationId}
					and e.execution_id = ${conformanceExecutionId}
			`;
			if (!state) throw new Error("Expected Conversation event fixture state");
			return {
				events: state.events as number,
				conversationCursor: state.conversation_cursor as number,
				executionSequence: state.execution_sequence as number,
				runtimeCursor: state.runtime_cursor as string | null,
			};
		},
		async close() {
			try {
				await disarmEventCommitFailure();
			} finally {
				await adapter.close();
			}
		},
	};
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
			 'channel_event', 'turn_event', 'unknown', 3, 5,
			 'authorization_event', now(), now())
	`;
	return { conversationId, executionId };
}

function openEvents(eventId: string): {
	readonly events: ConversationEventUseCaseV1;
	readonly close: () => Promise<void>;
} {
	const transaction = new PostgresConversationEventTransactionV1({
		databaseUrl,
	});
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

async function operationFixture(withProvenance = true) {
	const ids = await seedConversation();
	const authorizationRecordId = `authorization_${ids.executionId}`;
	await client`
		update platform.conversation_executions
		set model_configuration_revision = 1, model_option_id = 'option-1', reasoning_level = 'medium'
		where execution_id = ${ids.executionId}
	`;
	if (withProvenance) {
		await client`
			insert into platform.task_authorization_records (id, execution_id, boundary)
			values (${authorizationRecordId}, ${ids.executionId}, ${client.json({
				schemaVersion: 1,
				principal: { kind: "user", id: "actor_event" },
				agentId: "agent_event",
				channelId: "channel_event",
				identityRevision: "identity-1",
				agentAuthorizationRevision: "authorization_event",
				accessSources: [{ kind: "user", userId: "actor_event" }],
			})})
		`;
		await client`
			insert into platform.audit_events
				(id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
			values (${`acceptance_${ids.executionId}`}, 'trace-original', 'user', 'actor_event', 'task.authorization.accepted', 'execution',
				${ids.executionId}, 'succeeded', 'request-original', 'agent_event', ${client.json({ authorizationRecordId })})
		`;
	}
	const transaction = new PostgresConversationEventTransactionV1({
		databaseUrl,
	});
	let counter = 1;
	const events = createConversationEventUseCaseV1(
		{ transaction },
		{ newId: () => `${ids.executionId}_event_${counter++}` },
	);
	const query = new PostgresConversationQueryV1({ databaseUrl });
	const fact: ConversationOperationFactV2 = {
		kind: "model",
		operationRef: "model-operation-1",
		attemptRef: "attempt-1",
		phase: "intent",
		model: {
			configVersion: "revision-1",
			modelOptionId: "option-1",
			modelId: "model-1",
			reasoningLevel: "medium",
		},
	};
	const command = (
		next: ConversationOperationFactV2 = fact,
		key = "operation-intent",
	) => ({
		...eventInput(ids.conversationId, ids.executionId, key),
		event: {
			type: "execution.operation" as const,
			schemaVersion: 2 as const,
			fact: next,
		},
	});
	const snapshot = async () => {
		const [row] = await client`
			select e.last_event_sequence::int as sequence, e.last_runtime_cursor as runtime_cursor,
				c.last_conversation_cursor::int as conversation_cursor,
				(select count(*)::int from platform.conversation_events where execution_id = e.execution_id) as events,
				(select count(*)::int from platform.audit_events where target_id = e.execution_id and action = 'execution.operation.observed') as audits
			from platform.conversation_executions e join platform.conversations c on c.id = e.conversation_id where e.execution_id = ${ids.executionId}
		`;
		return row;
	};
	return {
		...ids,
		authorizationRecordId,
		fact,
		command,
		events,
		query,
		snapshot,
		close: () => Promise.all([transaction.close(), query.close()]),
	};
}

describe("PostgreSQL actual operation facts and necessary audits", () => {
	it("rejects reuse of an older attempt after intervening completed attempts without changing events or audits", async () => {
		const fixture = await operationFixture();
		try {
			for (const attemptRef of ["attempt-1", "attempt-2"]) {
				const intent = { ...fixture.fact, attemptRef };
				const started = {
					...intent,
					phase: "started" as const,
					startedAt: "2026-09-04T00:00:00.000Z",
				};
				const completed = {
					...started,
					phase: "completed" as const,
					finishedAt: "2026-09-04T00:00:01.000Z",
					durationMs: 1_000,
				};
				for (const fact of [intent, started, completed]) {
					await expect(
						fixture.events.persist(
							fixture.command(fact, `${attemptRef}-${fact.phase}`),
						),
					).resolves.toMatchObject({ outcome: "accepted" });
				}
			}
			const before = await fixture.snapshot();
			expect(before).toMatchObject({ sequence: 6, events: 6, audits: 6 });
			await expect(
				fixture.events.persist(
					fixture.command(fixture.fact, "reuse-attempt-1"),
				),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(await fixture.snapshot()).toEqual(before);
			await expect(
				fixture.events.persist(
					fixture.command(
						{ ...fixture.fact, operationRef: "another-operation" },
						"reuse-attempt-1-another-operation",
					),
				),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(await fixture.snapshot()).toEqual(before);
			const next = fixture.command(
				{ ...fixture.fact, attemptRef: "attempt-3" },
				"fresh-attempt-3",
			);
			await expect(fixture.events.persist(next)).resolves.toMatchObject({
				outcome: "accepted",
			});
			const accepted = await fixture.snapshot();
			expect(accepted).toMatchObject({ sequence: 7, events: 7, audits: 7 });
			await expect(fixture.events.persist(next)).resolves.toMatchObject({
				outcome: "replayed",
			});
			expect(await fixture.snapshot()).toEqual(accepted);
		} finally {
			await fixture.close();
		}
	});

	async function connectionFixture() {
		const fixture = await operationFixture();
		const intent = {
			kind: "tool",
			phase: "intent",
			toolId: "connection.github.create_pr",
			operationRef: "connection-operation-1",
			attemptRef: "connection-attempt-1",
			connection: {
				serviceRef: "connection-primary",
				verification: "unverified",
				reason: "receipt_missing",
			},
		} as const;
		const started = {
			...intent,
			phase: "started",
			startedAt: "2026-09-04T00:00:00.000Z",
		} as const;
		const completed = {
			...started,
			phase: "completed",
			finishedAt: "2026-09-04T00:00:01.000Z",
			durationMs: 1_000,
			resultRef: "result-1",
			connection: {
				...intent.connection,
				callRef: "call-1",
				reason: "record_unavailable",
			},
		} as const;
		const verified = {
			...completed,
			connection: {
				serviceRef: "connection-primary",
				verification: "verified",
				callRef: "call-1",
			},
		} as const;
		for (const fact of [intent, started, completed])
			await fixture.events.persist(
				fixture.command(fact, `connection-${fact.phase}`),
			);
		return { ...fixture, completed, verified };
	}

	it("persists late Connection verification once and preserves one original tool outcome in history", async () => {
		const fixture = await connectionFixture();
		try {
			const before = await fixture.query.get(
				{ actorId: "actor_event", channelId: "channel_event" },
				fixture.conversationId,
			);
			const command = {
				...fixture.command(fixture.verified, "connection-verified"),
				operationMetadataOnly: true as const,
			};
			const results = await Promise.all([
				fixture.events.persist(command),
				fixture.events.persist(command),
			]);
			expect(results.map((result) => result.outcome).sort()).toEqual([
				"accepted",
				"replayed",
			]);
			expect(await fixture.snapshot()).toMatchObject({
				sequence: 4,
				conversation_cursor: 4,
				events: 4,
				audits: 4,
				runtime_cursor: "runtime_cursor_connection-verified",
			});
			const history = await fixture.query.get(
				{ actorId: "actor_event", channelId: "channel_event" },
				fixture.conversationId,
			);
			expect(history?.events.slice(0, 3)).toEqual(before?.events);
			expect(history?.events[3]).toMatchObject({
				eventSchemaVersion: 2,
				eventPayload: command.event.fact,
			});
			// A metadata event replaces the view of its attempt; it is not a new execution.
			const outcomes = new Map<string, ConversationOperationFactV2>();
			for (const event of history?.events ?? []) {
				const payload = event.eventPayload as ConversationOperationFactV2;
				outcomes.set(
					`${event.executionId}:${payload.operationRef}:${payload.attemptRef}`,
					payload,
				);
			}
			expect([...outcomes.values()]).toEqual([fixture.verified]);
			expect(
				[...outcomes.values()].filter((fact) => fact.phase === "completed"),
			).toHaveLength(1);
			expect(
				[...outcomes.values()].reduce(
					(sum, fact) => sum + (fact.durationMs ?? 0),
					0,
				),
			).toBe(1_000);
			const [audit] =
				await client`select actor_type, actor_id, agent_id, details from platform.audit_events where target_id = ${fixture.executionId} and details ->> 'fact' is not null order by occurred_at desc, id desc limit 1`;
			expect(audit).toMatchObject({
				actor_type: "user",
				actor_id: "actor_event",
				agent_id: "agent_event",
				details: { fact: fixture.verified },
			});
			await expect(
				fixture.query.get(
					{ actorId: "another-user", channelId: "channel_event" },
					fixture.conversationId,
				),
			).resolves.toBeUndefined();
		} finally {
			await fixture.close();
		}
	});

	it("rejects a post-terminal evidence update that completes or restarts an original tool attempt", async () => {
		const fixture = await connectionFixture();
		try {
			const before = await fixture.snapshot();
			for (const fact of [
				{ ...fixture.verified, phase: "failed" as const },
				{ ...fixture.verified, durationMs: 2000 },
				{ ...fixture.fact, phase: "intent" as const },
			]) {
				await expect(
					fixture.events.persist({
						...fixture.command(fact, "post-terminal-invalid"),
						operationMetadataOnly: true,
					}),
				).rejects.toThrow();
				expect(await fixture.snapshot()).toEqual(before);
			}
		} finally {
			await fixture.close();
		}
	});

	it("rejects Connection rebinding, downgrade and changed terminal metadata without advancing cursors", async () => {
		const fixture = await connectionFixture();
		try {
			await fixture.events.persist(
				fixture.command(fixture.verified, "connection-verified"),
			);
			const before = await fixture.snapshot();
			const changes = [
				{
					connection: {
						...fixture.verified.connection,
						serviceRef: "other-service",
					},
				},
				{
					connection: { ...fixture.verified.connection, callRef: "other-call" },
				},
				{ connection: fixture.completed.connection },
				{ connection: undefined },
				{ operationRef: "other-operation" },
				{ attemptRef: "other-attempt" },
				{ phase: "failed" },
				{ durationMs: 2_000 },
				{ finishedAt: "2026-09-04T00:00:02.000Z" },
				{ resultRef: "another-result" },
				{},
			];
			for (const [i, change] of changes.entries()) {
				await expect(
					fixture.events.persist(
						fixture.command(
							{ ...fixture.verified, ...change } as ConversationOperationFactV2,
							`invalid-association-${i}`,
						),
					),
				).rejects.toMatchObject({ code: "unavailable" });
				expect(await fixture.snapshot()).toEqual(before);
			}
			const other = await operationFixture();
			try {
				await expect(
					other.events.persist(
						other.command(fixture.verified, "foreign-terminal-evidence"),
					),
				).rejects.toMatchObject({ code: "unavailable" });
				expect(await other.snapshot()).toMatchObject({
					events: 0,
					audits: 0,
					sequence: 0,
				});
			} finally {
				await other.close();
			}
		} finally {
			await fixture.close();
		}
	});

	it("rolls back a Connection metadata update and its audit before a safe retry", async () => {
		const fixture = await connectionFixture();
		try {
			const before = await fixture.snapshot();
			const command = fixture.command(fixture.verified, "connection-verified");
			await armEventCommitFailure();
			try {
				await expect(fixture.events.persist(command)).rejects.toMatchObject({
					code: "unavailable",
				});
				expect(await fixture.snapshot()).toEqual(before);
			} finally {
				await disarmEventCommitFailure();
			}
			await expect(fixture.events.persist(command)).resolves.toMatchObject({
				outcome: "accepted",
				event: { sequence: 4 },
			});
			expect(await fixture.snapshot()).toMatchObject({
				events: 4,
				audits: 4,
				sequence: 4,
			});
		} finally {
			await fixture.close();
		}
	});

	it("commits mixed versions, original actor audit and cursors once, then replays after lease changes", async () => {
		const fixture = await operationFixture();
		const scope = { actorId: "actor_event", channelId: "channel_event" };
		try {
			const text = await fixture.events.persist(
				eventInput(
					fixture.conversationId,
					fixture.executionId,
					"text-before-operation",
				),
			);
			await fixture.events.persist(fixture.command());
			const started = {
				...fixture.fact,
				phase: "started" as const,
				startedAt: "2026-09-04T00:00:00.000Z",
			};
			await fixture.events.persist(
				fixture.command(started, "operation-started"),
			);
			const completed = {
				...started,
				phase: "completed" as const,
				finishedAt: "2026-09-04T00:00:01.000Z",
				durationMs: 1_000,
			};
			const result = await fixture.events.persist(
				fixture.command(completed, "operation-completed"),
			);
			expect(result).toMatchObject({
				outcome: "accepted",
				event: { sequence: 4, conversationCursor: 4 },
			});
			await expect(
				fixture.events.persist({
					...fixture.command(completed, "operation-completed"),
					deliveryFence: 1,
				}),
			).resolves.toMatchObject({
				outcome: "replayed",
				event: { sequence: 4, conversationCursor: 4 },
			});
			expect(await fixture.snapshot()).toMatchObject({
				sequence: 4,
				conversation_cursor: 4,
				events: 4,
				audits: 3,
				runtime_cursor: "runtime_cursor_operation-completed",
			});
			const audits =
				await client`select actor_type, actor_id, agent_id, trace_id, request_id, details from platform.audit_events where target_id = ${fixture.executionId} and action = 'execution.operation.observed' order by details ->> 'eventId'`;
			expect(audits).toHaveLength(3);
			expect(
				audits.every(
					(audit) =>
						audit.actor_type === "user" &&
						audit.actor_id === "actor_event" &&
						audit.agent_id === "agent_event" &&
						audit.trace_id === "trace-original" &&
						audit.request_id === "request-original" &&
						audit.details.executor === "platform_worker",
				),
			).toBe(true);
			const history = await fixture.query.get(scope, fixture.conversationId);
			expect(history?.events[0]).not.toHaveProperty("eventSchemaVersion");
			expect(history?.events[1]).toMatchObject({
				eventSchemaVersion: 2,
				eventPayload: fixture.command().event.fact,
			});
			if (text.outcome === "stale") throw new Error("Expected stored text");
			const replay = await fixture.query.replay(scope, fixture.conversationId, {
				kind: "last-event-id",
				value: text.event.eventId,
			});
			expect(replay).toMatchObject({
				outcome: "events",
				events: [
					{ eventSchemaVersion: 2 },
					{ eventSchemaVersion: 2 },
					{ eventSchemaVersion: 2 },
				],
			});
			await expect(
				fixture.query.getExecution(
					{ ...scope, actorId: "owner-other-user" },
					fixture.conversationId,
					fixture.executionId,
				),
			).resolves.toBeUndefined();
		} finally {
			await fixture.close();
		}
	});

	it("rolls back the event, audit and every cursor if audit persistence fails, then retries the same operation", async () => {
		const fixture = await operationFixture();
		try {
			await client.unsafe(
				`create function platform.operation_audit_test_failure() returns trigger language plpgsql as $$ begin if NEW.action = 'execution.operation.observed' then raise exception 'injected audit persistence failure'; end if; return NEW; end $$`,
			);
			await client.unsafe(
				"create trigger operation_audit_test_failure before insert on platform.audit_events for each row execute function platform.operation_audit_test_failure()",
			);
			try {
				await expect(
					fixture.events.persist(fixture.command()),
				).rejects.toMatchObject({ code: "unavailable" });
				expect(await fixture.snapshot()).toMatchObject({
					sequence: 0,
					conversation_cursor: 0,
					events: 0,
					audits: 0,
					runtime_cursor: null,
				});
			} finally {
				await client.unsafe(
					"drop trigger operation_audit_test_failure on platform.audit_events",
				);
				await client.unsafe(
					"drop function platform.operation_audit_test_failure()",
				);
			}
			await expect(
				fixture.events.persist(fixture.command()),
			).resolves.toMatchObject({ outcome: "accepted", event: { sequence: 1 } });
			expect(await fixture.snapshot()).toMatchObject({ events: 1, audits: 1 });
			const started = {
				...fixture.fact,
				phase: "started" as const,
				startedAt: "2026-09-04T00:00:00.000Z",
			};
			await armEventCommitFailure();
			try {
				await expect(
					fixture.events.persist(fixture.command(started, "after-audit-write")),
				).rejects.toMatchObject({ code: "unavailable" });
				expect(await fixture.snapshot()).toMatchObject({
					events: 1,
					audits: 1,
					sequence: 1,
					conversation_cursor: 1,
					runtime_cursor: "runtime_cursor_operation-intent",
				});
			} finally {
				await disarmEventCommitFailure();
			}
			await expect(
				fixture.events.persist(fixture.command(started, "after-audit-write")),
			).resolves.toMatchObject({ outcome: "accepted", event: { sequence: 2 } });
			expect(await fixture.snapshot()).toMatchObject({
				events: 2,
				audits: 2,
				sequence: 2,
			});
		} finally {
			await fixture.close();
		}
	});

	it("denies missing identity provenance and bound model selection changes without acknowledgement", async () => {
		for (const withProvenance of [false, true]) {
			const fixture = await operationFixture(withProvenance);
			try {
				const fact =
					withProvenance && fixture.fact.kind === "model"
						? {
								...fixture.fact,
								model: {
									...fixture.fact.model,
									modelOptionId: "different-model-option",
								},
							}
						: fixture.fact;
				await expect(
					fixture.events.persist(fixture.command(fact)),
				).rejects.toMatchObject({ code: "unavailable" });
				expect(await fixture.snapshot()).toMatchObject({
					sequence: 0,
					conversation_cursor: 0,
					events: 0,
					audits: 0,
					runtime_cursor: null,
				});
			} finally {
				await fixture.close();
			}
		}
	});

	it("rejects phase replays under a new key and missing necessary audit on an existing event", async () => {
		const fixture = await operationFixture();
		try {
			const accepted = await fixture.events.persist(fixture.command());
			await expect(
				fixture.events.persist(
					fixture.command(fixture.fact, "forged-retry-key"),
				),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(await fixture.snapshot()).toMatchObject({
				events: 1,
				audits: 1,
				sequence: 1,
			});
			if (accepted.outcome === "stale")
				throw new Error("Expected accepted fact");
			await client`delete from platform.audit_events where id = ${`operation-observed:${accepted.event.eventId}`}`;
			await expect(
				fixture.events.persist(fixture.command()),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(await fixture.snapshot()).toMatchObject({
				events: 1,
				audits: 0,
				sequence: 1,
			});
		} finally {
			await fixture.close();
		}
	});

	it("does not borrow another principal, Agent or channel's authorization provenance", async () => {
		for (const change of [
			{
				principal: { kind: "user", id: "another-user" },
				accessSources: [{ kind: "user", userId: "another-user" }],
			},
			{ agentId: "another-agent" },
			{ channelId: "another-channel" },
		]) {
			const fixture = await operationFixture();
			try {
				await client`update platform.task_authorization_records set boundary = boundary || ${client.json(change)}::jsonb where id = ${fixture.authorizationRecordId}`;
				await expect(
					fixture.events.persist(fixture.command()),
				).rejects.toMatchObject({ code: "unavailable" });
				expect(await fixture.snapshot()).toMatchObject({
					events: 0,
					audits: 0,
					sequence: 0,
				});
			} finally {
				await fixture.close();
			}
		}
	});

	it("rejects corrupted operation history instead of returning an empty or downgraded V1 history", async () => {
		const fixture = await operationFixture();
		try {
			await fixture.events.persist(fixture.command());
			await client`update platform.conversation_events set event_payload = event_payload || '{"schemaVersion":1}'::jsonb where execution_id = ${fixture.executionId}`;
			await expect(
				fixture.query.get(
					{ actorId: "actor_event", channelId: "channel_event" },
					fixture.conversationId,
				),
			).rejects.toMatchObject({ code: "unavailable" });
		} finally {
			await fixture.close();
		}
	});
});

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
				await events.persist({
					...input,
					deliveryFence: input.deliveryFence - 1,
				}),
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
				select event_payload, runtime_cursor, source
				from platform.conversation_events
				where execution_id = ${executionId}
			`;
			expect(stored).toEqual({
				event_payload: input.event,
				runtime_cursor: input.runtimeCursor,
				source: "runtime",
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
				events.persist({
					...input,
					sessionGeneration: input.sessionGeneration - 1,
				}),
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

	it("commits an event and its status transition atomically", async () => {
		const { conversationId, executionId } = await seedConversation();
		const { events, close } = openEvents("event_postgres_terminal");
		try {
			await expect(
				events.persist({
					...eventInput(conversationId, executionId),
					event: { type: "execution.status", status: "completed" },
					transition: {
						executionStatus: "completed",
						conversationStatus: "ready",
					},
				}),
			).resolves.toMatchObject({ outcome: "accepted" });
			const [state] = await client`
				select c.status as conversation_status,
					c.last_conversation_cursor::int as conversation_cursor,
					e.status as execution_status,
					e.last_event_sequence::int as execution_sequence,
					e.last_runtime_cursor as runtime_cursor
				from platform.conversations c
				join platform.conversation_executions e
					on e.conversation_id = c.id
				where c.id = ${conversationId} and e.execution_id = ${executionId}
			`;
			expect(state).toEqual({
				conversation_status: "ready",
				conversation_cursor: 1,
				execution_status: "completed",
				execution_sequence: 1,
				runtime_cursor: "runtime_cursor_adapter_event_1",
			});
		} finally {
			await close();
		}
	});

	it.each(["unknown", "processing"] as const)(
		"never releases %s capacity through a submitted status event",
		async (status) => {
			const { conversationId, executionId } = await seedConversation();
			await client`update platform.conversation_executions set status = ${status} where execution_id = ${executionId}`;
			const { events, close } = openEvents(`event_no_demotion_${status}`);
			try {
				await expect(
					events.persist({
						...eventInput(conversationId, executionId),
						event: { type: "execution.status", status: "submitted" },
						transition: {
							executionStatus: "submitted",
							conversationStatus: "active",
						},
					}),
				).rejects.toMatchObject({ code: "unavailable" });
				const [state] =
					await client`select status, last_event_sequence::int as sequence from platform.conversation_executions where execution_id = ${executionId}`;
				expect(state).toEqual({ status, sequence: 0 });
				const [count] =
					await client`select count(*)::int as count from platform.conversation_events where execution_id = ${executionId}`;
				expect(count?.count).toBe(0);
			} finally {
				await close();
			}
		},
	);

	it("allows the normal submitted to processing transition", async () => {
		const { conversationId, executionId } = await seedConversation();
		const { events, close } = openEvents("event_submitted_processing");
		try {
			await expect(
				events.persist({
					...eventInput(conversationId, executionId),
					event: { type: "execution.status", status: "processing" },
					transition: {
						executionStatus: "processing",
						conversationStatus: "active",
					},
				}),
			).resolves.toMatchObject({ outcome: "accepted" });
			const [state] = await client`
				select status, last_event_sequence::int as sequence
				from platform.conversation_executions
				where execution_id = ${executionId}`;
			expect(state).toEqual({ status: "processing", sequence: 1 });
		} finally {
			await close();
		}
	});

	it("rolls back an event that would rewrite a terminal Execution", async () => {
		const { conversationId, executionId } = await seedConversation();
		await client`
			update platform.conversation_executions set status = 'completed'
			where execution_id = ${executionId}
		`;
		const { events, close } = openEvents("event_postgres_late_running");
		try {
			await expect(
				events.persist({
					...eventInput(conversationId, executionId),
					event: { type: "execution.status", status: "processing" },
					transition: {
						executionStatus: "processing",
						conversationStatus: "active",
					},
				}),
			).rejects.toMatchObject({ code: "unavailable" });
			const [state] = await client`
				select e.status as execution_status,
					e.last_event_sequence::int as execution_sequence,
					e.last_runtime_cursor as runtime_cursor,
					(select count(*)::int from platform.conversation_events
						where execution_id = ${executionId}) as events
				from platform.conversation_executions e
				where e.execution_id = ${executionId}
			`;
			expect(state).toEqual({
				execution_status: "completed",
				execution_sequence: 0,
				runtime_cursor: null,
				events: 0,
			});
		} finally {
			await close();
		}
	});

	it("rejects a new Runtime event after its dispatch lease expires", async () => {
		const { conversationId, executionId } = await seedConversation();
		const itemId = `conversation:turn:${executionId}`;
		await client`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, status, attempt_count,
				 trace_id, request_id, available_at, lease_owner, lease_expires_at,
				 delivery_fence, created_at, updated_at)
			values
				(${itemId}, 'conversation', ${conversationId},
				 'conversation.turn.submit.v1', ${client.json({})}, 'processing', 1,
				 'trace-event-lease', 'request-event-lease', now(), 'worker-event',
				 clock_timestamp() - interval '1 second', 7, now(), now())
		`;
		const { events, close } = openEvents("event_postgres_expired_lease");
		const input = {
			...eventInput(conversationId, executionId),
			dispatchLease: {
				schemaVersion: 1 as const,
				itemId,
				leaseOwner: "worker-event",
				deliveryFence: 7,
			},
		};
		try {
			await expect(events.persist(input)).resolves.toEqual({
				outcome: "stale",
			});
			await client`
				update platform.outbox_items
				set lease_expires_at = clock_timestamp() + interval '30 seconds'
				where id = ${itemId}
			`;
			await expect(events.persist(input)).resolves.toMatchObject({
				outcome: "accepted",
			});
		} finally {
			await close();
		}
	});

	it("uses database time for operational event updates", async () => {
		const { conversationId, executionId } = await seedConversation();
		const { events, close } = openEvents("event_postgres_database_time");
		const input = {
			...eventInput(conversationId, executionId),
			occurredAt: "2099-01-01T00:00:00.000Z",
		};
		try {
			await expect(events.persist(input)).resolves.toMatchObject({
				outcome: "accepted",
			});
			const [timestamps] = await client<
				{
					conversation_updated_at: Date;
					execution_updated_at: Date;
				}[]
			>`
				select c.updated_at as conversation_updated_at,
					e.updated_at as execution_updated_at
				from platform.conversations c
				join platform.conversation_executions e on e.execution_id = ${executionId}
				where c.id = ${conversationId}
			`;
			if (!timestamps) throw new Error("Expected persisted timestamps");
			const future = new Date(input.occurredAt).getTime();
			expect(timestamps.conversation_updated_at.getTime()).toBeLessThan(future);
			expect(timestamps.execution_updated_at.getTime()).toBeLessThan(future);
		} finally {
			await close();
		}
	});

	it("rejects an event that pairs an Execution with another Conversation", async () => {
		const execution = await seedConversation();
		const conversation = await seedConversation();
		await expect(
			client`
				insert into platform.conversation_events
					(event_id, conversation_id, execution_id, adapter_event_key, sequence,
						 conversation_cursor, event_type, event_payload, event_digest,
						 runtime_cursor, occurred_at, source)
				values
					(${`event_cross_conversation_${nextFixture++}`},
					 ${conversation.conversationId}, ${execution.executionId}, 'adapter_cross', 1,
					 1, 'text.delta', ${client.json({ type: "text.delta", text: "Hello" })},
						 ${"0".repeat(64)}, 'runtime_cross', now(), 'runtime')
			`,
		).rejects.toMatchObject({
			constraint_name: "conversation_event_execution_conversation_fk",
		});
	});

	it("enforces the persisted source, event type, and Runtime cursor binding", async () => {
		const { conversationId, executionId } = await seedConversation();
		const insert = (
			eventId: string,
			source: string,
			eventType: string,
			runtimeCursor: string | null,
		) => client`
			insert into platform.conversation_events
				(event_id, conversation_id, execution_id, adapter_event_key, sequence,
				 conversation_cursor, event_type, event_payload, event_digest,
				 runtime_cursor, occurred_at, source)
			values
				(${eventId}, ${conversationId}, ${executionId}, ${`adapter_${eventId}`}, 1,
				 1, ${eventType}, ${client.json({ type: eventType })}, ${"0".repeat(64)},
				 ${runtimeCursor}, now(), ${source})
		`;
		await expect(
			insert(
				"event_runtime_fallback_forgery",
				"runtime",
				"model.selection.fell_back",
				"runtime_cursor_forged",
			),
		).rejects.toMatchObject({
			constraint_name: "conversation_event_source_binding",
		});
		await expect(
			insert("event_platform_runtime_cursor", "platform", "text.delta", null),
		).rejects.toMatchObject({
			constraint_name: "conversation_event_source_binding",
		});
		await expect(
			insert(
				"event_platform_invented_cursor",
				"platform",
				"model.selection.fell_back",
				"invented_runtime_cursor",
			),
		).rejects.toMatchObject({
			constraint_name: "conversation_event_source_binding",
		});
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
				first.events.persist(
					eventInput(conversationId, executionId, "adapter_event_1"),
				),
				second.events.persist(
					eventInput(conversationId, executionId, "adapter_event_2"),
				),
			]);
			const allocated = results.map((result) => {
				if (result.outcome !== "accepted") {
					throw new Error("Expected concurrent event acceptance");
				}
				return result.event;
			});
			expect(allocated.map((event) => event.sequence).toSorted()).toEqual([
				1, 2,
			]);
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

it("rejects unconfirmed, forged metadata and cross-scope result files before advancing history", async () => {
	await seedConformanceConversation();
	const [fileRow] = await client<
		{ record: FileRecordV1 }[]
	>`select record from platform.files where file_id = 'file_fixture'`;
	if (!fileRow) throw new Error("Missing result fixture");
	const original = fileRow.record;
	const runtime = openEvents("file_event_authority");
	const command = {
		...eventInput(conformanceConversationId, conformanceExecutionId),
		event: {
			type: "result.file" as const,
			fileId: "file_fixture",
			name: "fixture.txt",
			mediaType: "text/plain",
			sizeBytes: 16,
		},
	};
	try {
		for (const change of [
			{ status: "pending" },
			{ status: "deleted" },
			{ kind: "attachment" },
			{ actorId: "other" },
			{ agentId: "other" },
			{ channelId: "other" },
			{ executionId: "other" },
			{ sessionGeneration: 4 },
			{ descriptor: { ...original.descriptor, name: "forged.txt" } },
			{ descriptor: { ...original.descriptor, mediaType: "image/png" } },
			{ descriptor: { ...original.descriptor, sizeBytes: 17 } },
		]) {
			await client`update platform.files set actor_id = ${change.actorId ?? original.actorId}, record = ${client.json({ ...original, ...change } as unknown as Parameters<typeof client.json>[0])} where file_id = 'file_fixture'`;
			await expect(runtime.events.persist(command)).rejects.toMatchObject({
				code: "unavailable",
			});
		}
		const [state] =
			await client`select last_conversation_cursor from platform.conversations where id = ${conformanceConversationId}`;
		expect(Number(state?.last_conversation_cursor)).toBe(0);
		await client`update platform.files set actor_id = ${original.actorId}, record = ${client.json(original as unknown as Parameters<typeof client.json>[0])} where file_id = 'file_fixture'`;
		expect((await runtime.events.persist(command)).outcome).toBe("accepted");
		expect((await runtime.events.persist(command)).outcome).toBe("replayed");
	} finally {
		await runtime.close();
	}
});
