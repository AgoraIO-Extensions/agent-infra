import {
	type ConversationExecutionAuthorityV1,
	createConversationExecutionUseCaseV1,
	createConversationTaskAdmissionUseCaseV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { PostgresConversationDispatchStoreV1 } from "./conversation-dispatch.ts";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresConversationExecutionTransactionV1;
let nextId = 0;
let currentAuthority: ConversationExecutionAuthorityV1;
const now = () => new Date("2026-09-26T00:00:00.000Z");

const command = (
	key: string,
	extra: { conversationId?: string; text?: string } = {},
) => ({
	schemaVersion: 1 as const,
	agentId: "agent_task",
	...(extra.conversationId ? { conversationId: extra.conversationId } : {}),
	text: extra.text ?? "private task input",
	idempotencyKey: key,
	requestId: `request_${key}`,
	traceId: `trace_${key}`,
});

function taskUseCase(maximumWaitingTasksPerAgent = 2) {
	return createConversationTaskAdmissionUseCaseV1(
		{
			authorization: {
				async authorize() {
					return { outcome: "allowed", authority: currentAuthority };
				},
			},
			transaction: store,
		},
		{ maximumWaitingTasksPerAgent, waitingTimeoutMs: 60_000 },
		{
			now,
			newId: () => `task_id_${++nextId}`,
		},
	);
}

async function counts() {
	const [row] = await sql<
		{
			conversations: number;
			executions: number;
			messages: number;
			outboxes: number;
			audits: number;
			idempotency: number;
		}[]
	>`
		select (select count(*)::int from platform.conversations) as conversations,
			(select count(*)::int from platform.conversation_executions) as executions,
			(select count(*)::int from platform.conversation_messages) as messages,
			(select count(*)::int from platform.outbox_items) as outboxes,
			(select count(*)::int from platform.conversation_audit_events) as audits,
			(select count(*)::int from platform.idempotency_records) as idempotency
	`;
	return row;
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("task-admission");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 10 });
	store = new PostgresConversationExecutionTransactionV1({
		databaseUrl: database.databaseUrl,
	});
}, 120_000);

beforeEach(async () => {
	nextId = 0;
	currentAuthority = {
		schemaVersion: 1,
		actorId: "user_task",
		agentId: "agent_task",
		channelId: "api",
		authorizationRevision: "grant_1",
		supportsSupplementaryInstruction: false,
		taskBoundary: {
			schemaVersion: 1,
			principal: { kind: "user", id: "user_task" },
			agentId: "agent_task",
			channelId: "api",
			identityRevision: "identity_1",
			agentAuthorizationRevision: "grant_1",
			accessSources: [{ kind: "user", userId: "user_task" }],
		},
	};
	const configuration = {
		schemaVersion: 1,
		agentId: "agent_task",
		revision: 1,
		source: {
			kind: "standard",
			templateId: "template_fixture",
			imageDigest: `sha256:${"a".repeat(64)}`,
			admissionRevision: "admission_fixture",
			allowedEnvironmentKeys: [],
			allowedSecretKeys: [],
			platformManagedKeys: [],
			connectionEnabled: false,
		},
		modelConfiguration: {
			catalogRevision: "catalog_fixture",
			options: [
				{
					optionId: "model_primary",
					endpointId: "endpoint_fixture",
					modelId: "model_fixture",
					reasoningLevels: ["low"],
					credential: { secretId: "secret_fixture", version: 1, isSet: true },
				},
			],
			defaultOptionId: "model_primary",
			defaultReasoningLevel: "low",
		},
		actions: [],
		actionSetRevision: "actions_fixture",
		environment: [],
		secrets: [],
		channels: [],
		channelRevision: "channels_fixture",
	};
	await sql`insert into platform.agents (id, current_configuration_revision, authorization_revision)
		values ('agent_task', 1, 'grant_1')`;
	await sql`insert into platform.agent_applications
		(id, agent_id, applicant_id, name, description, status, trace_id, request_id,
		 submitted_at, management_revision, approval_revision, service_availability, desired_state,
		 workload_revision, fence)
		values ('application_task', 'agent_task', 'owner_task', 'Task Agent', 'Test Agent',
			'available', 'trace_seed', 'request_seed', now(), 1, 1, 'ready', 'running', 1, 1)`;
	await sql`insert into platform.agent_configuration_revisions
		(agent_id, revision, source_reference, created_at, configuration)
		values ('agent_task', 1, 'source_fixture', now(), ${sql.json(configuration)})`;
});

afterEach(async () => {
	await sql`truncate platform.conversation_generation_tombstones, platform.task_control_records,
		platform.task_authorization_records, platform.conversation_events,
		platform.conversation_audit_events, platform.outbox_items, platform.idempotency_records,
		platform.conversation_stops, platform.conversation_messages,
		platform.conversation_executions, platform.conversations,
		platform.agent_configuration_revisions, platform.agent_applications, platform.agents cascade`;
});

afterAll(async () => {
	await store?.close();
	await sql?.end();
	await database?.stop();
});

describe("durable task admission", () => {
	it("creates a default Conversation once and saves discoverable waiting work atomically", async () => {
		const task = taskUseCase();
		const decisions = await Promise.all([
			task.submitTask(command("same")),
			task.submitTask(command("same")),
		]);
		expect(decisions.map((decision) => decision.outcome).sort()).toEqual([
			"accepted",
			"replayed",
		]);
		const first = decisions.find((decision) => decision.outcome === "accepted");
		const replay = decisions.find(
			(decision) => decision.outcome === "replayed",
		);
		if (first?.outcome !== "accepted")
			throw new Error("Expected accepted task");
		expect(replay).toMatchObject({ result: first.result });
		expect(await counts()).toEqual({
			conversations: 1,
			executions: 1,
			messages: 1,
			outboxes: 1,
			audits: 1,
			idempotency: 1,
		});
		const [execution] = await sql<
			{
				status: string;
				task_wait_order: string;
				task_wait_deadline: Date;
				model_option_id: string;
			}[]
		>`
			select status, task_wait_order::text, task_wait_deadline, model_option_id
			from platform.conversation_executions`;
		expect(execution).toMatchObject({
			status: "waiting",
			task_wait_order: "1",
			model_option_id: "model_primary",
		});
		expect(execution?.task_wait_deadline.toISOString()).toBe(
			"2026-09-26T00:01:00.000Z",
		);
		const [outbox] = await sql<
			{ available_at: string }[]
		>`select available_at::text from platform.outbox_items`;
		expect(outbox?.available_at).toBe("infinity");
		const [timeline] = await sql<
			{
				event_type: string;
				source: string;
				runtime_cursor: string | null;
				sequence: string;
				conversation_cursor: string;
			}[]
		>`select event_type, source, runtime_cursor, sequence::text, conversation_cursor::text
			from platform.conversation_events where execution_id = ${first.result.executionId}`;
		expect(timeline).toEqual({
			event_type: "task.status",
			source: "platform",
			runtime_cursor: null,
			sequence: "1",
			conversation_cursor: "1",
		});
		const [cursor] = await sql<
			{ last_conversation_cursor: string; last_event_sequence: string }[]
		>`select c.last_conversation_cursor::text, e.last_event_sequence::text
			from platform.conversations c join platform.conversation_executions e
				on e.conversation_id = c.id where e.execution_id = ${first.result.executionId}`;
		expect(cursor).toEqual({
			last_conversation_cursor: "1",
			last_event_sequence: "1",
		});
		const dispatch = new PostgresConversationDispatchStoreV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			expect(await dispatch.findDispatchable({ limit: 10 })).toEqual([
				{
					itemId: `conversation:turn:${first.result.executionId}`,
					operation: "conversation.turn.submit.v1",
				},
			]);
		} finally {
			await dispatch.close();
		}
		expect(
			await task.submitTask(command("same", { text: "different" })),
		).toEqual({ outcome: "conflict", reason: "idempotency_conflict" });
	});

	it("rejects full capacity before default Conversation creation", async () => {
		const task = taskUseCase(1);
		const first = await task.submitTask(command("one"));
		if (first.outcome !== "accepted") throw new Error("Expected accepted task");
		expect(await task.submitTask(command("one"))).toMatchObject({
			outcome: "replayed",
			result: first.result,
		});
		expect(await task.submitTask(command("two"))).toEqual({
			outcome: "capacity_full",
		});
		expect(await counts()).toEqual({
			conversations: 1,
			executions: 1,
			messages: 1,
			outboxes: 1,
			audits: 1,
			idempotency: 1,
		});
		await sql`insert into platform.conversations
			(id, agent_id, actor_id, channel_id, status, session_generation, authorization_revision)
			values ('foreign_at_capacity', 'agent_task', 'other_user', 'api', 'ready', 1, 'grant_1')`;
		expect(
			await task.submitTask(
				command("foreign_at_capacity", {
					conversationId: "foreign_at_capacity",
				}),
			),
		).toEqual({ outcome: "denied", reason: "conversation_unavailable" });
	});

	it("rejects a waiting Execution without a persisted queue order", async () => {
		const result = await taskUseCase().submitTask(command("order_required"));
		if (result.outcome !== "accepted")
			throw new Error("Expected accepted task");
		await expect(
			sql`update platform.conversation_executions set task_wait_order = null
				where execution_id = ${result.result.executionId}`,
		).rejects.toMatchObject({ code: "23514" });
	});

	it("falls back to the current default when a continued task's selection disappeared", async () => {
		await sql`insert into platform.conversations
			(id, agent_id, actor_id, channel_id, status, session_generation,
			 authorization_revision, selected_model_option_id, selected_reasoning_level)
			values ('task_model_fallback', 'agent_task', 'user_task', 'api', 'ready', 1,
			 'grant_1', 'removed_model', 'high')`;
		const decision = await taskUseCase().submitTask(
			command("fallback", { conversationId: "task_model_fallback" }),
		);
		expect(decision.outcome).toBe("accepted");
		if (decision.outcome !== "accepted") return;
		const events = await sql<
			{ event_type: string; sequence: string; conversation_cursor: string }[]
		>`select event_type, sequence::text, conversation_cursor::text
			from platform.conversation_events where execution_id = ${decision.result.executionId}
			order by sequence`;
		expect(events).toEqual([
			{ event_type: "task.status", sequence: "1", conversation_cursor: "1" },
			{
				event_type: "model.selection.fell_back",
				sequence: "2",
				conversation_cursor: "2",
			},
		]);
		const [selection] = await sql<
			{ model_option_id: string; selected_model_option_id: string }[]
		>`select e.model_option_id, c.selected_model_option_id
			from platform.conversation_executions e join platform.conversations c
				on c.id = e.conversation_id where e.execution_id = ${decision.result.executionId}`;
		expect(selection).toEqual({
			model_option_id: "model_primary",
			selected_model_option_id: "model_primary",
		});
	});

	it("queues explicit same-principal continuation and blocks a new message on that API channel", async () => {
		const task = taskUseCase();
		const first = await task.submitTask(command("one"));
		if (first.outcome !== "accepted") throw new Error("Expected first task");
		const second = await task.submitTask(
			command("two", { conversationId: first.result.conversationId }),
		);
		expect(second.outcome).toBe("accepted");
		const orders = await sql<{ task_wait_order: string }[]>`
			select task_wait_order::text from platform.conversation_executions order by task_wait_order`;
		expect(orders.map((row) => row.task_wait_order)).toEqual(["1", "2"]);
		const conversationCommands = createConversationExecutionUseCaseV1(
			{
				authorization: {
					async authorize() {
						return { outcome: "allowed", authority: currentAuthority };
					},
				},
				transaction: store,
			},
			{ now },
		);
		expect(
			await conversationCommands.accept({
				schemaVersion: 1,
				command: "message",
				conversationId: first.result.conversationId,
				text: "must wait",
				idempotencyKey: "web_after_task",
				requestId: "request_web",
				traceId: "trace_web",
			}),
		).toEqual({ outcome: "busy" });
	});

	it("rejects foreign continuation and stopped Agent without orphan records", async () => {
		const task = taskUseCase();
		await sql`insert into platform.conversations (id, agent_id, actor_id, channel_id, status,
			session_generation, authorization_revision)
			values ('foreign_actor', 'agent_task', 'other_user', 'api', 'ready', 1, 'grant_1'),
				('foreign_agent', 'other_agent', 'user_task', 'api', 'ready', 1, 'grant_1'),
				('foreign_channel', 'agent_task', 'user_task', 'web', 'ready', 1, 'grant_1')`;
		for (const conversationId of [
			"foreign_actor",
			"foreign_agent",
			"foreign_channel",
		]) {
			expect(
				await task.submitTask(command(conversationId, { conversationId })),
			).toEqual({ outcome: "denied", reason: "conversation_unavailable" });
		}
		await sql`update platform.agent_applications set status = 'stopped', desired_state = 'stopped',
			service_availability = null where agent_id = 'agent_task'`;
		expect(await task.submitTask(command("stopped"))).toEqual({
			outcome: "denied",
			reason: "agent_unavailable",
		});
		expect(await counts()).toEqual({
			conversations: 3,
			executions: 0,
			messages: 0,
			outboxes: 0,
			audits: 0,
			idempotency: 0,
		});
	});

	it("admits during startup or update, then rejects an unavailable Agent", async () => {
		const task = taskUseCase();
		await sql`update platform.agent_applications set service_availability = 'starting' where agent_id = 'agent_task'`;
		expect((await task.submitTask(command("starting"))).outcome).toBe(
			"accepted",
		);
		await sql`update platform.agent_applications set service_availability = 'updating' where agent_id = 'agent_task'`;
		expect((await task.submitTask(command("updating"))).outcome).toBe(
			"accepted",
		);
		await sql`update platform.agent_applications set service_availability = 'unavailable',
			failure_code = 'workload_unavailable' where agent_id = 'agent_task'`;
		expect(await task.submitTask(command("unavailable"))).toEqual({
			outcome: "denied",
			reason: "agent_unavailable",
		});
		expect(await counts()).toEqual({
			conversations: 2,
			executions: 2,
			messages: 2,
			outboxes: 2,
			audits: 2,
			idempotency: 2,
		});
	});

	it("rejects a stale Agent authorization revision before writing task rows", async () => {
		await sql`update platform.agents set authorization_revision = 'grant_2' where id = 'agent_task'`;
		expect(await taskUseCase().submitTask(command("stale_grant"))).toEqual({
			outcome: "denied",
			reason: "agent_unavailable",
		});
		expect(await counts()).toEqual({
			conversations: 0,
			executions: 0,
			messages: 0,
			outboxes: 0,
			audits: 0,
			idempotency: 0,
		});
	});

	it("preserves an active same-channel Turn's supplementary instruction while a task waits", async () => {
		const conversationCommands = createConversationExecutionUseCaseV1(
			{
				authorization: {
					async authorize() {
						return { outcome: "allowed", authority: currentAuthority };
					},
				},
				transaction: store,
			},
			{ now },
		);
		const created = await conversationCommands.createConversation({
			schemaVersion: 1,
			agentId: "agent_task",
			idempotencyKey: "create_web",
			requestId: "request_create",
			traceId: "trace_create",
		});
		if (created.outcome !== "accepted")
			throw new Error("Expected Conversation");
		const conversationId = created.result.conversationId;
		expect(
			(
				await conversationCommands.accept({
					schemaVersion: 1,
					command: "message",
					conversationId,
					text: "first message",
					idempotencyKey: "message_first",
					requestId: "request_first",
					traceId: "trace_first",
				})
			).outcome,
		).toBe("accepted");
		expect(
			(await taskUseCase().submitTask(command("queued", { conversationId })))
				.outcome,
		).toBe("accepted");
		currentAuthority = {
			...currentAuthority,
			supportsSupplementaryInstruction: true,
		};
		const supplement = await conversationCommands.accept({
			schemaVersion: 1,
			command: "message",
			conversationId,
			text: "same-channel supplement",
			idempotencyKey: "message_supplement",
			requestId: "request_supplement",
			traceId: "trace_supplement",
		});
		expect(supplement.outcome).toBe("accepted");
		const [state] = await sql<{ executions: number; messages: number }[]>`
			select (select count(*)::int from platform.conversation_executions) as executions,
				(select count(*)::int from platform.conversation_messages) as messages`;
		expect(state).toEqual({ executions: 2, messages: 3 });
	});

	it("rolls back every admission row when the outbox insert fails", async () => {
		await sql`create function platform.reject_task_outbox() returns trigger language plpgsql as $$
			begin raise exception 'injected outbox failure'; end $$`;
		await sql`create trigger reject_task_outbox before insert on platform.outbox_items
			for each row execute function platform.reject_task_outbox()`;
		try {
			await expect(
				taskUseCase().submitTask(command("rollback")),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(await counts()).toEqual({
				conversations: 0,
				executions: 0,
				messages: 0,
				outboxes: 0,
				audits: 0,
				idempotency: 0,
			});
		} finally {
			await sql`drop trigger reject_task_outbox on platform.outbox_items`;
			await sql`drop function platform.reject_task_outbox()`;
		}
	});
});
