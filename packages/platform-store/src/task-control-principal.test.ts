import type {
	TaskAuthorizationBoundaryV1,
	TaskPrincipalV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { PostgresConversationDispatchStoreV1 } from "./conversation-dispatch.js";
import { claimWork } from "./conversation-dispatch-claim.js";
import {
	bindingMatches,
	lockConversation,
	lockExecution,
	lockOutbox,
} from "./conversation-dispatch-sql.js";
import { waitingDecision } from "./conversation-dispatch-task.js";
import { exactPayload } from "./conversation-dispatch-validation.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import {
	insertTaskAuthorization,
	PostgresTaskAuthorizationStoreV1,
	TaskAuthorizationStoreError,
} from "./task-authorization.js";

let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
let store: PostgresTaskAuthorizationStoreV1;
const userDirectory = {
	resolveUser: async (userId: string) => ({
		schemaVersion: 1,
		userId,
		accountStatus: "active",
		organizationIds: [],
		authorizationRevision: "identity-1",
	}),
};

const boundary = (
	kind: TaskPrincipalV1["kind"],
): TaskAuthorizationBoundaryV1 => ({
	schemaVersion: 1,
	principal: { kind, id: "same-id" },
	agentId: "agent",
	channelId: "api",
	identityRevision: "identity-1",
	agentAuthorizationRevision: "agent-1",
	accessSources: [{ kind: "api-use", useGrantRevision: "use-1" }],
});

beforeAll(async () => {
	database = await startPostgresTestDatabase("task-control-principal");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 1 });
	store = new PostgresTaskAuthorizationStoreV1({
		databaseUrl: database.databaseUrl,
	});
}, 120_000);
afterEach(async () => {
	await client`truncate platform.platform_user_disables, platform.platform_api_credentials, platform.platform_applications, platform.audit_events, platform.task_control_records, platform.task_authorization_records,
		platform.conversation_stops, platform.outbox_items, platform.conversation_executions,
		platform.conversations, platform.agents cascade`;
});
afterAll(async () => {
	await store?.close();
	await client?.end();
	await database?.stop();
});

async function seed(kind: TaskPrincipalV1["kind"]) {
	await client`insert into platform.agents (id, authorization_revision) values ('agent', 'agent-1'), ('other-agent', 'agent-1')`;
	await client`insert into platform.conversations
		(id, agent_id, actor_id, channel_id, principal_type, status, session_generation, authorization_revision)
		values ('conversation', 'agent', 'same-id', 'api', ${kind}, 'ready', 1, 'agent-1')`;
	await client`insert into platform.conversation_executions
		(execution_id, conversation_id, agent_id, actor_id, channel_id, principal_type, turn_id, status,
		session_generation, authorization_revision, created_at)
		values ('execution', 'conversation', 'agent', 'same-id', 'api', ${kind}, 'turn', 'completed', 1, 'agent-1', now())`;
	await client.begin((transaction) =>
		insertTaskAuthorization(transaction, {
			executionId: "execution",
			boundary: boundary(kind),
			traceId: "trace",
			requestId: "request",
		}),
	);
}

async function control(
	reason: "stop" | "authorization_revoked" | "recovery" = "recovery",
) {
	const [record] =
		await client`select id from platform.task_authorization_records where execution_id = 'execution'`;
	if (!record) throw new Error("Missing seeded authority");
	return store.recordControl({
		executionId: "execution",
		authorizationRecordId: record.id,
		reason,
		workerId: "worker",
		traceId: "trace",
		requestId: "request",
	});
}

async function expectNoControlEffects() {
	expect(
		await client`select id from platform.task_control_records`,
	).toHaveLength(0);
	expect(
		await client`select execution_id from platform.conversation_stops`,
	).toHaveLength(0);
	expect(await client`select id from platform.outbox_items`).toHaveLength(0);
	expect(
		await client`select id from platform.audit_events where action = 'task.control.created'`,
	).toHaveLength(0);
	const [record] =
		await client`select revoked_at from platform.task_authorization_records where execution_id = 'execution'`;
	expect(record?.revoked_at).toBeNull();
}

describe("System controls use the durable typed Execution principal", () => {
	it.each(["user", "application"] as const)(
		"persists the original %s namespace even when actor IDs match",
		async (kind) => {
			await seed(kind);
			const result = await control();
			const [audit] =
				await client`select actor_type, actor_id, details from platform.audit_events where action = 'task.control.created'`;
			expect(audit).toMatchObject({
				actor_type: "system",
				actor_id: "worker",
				details: {
					originalPrincipal: { kind, id: "same-id" },
					controlRecordId: result.controlRecordId,
				},
			});
		},
	);
	it.each(["principal", "actor", "agent", "channel"] as const)(
		"refuses a C/E %s mismatch at the database write boundary",
		async (field) => {
			await seed("application");
			const update =
				field === "principal"
					? client`update platform.conversations set principal_type = 'user' where id = 'conversation'`
					: field === "actor"
						? client`update platform.conversations set actor_id = 'other-actor' where id = 'conversation'`
						: field === "agent"
							? client`update platform.conversations set agent_id = 'other-agent' where id = 'conversation'`
							: client`update platform.conversations set channel_id = 'web' where id = 'conversation'`;
			await expect(update).rejects.toMatchObject({
				code: field === "channel" ? "23514" : "23503",
			});
			const [conversation] =
				await client`select principal_type, actor_id, agent_id, channel_id from platform.conversations where id = 'conversation'`;
			expect(conversation).toEqual({
				principal_type: "application",
				actor_id: "same-id",
				agent_id: "agent",
				channel_id: "api",
			});
			await expectNoControlEffects();
		},
	);
	it("rejects a same-ID boundary in the opposite principal namespace", async () => {
		await seed("application");
		await client`update platform.task_authorization_records set boundary = ${client.json(boundary("user") as unknown as postgres.JSONValue)} where execution_id = 'execution'`;
		await expect(control()).rejects.toBeInstanceOf(TaskAuthorizationStoreError);
		await expectNoControlEffects();
	});
	it("rolls back stop, outbox, control and revocation when required audit fails", async () => {
		await seed("application");
		await client`update platform.conversation_executions set status = 'processing' where execution_id = 'execution'`;
		await client`create function platform.fail_typed_control_audit() returns trigger language plpgsql as $$ begin raise exception 'controlled control audit failure'; end $$`;
		try {
			await client`create trigger fail_typed_control_audit before insert on platform.audit_events for each row execute function platform.fail_typed_control_audit()`;
			await expect(control("authorization_revoked")).rejects.toBeInstanceOf(
				TaskAuthorizationStoreError,
			);
			await expectNoControlEffects();
		} finally {
			await client`drop trigger if exists fail_typed_control_audit on platform.audit_events`;
			await client`drop function platform.fail_typed_control_audit()`;
		}
	});
	it("keeps a committed revocation when recovery later records authority", async () => {
		await seed("application");
		await control("authorization_revoked");
		const [revoked] =
			await client`select revoked_at from platform.task_authorization_records where execution_id = 'execution'`;
		await control("recovery");
		const [after] =
			await client`select revoked_at from platform.task_authorization_records where execution_id = 'execution'`;
		expect(revoked?.revoked_at).toBeInstanceOf(Date);
		expect(after?.revoked_at).toEqual(revoked?.revoked_at);
	});
});

// Synthetic SQL exercises the original waiting/control transaction, not API credential or native acceptance.
async function waitingTask(kind: TaskPrincipalV1["kind"]) {
	await seed(kind);
	if (kind === "application") {
		await client`insert into platform.platform_applications (id, name, responsible_user_id, authorization_revision)
			values ('same-id', 'Fixture', 'owner', 'identity-1')`;
	}
	await client`insert into platform.agent_principal_grants (agent_id, principal_type, principal_id, grant_type, authorization_revision) values ('agent', ${kind}, 'same-id', 'use', 'use-1')`;
	await client`insert into platform.agent_applications
		(id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at, management_revision, approval_revision, desired_state, service_availability, workload_revision, fence)
		values ('agent-application', 'agent', 'owner', 'Agent', 'Fixture', 'available', 'trace', 'request', now(), 1, 1, 'running', 'ready', 1, 1)`;
	await client`insert into platform.agent_owners (agent_id, owner_id, created_at) values ('agent', 'owner', now())`;

	await client`update platform.conversation_executions set status = 'waiting', task_wait_order = 1,
		task_wait_deadline = clock_timestamp() + interval '60 seconds' where execution_id = 'execution'`;
	await client`insert into platform.conversation_messages
		(message_id, conversation_id, actor_id, role, text, execution_id, status, created_at, updated_at)
		values ('waiting-message', 'conversation', 'same-id', 'user', 'controlled waiting fixture', 'execution', 'submitted', now(), now())`;
	await client`insert into platform.outbox_items (id, scope_type, scope_id, operation, payload, trace_id, request_id)
		values ('conversation:turn:execution', 'conversation', 'conversation', 'conversation.turn.submit.v1', ${client.json(
			{
				schemaVersion: 1,
				conversationId: "conversation",
				executionId: "execution",
				messageId: "waiting-message",
				turnId: "turn",
				sessionGeneration: 1,
			},
		)}, 'trace', 'request')`;
}
async function waitingSnapshot() {
	return {
		executions:
			await client`select * from platform.conversation_executions order by execution_id`,
		conversations:
			await client`select * from platform.conversations order by id`,
		outboxes: await client`select * from platform.outbox_items order by id`,
		messages:
			await client`select * from platform.conversation_messages order by message_id`,
		events:
			await client`select * from platform.conversation_events order by sequence`,
		conversationAudits:
			await client`select * from platform.conversation_audit_events order by id`,
		audits: await client`select * from platform.audit_events order by id`,
		controls:
			await client`select * from platform.task_control_records order by id`,
		stops:
			await client`select * from platform.conversation_stops order by execution_id`,
		authorizations:
			await client`select * from platform.task_authorization_records order by id`,
	};
}

async function waitForBlockedControl(ownerPid: number, queryFragment: string) {
	await vi.waitFor(async () => {
		const [blocked] = await client<{ blocked: boolean }[]>`
			select exists (
				select 1 from pg_stat_activity
				where datname = current_database() and wait_event_type = 'Lock'
					and ${ownerPid} = any(pg_blocking_pids(pid))
					and query like ${`%${queryFragment}%`}
			) as blocked
		`;
		expect(blocked?.blocked).toBe(true);
	});
}

describe("original system control lock order", () => {
	it.each(["processing", "completed"] as const)(
		"leaves the original outbox available while %s control waits for Conversation",
		async (status) => {
			await waitingTask("application");
			await client`update platform.conversation_executions set status = ${status} where execution_id = 'execution'`;
			const blocker = postgres(database.databaseUrl, { max: 1 });
			let pending: Promise<unknown> | undefined;
			try {
				await blocker.begin(async (transaction) => {
					const [owner] = await transaction<{ pid: number }[]>`
						select pg_backend_pid() as pid
					`;
					if (!owner) throw new Error("Missing control lock owner");
					await transaction`select id from platform.conversations where id = 'conversation' for update`;
					pending = control().then(
						(result) => result,
						(error: unknown) => ({ error }),
					);
					await waitForBlockedControl(owner.pid, "for update of conversation");
					// The original metadata-recovery order is Conversation -> Outbox.
					await transaction`select id from platform.outbox_items where id = 'conversation:turn:execution' for update`;
				});
				expect(await pending).toHaveProperty("controlRecordId");
			} finally {
				await pending;
				await blocker.end();
			}
		},
	);

	for (const reason of ["stop", "authorization_revoked"] as const) {
		it.each(["processing", "completed"] as const)(
			`rejects waiting ${reason} after Conversation wait changes to %s`,
			async (status) => {
				await waitingTask("application");
				const before = await waitingSnapshot();
				const conversationOwner = postgres(database.databaseUrl, { max: 1 });

				let pending: Promise<void> | undefined;
				let outcome: { error?: unknown; result?: unknown } | undefined;
				try {
					await conversationOwner.begin(async (conversationTransaction) => {
						await conversationTransaction`select id from platform.conversations where id = 'conversation' for update`;
						const [owner] = await conversationTransaction<
							{ pid: number }[]
						>`select pg_backend_pid() as pid`;
						if (!owner) throw new Error("Missing Conversation lock owner");
						pending = control(reason).then(
							(result) => {
								outcome = { result };
							},
							(error: unknown) => {
								outcome = { error };
							},
						);
						await waitForBlockedControl(
							owner.pid,
							"from platform.conversations",
						);
						// Control cannot hold Outbox while waiting for Conversation.
						await conversationTransaction`select id from platform.outbox_items where id = 'conversation:turn:execution' for update`;
						await conversationTransaction`update platform.conversation_executions set status = ${status} where execution_id = 'execution'`;
					});
					await pending;
					expect(outcome?.error).toBeInstanceOf(TaskAuthorizationStoreError);
					expect(await waitingSnapshot()).toEqual({
						...before,
						executions: before.executions.map((execution) => ({
							...execution,
							status,
						})),
					});
				} finally {
					await pending;
					await conversationOwner.end();
				}
			},
		);
	}
});

describe("original typed waiting control finisher", () => {
	it.each([
		["user", "stop"],
		["user", "authorization_revoked"],
		["application", "stop"],
		["application", "authorization_revoked"],
	] as const)(
		"finishes %s waiting %s in the original transaction",
		async (kind, reason) => {
			await waitingTask(kind);
			const result = await control(reason);
			const after = await waitingSnapshot();
			expect(after.executions).toHaveLength(1);
			expect(after.executions[0]).toMatchObject({
				execution_id: "execution",
				turn_id: "turn",
				principal_type: kind,
				actor_id: "same-id",
				status: "cancelled",
				delivery_fence: "0",
				last_event_sequence: "1",
			});
			expect(after.outboxes).toHaveLength(1);
			expect(after.outboxes[0]).toMatchObject({
				id: "conversation:turn:execution",
				status: "failed",
				delivery_fence: "0",
				lease_owner: null,
				lease_expires_at: null,
			});
			expect(after.messages[0]).toMatchObject({
				message_id: "waiting-message",
				execution_id: "execution",
				status: "failed",
				failure_code:
					reason === "stop" ? "TASK_CANCELLED" : "AUTHORIZATION_REVOKED",
			});
			expect(after.conversations[0]).toMatchObject({
				id: "conversation",
				principal_type: kind,
				actor_id: "same-id",
				session_generation: "1",
				last_conversation_cursor: "1",
				host_session_ref: null,
			});
			expect(after.events).toHaveLength(1);
			expect(after.events[0]).toMatchObject({
				conversation_id: "conversation",
				execution_id: "execution",
				event_type: "task.status",
				runtime_cursor: null,
				event_payload: { status: "cancelled" },
			});
			expect(after.controls).toHaveLength(1);
			expect(after.controls[0]).toMatchObject({
				id: result.controlRecordId,
				execution_id: "execution",
				reason,
			});
			expect(after.stops).toHaveLength(0);
			expect(
				after.audits.filter((row) => row.action === "task.status.changed"),
			).toHaveLength(1);
			expect(
				after.audits.filter((row) => row.action === "task.control.created"),
			).toHaveLength(1);
			for (const audit of after.audits.filter((row) =>
				["task.status.changed", "task.control.created"].includes(row.action),
			))
				expect(audit.details.originalPrincipal).toEqual({
					kind,
					id: "same-id",
				});
			if (reason === "authorization_revoked")
				expect(after.authorizations[0]?.revoked_at).toBeInstanceOf(Date);
			else expect(after.authorizations[0]?.revoked_at).toBeNull();
		},
	);
	it.each(["task.status.changed", "task.control.created"] as const)(
		"rolls back every waiting fact when %s audit fails",
		async (action) => {
			await waitingTask("application");
			const before = await waitingSnapshot();
			await client.unsafe(
				`create function platform.fail_typed_waiting_audit() returns trigger language plpgsql as $$ begin if new.action = '${action}' then raise exception 'controlled waiting audit failure'; end if; return new; end $$`,
			);
			try {
				await client`create trigger fail_typed_waiting_audit before insert on platform.audit_events for each row execute function platform.fail_typed_waiting_audit()`;
				await expect(control("authorization_revoked")).rejects.toBeInstanceOf(
					TaskAuthorizationStoreError,
				);
				expect(await waitingSnapshot()).toEqual(before);
			} finally {
				await client`drop trigger if exists fail_typed_waiting_audit on platform.audit_events`;
				await client`drop function platform.fail_typed_waiting_audit()`;
			}
		},
	);
	it("refuses the same-ID opposite boundary before changing waiting facts", async () => {
		await waitingTask("application");
		await client`update platform.task_authorization_records set boundary = ${client.json(boundary("user") as unknown as postgres.JSONValue)} where execution_id = 'execution'`;
		const before = await waitingSnapshot();
		await expect(control("stop")).rejects.toBeInstanceOf(
			TaskAuthorizationStoreError,
		);
		expect(await waitingSnapshot()).toEqual(before);
	});
});

// Legal admission/model.select can leave C/E revisions different; cancellation
// preserves both original records while normal business dispatch remains strict.
describe("waiting cancellation after Conversation authorization changes", () => {
	for (const kind of ["user", "application"] as const) {
		for (const reason of ["stop", "authorization_revoked"] as const) {
			it.each([
				"older-conversation",
				"newer-conversation",
				"unavailable",
			] as const)(
				`${kind} ${reason} cancels with %s without rebinding the original Execution`,
				async (scenario) => {
					await waitingTask(kind);
					await client`update platform.conversations
						set authorization_revision = ${scenario === "older-conversation" ? "agent-0" : scenario === "newer-conversation" ? "agent-2" : "agent-1"},
							status = ${scenario === "unavailable" ? "unavailable" : "active"}, host_session_ref = 'original-occupied-session'
						where id = 'conversation'`;
					await client.begin(async (transaction) => {
						const outbox = await lockOutbox(
							transaction,
							"conversation:turn:execution",
						);
						const conversation = await lockConversation(
							transaction,
							"conversation",
						);
						const execution = await lockExecution(
							transaction,
							"conversation",
							"execution",
						);
						const payload =
							outbox &&
							exactPayload(outbox.payload, "conversation.turn.submit.v1");
						if (!outbox || !conversation || !execution || !payload)
							throw new Error("Missing original waiting state");
						expect(
							bindingMatches(outbox, payload, conversation, execution),
						).toBe(false);
					});
					const before = await waitingSnapshot();
					await control(reason);
					const after = await waitingSnapshot();
					expect(after.executions).toHaveLength(1);
					expect(after.executions[0]).toEqual({
						...before.executions[0],
						status: "cancelled",
						last_event_sequence: "1",
						updated_at: expect.any(Date),
					});
					expect(after.conversations[0]).toEqual({
						...before.conversations[0],
						last_conversation_cursor: "1",
						updated_at: expect.any(Date),
					});
					expect(after.outboxes).toHaveLength(1);
					expect(after.outboxes[0]).toEqual({
						...before.outboxes[0],
						status: "failed",
						lease_owner: null,
						lease_expires_at: null,
						updated_at: expect.any(Date),
					});
					expect(after.messages[0]).toMatchObject({
						status: "failed",
						failure_code:
							reason === "stop" ? "TASK_CANCELLED" : "AUTHORIZATION_REVOKED",
					});
					expect(after.events).toHaveLength(1);
					expect(after.events[0]).toMatchObject({
						event_type: "task.status",
						source: "platform",
						runtime_cursor: null,
						event_payload: { status: "cancelled" },
					});
					expect(after.stops).toHaveLength(0);
					expect(after.controls).toHaveLength(1);
					expect(after.controls[0]).toMatchObject({
						reason,
						execution_id: "execution",
					});
					for (const action of [
						"task.status.changed",
						"task.control.created",
					]) {
						const audits = after.audits.filter((row) => row.action === action);
						expect(audits).toHaveLength(1);
						expect(audits[0]?.details.originalPrincipal).toEqual({
							kind,
							id: "same-id",
						});
					}
					if (reason === "authorization_revoked")
						expect(after.authorizations[0]?.revoked_at).toBeInstanceOf(Date);
					else expect(after.authorizations).toEqual(before.authorizations);
				},
			);
		}
	}
});

describe("waiting settlement and per-Conversation ordering", () => {
	it.each(["user", "application"] as const)(
		"fails a never-sent %s task when its Conversation becomes unavailable",
		async (kind) => {
			await waitingTask(kind);
			await client`update platform.conversations set status = 'unavailable', authorization_revision = 'agent-2' where id = 'conversation'`;
			const result = await client.begin((transaction) =>
				claimWork(
					transaction,
					{
						schemaVersion: 1,
						itemId: "conversation:turn:execution",
						workerId: "worker",
						leaseDurationMs: 30_000,
					},
					userDirectory,
				),
			);
			expect(result).toEqual({ outcome: "failed" });
			const after = await waitingSnapshot();
			expect(after.executions[0]).toMatchObject({
				status: "failed",
				principal_type: kind,
				delivery_fence: "0",
				last_event_sequence: "1",
			});
			expect(after.outboxes[0]).toMatchObject({
				status: "failed",
				delivery_fence: "0",
				lease_owner: null,
			});
			expect(after.messages[0]).toMatchObject({
				status: "failed",
				failure_code: "CONVERSATION_UNAVAILABLE",
			});
		},
	);
	it.each(["same", "other"] as const)(
		"considers an earlier waiting task in the %s Conversation",
		async (location) => {
			await waitingTask("application");
			await client`update platform.conversation_executions set task_wait_order = 2 where execution_id = 'execution'`;
			await client`insert into platform.conversations (id, agent_id, actor_id, channel_id, principal_type, status, session_generation, authorization_revision)
				values ('other-conversation', 'agent', 'same-id', 'api', 'application', 'ready', 1, 'agent-1')`;
			await client`insert into platform.conversation_executions
				(execution_id, conversation_id, agent_id, actor_id, channel_id, principal_type, turn_id, status, session_generation, authorization_revision, task_wait_order, task_wait_deadline, created_at)
				values ('earlier', ${location === "same" ? "conversation" : "other-conversation"}, 'agent', 'same-id', 'api', 'application', 'earlier-turn', 'waiting', 1, 'agent-1', 1, clock_timestamp() + interval '60 seconds', now())`;
			const result = await client.begin(async (transaction) => {
				const outbox = await lockOutbox(
					transaction,
					"conversation:turn:execution",
				);
				const conversation = await lockConversation(
					transaction,
					"conversation",
				);
				const execution = await lockExecution(
					transaction,
					"conversation",
					"execution",
				);
				if (!outbox || !conversation || !execution)
					throw new Error("Missing waiting fixture");
				return waitingDecision(
					transaction,
					{ outbox, conversation, execution },
					{
						status: "available",
						desired_state: "running",
						service_availability: "ready",
					},
					false,
				);
			});
			expect(result).toEqual({
				outcome: location === "same" ? "wait" : "dispatch",
			});
		},
	);
});

describe("application invalidation before waiting availability", () => {
	it.each(["disabled", "revision", "grant-revoked", "grant-revision"] as const)(
		"discovers and durably cancels %s while the Agent is starting, including after restart",
		async (change) => {
			await waitingTask("application");
			await client`update platform.agent_applications set service_availability = 'starting' where agent_id = 'agent'`;
			await client`update platform.outbox_items set available_at = 'infinity' where id = 'conversation:turn:execution'`;
			if (change === "disabled")
				await client`update platform.platform_applications set status = 'disabled' where id = 'same-id'`;
			if (change === "revision")
				await client`update platform.platform_applications set authorization_revision = 'identity-2' where id = 'same-id'`;
			if (change === "grant-revoked")
				await client`update platform.agent_principal_grants set revoked_at = now() where principal_type = 'application' and principal_id = 'same-id'`;
			if (change === "grant-revision")
				await client`update platform.agent_principal_grants set authorization_revision = 'use-2' where principal_type = 'application' and principal_id = 'same-id'`;
			let dispatch = new PostgresConversationDispatchStoreV1({
				databaseUrl: database.databaseUrl,
			});
			try {
				expect(await dispatch.findDispatchable({ limit: 8 })).toContainEqual({
					itemId: "conversation:turn:execution",
					operation: "conversation.turn.submit.v1",
				});
				await dispatch.close();
				dispatch = new PostgresConversationDispatchStoreV1({
					databaseUrl: database.databaseUrl,
				});
				expect(
					await dispatch.claim({
						schemaVersion: 1,
						itemId: "conversation:turn:execution",
						workerId: "worker",
						leaseDurationMs: 30_000,
					}),
				).toEqual({ outcome: "failed" });
				const after = await waitingSnapshot();
				expect(after.executions[0]).toMatchObject({
					status: "cancelled",
					last_event_sequence: "1",
				});
				expect(after.outboxes[0]).toMatchObject({ status: "failed" });
				expect(
					await client`select revoked_at from platform.task_authorization_records where execution_id = 'execution'`,
				).toEqual([{ revoked_at: expect.any(Date) }]);
				expect(
					await client`select reason from platform.task_control_records where execution_id = 'execution'`,
				).toEqual([{ reason: "authorization_revoked" }]);
				expect(
					await client`select action from platform.audit_events where action = 'task.control.created'`,
				).toHaveLength(1);
				await dispatch.close();
				dispatch = new PostgresConversationDispatchStoreV1({
					databaseUrl: database.databaseUrl,
				});
				expect(await dispatch.findDispatchable({ limit: 8 })).toEqual([]);
				expect(
					await dispatch.claim({
						schemaVersion: 1,
						itemId: "conversation:turn:execution",
						workerId: "restarted-worker",
						leaseDurationMs: 30_000,
					}),
				).toEqual({ outcome: "failed" });
			} finally {
				await dispatch.close();
			}
		},
	);
	it("does not cancel accepted application work when only its credential expired", async () => {
		await waitingTask("application");
		await client`insert into platform.platform_api_credentials (id, principal_type, principal_id, credential_hash, scopes, expires_at)
			values ('expired', 'application', 'same-id', ${"a".repeat(64)}, '["agent:use"]'::jsonb, now() - interval '1 minute')`;
		const result = await client.begin((transaction) =>
			claimWork(transaction, {
				schemaVersion: 1,
				itemId: "conversation:turn:execution",
				workerId: "worker",
				leaseDurationMs: 30_000,
			}),
		);
		expect(result.outcome).toBe("claimed");
		expect(
			await client`select revoked_at from platform.task_authorization_records where execution_id = 'execution'`,
		).toEqual([{ revoked_at: null }]);
		expect(await client`select id from platform.task_control_records`).toEqual(
			[],
		);
	});
});

it("does not revoke a user Task when an application with the same ID is disabled", async () => {
	await waitingTask("user");
	await client`insert into platform.platform_applications (id, name, responsible_user_id, status, authorization_revision)
		values ('same-id', 'Other namespace', 'owner', 'disabled', 'identity-2')`;
	const result = await client.begin((transaction) =>
		claimWork(
			transaction,
			{
				schemaVersion: 1,
				itemId: "conversation:turn:execution",
				workerId: "worker",
				leaseDurationMs: 30_000,
			},
			userDirectory,
		),
	);
	expect(result.outcome).toBe("claimed");
	expect(
		await client`select revoked_at from platform.task_authorization_records where execution_id = 'execution'`,
	).toEqual([{ revoked_at: null }]);
	expect(await client`select id from platform.task_control_records`).toEqual(
		[],
	);
});

describe("waiting user authority", () => {
	it.each(["claim", "prepare"] as const)(
		"settles an expired waiting user task at %s during a directory outage and preserves the result after restart",
		async (phase) => {
			await waitingTask("user");
			let directoryUnavailable = phase === "claim";
			const options = {
				...database,
				userDirectory: {
					resolveUser: async (id: string) => {
						if (directoryUnavailable)
							throw new Error("controlled directory outage");
						return userDirectory.resolveUser(id);
					},
				},
			};
			const request = {
				schemaVersion: 1 as const,
				itemId: "conversation:turn:execution",
				workerId: "worker",
				leaseDurationMs: 30_000,
			};
			let dispatch = new PostgresConversationDispatchStoreV1(options);
			try {
				const claimed =
					phase === "prepare" ? await dispatch.claim(request) : undefined;
				directoryUnavailable = true;
				await client`update platform.conversation_executions set created_at = clock_timestamp() - interval '2 seconds', task_wait_deadline = clock_timestamp() - interval '1 second' where execution_id = 'execution'`;
				await client`update platform.agent_applications set service_availability = 'starting' where agent_id = 'agent'`;
				await client`update platform.outbox_items set available_at = 'infinity' where id = 'conversation:turn:execution'`;
				if (phase === "claim")
					expect(await dispatch.findDispatchable({ limit: 8 })).toContainEqual({
						itemId: request.itemId,
						operation: "conversation.turn.submit.v1",
					});
				if (phase === "prepare") {
					if (claimed?.outcome !== "claimed")
						throw new Error("Expected waiting claim");
					expect(
						await dispatch.prepareRuntimeDispatch({
							claim: claimed.claim,
							leaseDurationMs: 30_000,
						}),
					).toBe(false);
				} else
					expect(await dispatch.claim(request)).toEqual({ outcome: "failed" });
				const after = await waitingSnapshot();
				expect(after.executions[0]).toMatchObject({
					status: "failed",
					delivery_fence: phase === "prepare" ? "1" : "0",
					last_event_sequence: "1",
				});
				expect(after.outboxes[0]).toMatchObject({
					status: "failed",
					lease_owner: null,
				});
				expect(after.authorizations[0]?.revoked_at).toBeNull();
				await dispatch.close();
				dispatch = new PostgresConversationDispatchStoreV1(options);
				expect(
					await dispatch.claim({ ...request, workerId: "restarted" }),
				).toEqual({ outcome: "failed" });
				expect(await waitingSnapshot()).toEqual(after);
			} finally {
				await dispatch.close();
			}
		},
	);
	it.each([
		"disabled",
		"missing",
		"platform-disabled",
		"disabled-directory-unavailable",
		"grant-revoked",
		"revoked-directory-unavailable",
		"grant-revision",
		"grant-revision-directory-unavailable",
	] as const)(
		"durably cancels %s before availability and preserves settlement after restart",
		async (change) => {
			await waitingTask("user");
			await client`update platform.agent_applications set service_availability = 'starting' where agent_id = 'agent'`;
			await client`update platform.outbox_items set available_at = 'infinity' where id = 'conversation:turn:execution'`;
			if (
				change === "platform-disabled" ||
				change === "disabled-directory-unavailable"
			)
				await client`insert into platform.platform_user_disables (user_id) values ('same-id')`;
			if (
				change === "grant-revoked" ||
				change === "revoked-directory-unavailable"
			)
				await client`update platform.agent_principal_grants set revoked_at = now() where principal_type = 'user'`;
			if (
				change === "grant-revision" ||
				change === "grant-revision-directory-unavailable"
			)
				await client`update platform.agent_principal_grants set authorization_revision = 'use-2' where principal_type = 'user'`;
			const directory = {
				resolveUser: async (id: string) => {
					if (change.endsWith("directory-unavailable"))
						throw new Error("controlled directory failure");
					return change === "missing"
						? null
						: {
								...(await userDirectory.resolveUser(id)),
								accountStatus: change === "disabled" ? "disabled" : "active",
							};
				},
			};
			let dispatch = new PostgresConversationDispatchStoreV1({
				...database,
				userDirectory: directory,
			});
			const request = {
				schemaVersion: 1 as const,
				itemId: "conversation:turn:execution",
				workerId: "worker",
				leaseDurationMs: 30_000,
			};
			try {
				expect(await dispatch.findDispatchable({ limit: 8 })).toContainEqual({
					itemId: request.itemId,
					operation: "conversation.turn.submit.v1",
				});
				expect(await dispatch.claim(request)).toEqual({ outcome: "failed" });
				const after = await waitingSnapshot();
				expect(after.executions[0]).toMatchObject({
					status: "cancelled",
					last_event_sequence: "1",
				});
				expect(after.outboxes[0]).toMatchObject({ status: "failed" });
				expect(
					await client`select revoked_at from platform.task_authorization_records where execution_id = 'execution'`,
				).toEqual([{ revoked_at: expect.any(Date) }]);
				expect(
					await client`select reason from platform.task_control_records where execution_id = 'execution'`,
				).toEqual([{ reason: "authorization_revoked" }]);
				await dispatch.close();
				dispatch = new PostgresConversationDispatchStoreV1({
					...database,
					userDirectory,
				});
				expect(await dispatch.claim(request)).toEqual({ outcome: "failed" });
				expect(await waitingSnapshot()).toEqual(after);
			} finally {
				await dispatch.close();
			}
		},
	);
	it("keeps accepted work after credential expiry and fails closed on directory failure", async () => {
		await waitingTask("user");
		await client`insert into platform.platform_api_credentials (id, principal_type, principal_id, credential_hash, scopes, expires_at) values ('expired', 'user', 'same-id', ${"b".repeat(64)}, '["agent:use"]'::jsonb, now() - interval '1 minute')`;
		const before = await waitingSnapshot();
		const request = {
			schemaVersion: 1 as const,
			itemId: "conversation:turn:execution",
			workerId: "worker",
			leaseDurationMs: 30_000,
		};
		const unavailable = new PostgresConversationDispatchStoreV1({
			...database,
			userDirectory: {
				resolveUser: async () => {
					throw new Error("controlled failure");
				},
			},
		});
		try {
			await expect(unavailable.claim(request)).rejects.toThrow();
			expect(await waitingSnapshot()).toEqual(before);
		} finally {
			await unavailable.close();
		}
		const dispatch = new PostgresConversationDispatchStoreV1({
			...database,
			userDirectory,
		});
		try {
			expect((await dispatch.claim(request)).outcome).toBe("claimed");
			expect(
				await client`select id from platform.task_control_records`,
			).toEqual([]);
		} finally {
			await dispatch.close();
		}
	});
});
