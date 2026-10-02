import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import {
	TaskAcceptedV1Schema,
	TaskCancellationV1Schema,
	TaskProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	createConversationExecutionUseCaseV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresConversationExecutionTransactionV1,
	PostgresConversationQueryV1,
} from "@agent-infra/platform-store";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createClient } from "../../web/src/pilot/generated/client/index.ts";
import {
	cancelAgentTask,
	getAgentTask,
	submitAgentTask,
} from "../../web/src/pilot/generated/index.ts";
import { createTaskRoutesDependenciesV1 } from "./http/task-dependencies.js";
import { registerTaskRoutes } from "./http/task-routes.js";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "./index.js";

const material = {
	user: `papi_${"U".repeat(43)}`,
	application: `papi_${"A".repeat(43)}`,
};
const configuration = {
	...agentConfigurationConformanceRecordV1,
	schemaVersion: 1 as const,
	actions: [],
	actionSetRevision: "actions_1",
};
type Kind = keyof typeof material;
interface Accepted {
	conversationId: string;
	executionId: string;
	messageId: string;
}
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let transaction: PostgresConversationExecutionTransactionV1;
let query: PostgresConversationQueryV1;
let router: Hono;
const directory: TaskUserDirectoryV1 = {
	async resolveUser() {
		return {
			schemaVersion: 1,
			userId: "same-id",
			accountStatus: "active",
			organizationIds: [],
			authorizationRevision: "user-1",
		};
	},
};
function request(path: string, kind: Kind, body?: unknown, key = "submit") {
	return router.request(path, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			Authorization: `Bearer ${material[kind]}`,
			"Content-Type": "application/json",
			"Idempotency-Key": key,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
async function submit(kind: Kind, key = "submit") {
	const response = await request(
		`/api/v1/agents/${configuration.agentId}/tasks`,
		kind,
		{ schemaVersion: 1, text: "synthetic private task input" },
		key,
	);
	expect(response.status).toBe(202);
	return (await response.json()) as Accepted;
}
const path = (task: Accepted) =>
	`/api/v1/conversations/${task.conversationId}/tasks/${task.executionId}`;
const cancel = (task: Accepted, kind: Kind, key = "cancel") =>
	request(`${path(task)}/cancel`, kind, { schemaVersion: 1 }, key);
async function snapshot(task: Accepted) {
	const [row] = await sql`
		select row_to_json(e) as execution, row_to_json(c) as conversation,
			row_to_json(m) as message, row_to_json(o) as outbox,
			(select boundary from platform.task_authorization_records where execution_id=e.execution_id) as authority,
			(select count(*)::int from platform.audit_events where target_id=e.execution_id and action='task.status.changed') as statusAudits,
			(select count(*)::int from platform.conversation_events where execution_id=e.execution_id) as events,
			(select count(*)::int from platform.conversation_stops where execution_id=e.execution_id) as stops,
			(select count(*)::int from platform.idempotency_records where command_type='stop' and scope_id=c.id) as cancellations,
			(select count(*)::int from platform.conversation_audit_events where execution_id=e.execution_id and action='conversation.stop.accepted') as audits
		from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id
		join platform.conversation_messages m on m.execution_id=e.execution_id
		join platform.outbox_items o on o.id=${`conversation:turn:${task.executionId}`}
		where e.execution_id=${task.executionId}
	`;
	return row;
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("task-api-admission");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
	transaction = new PostgresConversationExecutionTransactionV1({
		databaseUrl: database.databaseUrl,
		userDirectory: directory,
	});
	query = new PostgresConversationQueryV1({
		databaseUrl: database.databaseUrl,
	});
	router = new Hono();
	registerTaskRoutes(
		router,
		createTaskRoutesDependenciesV1({
			transaction,
			query,
			policy: { maximumWaitingTasksPerAgent: 8, waitingTimeoutMs: 30_000 },
		}),
	);
}, 120_000);
beforeEach(async () => {
	await sql`truncate platform.agents, platform.conversations, platform.platform_applications, platform.platform_api_credentials, platform.relay_key_subjects cascade`;
	await sql`truncate platform.outbox_items, platform.idempotency_records, platform.audit_events`;
	await sql`insert into platform.agents(id,current_configuration_revision,authorization_revision) values(${configuration.agentId},${configuration.revision},'agent-1')`;
	await sql`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) values(${configuration.agentId},${configuration.revision},'synthetic-source',now(),${sql.json(configuration as unknown as postgres.JSONValue)})`;
	await sql`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values('agent-application',${configuration.agentId},'owner','Agent','Synthetic fixture','available','seed','seed',now(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values('agent-default',${configuration.agentId},1,1)`;
	await sql`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values('agent-default',${configuration.agentId},1,'original-key',${sql.json({ schemaVersion: 1, purpose: "agent-default", subjectId: configuration.agentId, keyId: "original-key", keyVersion: 1 })})`;
	await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('same-id','Application','owner','app-1')`;
	for (const kind of ["user", "application"] as const) {
		await sql`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision) values(${configuration.agentId},${kind},'same-id','use',${`use-${kind}`})`;
		await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values(${`credential-${kind}`},${kind},'same-id',${createHash("sha256").update(material[kind]).digest("hex")},${sql.json(["agent:read", "agent:use"])})`;
	}
});
afterAll(async () => {
	await transaction?.close();
	await query?.close();
	await sql?.end();
	await database?.stop();
});
describe("actual Bearer Task admission and original-transaction waiting cancellation", () => {
	it.each(["user", "application"] as const)(
		"uses the original deployment loader and real HTTP to admit, bound, isolate and cancel %s waiting Tasks",
		async (kind) => {
			const moduleSpecifier = new URL(
				"../../../tests/fixtures/personal-credential-deployment.ts",
				import.meta.url,
			).href;
			const deployment: typeof import("../../../tests/fixtures/personal-credential-deployment.ts") =
				await import(moduleSpecifier);
			deployment.state.databaseUrl = database.databaseUrl;
			deployment.state.directoryMode = "active";
			deployment.state.directoryCalls = 0;
			const output = new PassThrough();
			output.resume();
			try {
				const running = await startPlatformApiFromDeployment({
					moduleSpecifier,
					port: 0,
					log: () => {},
					observabilityOptions: { output, otlpEndpoint: undefined },
				});
				try {
					const address = running.server.address();
					if (!address || typeof address === "string")
						throw new Error("Test API did not bind");
					const origin = `http://127.0.0.1:${address.port}`;
					const client = createClient({ baseUrl: origin });
					const send = (
						url: string,
						body?: unknown,
						key = "assembly-submit",
						token = material[kind],
					) =>
						fetch(`${origin}${url}`, {
							method: body === undefined ? "GET" : "POST",
							headers: {
								Authorization: `Bearer ${token}`,
								...(body === undefined
									? {}
									: {
											"Content-Type": "application/json",
											"Idempotency-Key": key,
										}),
							},
							...(body === undefined ? {} : { body: JSON.stringify(body) }),
							signal: AbortSignal.timeout(20_000),
						});
					const submitPath = `/api/v1/agents/${configuration.agentId}/tasks`;
					const input = {
						schemaVersion: 1 as const,
						text: "synthetic assembly input",
					};
					const accepted = await submitAgentTask({
						client,
						path: { agentId: configuration.agentId },
						body: input,
						headers: {
							Authorization: `Bearer ${material[kind]}`,
							"Idempotency-Key": "assembly-submit",
						},
						signal: AbortSignal.timeout(20_000),
					});
					expect(accepted.response?.status).toBe(202);
					const task = TaskAcceptedV1Schema.parse(accepted.data);
					const replay = await send(submitPath, input);
					expect(replay.status).toBe(202);
					expect(TaskAcceptedV1Schema.parse(await replay.json())).toEqual(task);
					const detail = await getAgentTask({
						client,
						path: {
							conversationId: task.conversationId,
							executionId: task.executionId,
						},
						headers: { Authorization: `Bearer ${material[kind]}` },
						signal: AbortSignal.timeout(20_000),
					});
					expect(detail.response?.status).toBe(200);
					expect(TaskProjectionV1Schema.parse(detail.data)).toMatchObject({
						executionId: task.executionId,
						status: "waiting",
						output: "",
					});
					const initial = await snapshot(task);
					expect(initial).toMatchObject({
						execution: {
							principal_type: kind,
							actor_id: "same-id",
							channel_id: "api",
							delivery_fence: 0,
							relay_key_id: "original-key",
							relay_key_version: 1,
						},
						outbox: { status: "pending", lease_owner: null },
						stops: 0,
					});
					const opposite = kind === "user" ? "application" : "user";
					expect(
						(await send(path(task), undefined, "", material[opposite])).status,
					).toBe(404);
					expect(
						(
							await send(
								`${path(task)}/cancel`,
								{ schemaVersion: 1 },
								"opposite-cancel",
								material[opposite],
							)
						).status,
					).toBe(404);
					expect(
						(await send(submitPath, { ...input, text: "conflicting input" }))
							.status,
					).toBe(409);
					expect(
						(await send(submitPath, input, "assembly-second")).status,
					).toBe(202);
					expect((await send(submitPath, input, "assembly-full")).status).toBe(
						409,
					);
					expect(
						await sql`select execution_id from platform.conversation_executions`,
					).toHaveLength(2);
					expect(await sql`select id from platform.conversations`).toHaveLength(
						2,
					);
					await sql`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id=${`credential-${kind}`}`;
					expect((await send(path(task))).status).toBe(401);
					expect(
						(
							await send(
								`${path(task)}/cancel`,
								{ schemaVersion: 1 },
								"revoked-cancel",
							)
						).status,
					).toBe(401);
					expect(await snapshot(task)).toEqual(initial);
					const replacement = `papi_${"R".repeat(43)}`;
					await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values('assembly-replacement',${kind},'same-id',${createHash("sha256").update(replacement).digest("hex")},${sql.json(["agent:read", "agent:use"])})`;
					expect(
						(await send(path(task), undefined, "", replacement)).status,
					).toBe(200);
					await sql`update platform.relay_key_subjects set current_version=null where purpose='agent-default' and subject_id=${configuration.agentId}`;
					const cancelled = await cancelAgentTask({
						client,
						path: {
							conversationId: task.conversationId,
							executionId: task.executionId,
						},
						body: { schemaVersion: 1 },
						headers: {
							Authorization: `Bearer ${replacement}`,
							"Idempotency-Key": "assembly-cancel",
						},
						signal: AbortSignal.timeout(20_000),
					});
					expect(cancelled.response?.status).toBe(202);
					expect(TaskCancellationV1Schema.parse(cancelled.data)).toEqual({
						schemaVersion: 1,
						executionId: task.executionId,
						status: "submitted",
					});
					const cancelledReplay = await send(
						`${path(task)}/cancel`,
						{ schemaVersion: 1 },
						"assembly-cancel",
						replacement,
					);
					expect(cancelledReplay.status).toBe(202);
					expect(await cancelledReplay.json()).toEqual({
						schemaVersion: 1,
						executionId: task.executionId,
						status: "submitted",
					});
					const final = await send(path(task), undefined, "", replacement);
					expect(final.status).toBe(200);
					expect(
						TaskProjectionV1Schema.parse(await final.json()),
					).toMatchObject({ status: "cancelled" });
					expect(await snapshot(task)).toMatchObject({
						execution: {
							status: "cancelled",
							delivery_fence: 0,
							relay_key_id: "original-key",
							relay_key_version: 1,
						},
						message: { status: "failed", failure_code: "TASK_CANCELLED" },
						outbox: {
							status: "failed",
							lease_owner: null,
							lease_expires_at: null,
						},
						stops: 1,
						audits: 1,
						cancellations: 1,
						statusAudits: 1,
					});
					expect(
						await sql`select id from platform.outbox_items where operation='conversation.turn.stop.v1'`,
					).toHaveLength(0);
				} finally {
					await createPlatformApiShutdown(running)();
				}
			} finally {
				deployment.state.databaseUrl = "";
				output.destroy();
			}
		},
		30_000,
	);
	it.each(["user", "application"] as const)(
		"keeps %s terminal/replayed stop compatible with the original metadata recovery lock order",
		async (kind) => {
			const task = await submit(kind);
			expect((await cancel(task, kind)).status).toBe(202);
			// Only the historical recovery fixture is synthetic; Task admission/cancel above are real.
			await sql`update platform.conversation_executions set delivery_fence=1,last_runtime_cursor='historical-runtime' where execution_id=${task.executionId}`;
			await sql`update platform.conversations set host_session_ref='historical-session' where id=${task.conversationId}`;
			const event = {
				schemaVersion: 2,
				type: "execution.operation",
				fact: {
					kind: "tool",
					toolId: "synthetic.tool",
					operationRef: "historical-tool",
					attemptRef: "historical-attempt",
					phase: "unknown",
					connection: {
						serviceRef: "synthetic-connection",
						verification: "unverified",
						reason: "receipt_missing",
					},
				},
			};
			await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,source,runtime_cursor,occurred_at) select 'historical-event',${task.conversationId},${task.executionId},'historical-event',e.last_event_sequence+1,c.last_conversation_cursor+1,'execution.operation',${sql.json(event)},${createHash("sha256").update(JSON.stringify(event)).digest("hex")},'runtime','historical-runtime',clock_timestamp() from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id where e.execution_id=${task.executionId}`;
			const authority = await transaction.authorizeTaskApi({
				material: material[kind],
				operation: "agent:use",
				conversationId: task.conversationId,
			});
			if (!authority) throw new Error("Missing actual caller authority");
			const commands = createTaskRoutesDependenciesV1({
				transaction,
				query,
				policy: { maximumWaitingTasksPerAgent: 8, waitingTimeoutMs: 30_000 },
			}).commands(authority);
			const recoveryConnection = postgres(database.databaseUrl, { max: 1 });
			let stopping: ReturnType<typeof commands.stop> | undefined;
			try {
				for (const key of ["cancel", "terminal-again"]) {
					await recoveryConnection.begin(async (locked) => {
						await locked`select set_config('lock_timeout','1s',true)`;
						const [backend] = await locked<
							{ pid: number }[]
						>`select pg_backend_pid() as pid`;
						if (!backend) throw new Error("Missing recovery backend");
						await locked`select id from platform.conversations where id=${task.conversationId} for update`;
						stopping = commands.stop({
							schemaVersion: 1,
							command: "stop",
							conversationId: task.conversationId,
							targetExecutionId: task.executionId,
							idempotencyKey: key,
							traceId: "lock-regression",
							requestId: "lock-regression",
						});
						void stopping.catch(() => undefined);
						await expect
							.poll(
								async () => {
									const [state] = await sql<
										{ blocked: boolean }[]
									>`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and ${backend.pid}=any(pg_blocking_pids(pid)) and query like '%from platform.conversations%') as blocked`;
									return state?.blocked;
								},
								{ timeout: 2_000 },
							)
							.toBe(true);
						const recovery = createConversationExecutionUseCaseV1({
							transaction: new PostgresConversationExecutionTransactionV1({
								transaction: locked,
								userDirectory: directory,
							}),
							authorization: {
								async authorize() {
									return { outcome: "allowed", authority };
								},
							},
						});
						expect(
							await recovery.requestMetadataRecovery({
								schemaVersion: 1,
								conversationId: task.conversationId,
								executionId: task.executionId,
							}),
						).toMatchObject({
							outcome:
								kind === "application"
									? "not_applicable"
									: key === "cancel"
										? "scheduled"
										: "coalesced",
						});
					});
					expect(await stopping).toMatchObject({
						result: {
							executionId: task.executionId,
							status: key === "cancel" ? "submitted" : "already_finished",
						},
					});
				}
			} finally {
				await Promise.allSettled([stopping]);
				await recoveryConnection.end();
			}
		},
		20_000,
	);
	it.each(["user", "application"] as const)(
		"fails closed when %s leaves waiting before cancellation obtains the original outbox",
		async (kind) => {
			const task = await submit(kind);
			const before = await snapshot(task);
			const observer = postgres(database.databaseUrl, { max: 1 });
			let cancelling: Promise<Response> | undefined;
			try {
				await sql.begin(async (locked) => {
					const [backend] = await locked<
						{ pid: number }[]
					>`select pg_backend_pid() as pid`;
					if (!backend) throw new Error("Missing original outbox backend");
					await locked`select id from platform.outbox_items where id=${`conversation:turn:${task.executionId}`} for update`;
					cancelling = Promise.resolve(cancel(task, kind));
					await expect
						.poll(
							async () => {
								const [state] = await observer<
									{ blocked: boolean }[]
								>`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and ${backend.pid}=any(pg_blocking_pids(pid)) and query like '%from platform.outbox_items%') as blocked`;
								return state?.blocked;
							},
							{ timeout: 2_000 },
						)
						.toBe(true);
					await locked`update platform.conversation_executions set status='submitted' where execution_id=${task.executionId}`;
				});
				expect((await cancelling)?.status).toBe(503);
				expect(await snapshot(task)).toEqual({
					...before,
					execution: { ...before?.execution, status: "submitted" },
				});
			} finally {
				await Promise.allSettled([cancelling]);
				await observer.end();
			}
		},
		20_000,
	);
	it.each(["user", "application"] as const)(
		"accepts, replays and cancels %s without replacing its fixed Key or dispatching a stop",
		async (kind) => {
			const task = await submit(kind);
			expect(await submit(kind)).toEqual(task);
			const [accepted] =
				await sql`select c.xmin::text as conversation,e.xmin::text as execution,m.xmin::text as message,o.xmin::text as outbox,a.xmin::text as authority,aa.xmin::text as authority_audit,i.xmin::text as idempotency,v.xmin::text as event,ca.xmin::text as audit from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id join platform.conversation_audit_events ca on ca.execution_id=e.execution_id and ca.action='conversation.task.accepted' join platform.conversation_messages m on m.execution_id=e.execution_id join platform.outbox_items o on o.id=${`conversation:turn:${task.executionId}`} join platform.task_authorization_records a on a.execution_id=e.execution_id join platform.audit_events aa on aa.target_id=e.execution_id and aa.action='task.authorization.accepted' join platform.idempotency_records i on i.result->>'executionId'=e.execution_id and i.command_type='task.submit' join platform.conversation_events v on v.execution_id=e.execution_id where e.execution_id=${task.executionId}`;
			if (!accepted) throw new Error("Missing accepted transaction facts");
			expect(new Set(Object.values(accepted)).size).toBe(1);
			const opposite = kind === "user" ? "application" : "user";
			expect((await request(path(task), opposite)).status).toBe(404);
			expect((await cancel(task, opposite)).status).toBe(404);
			await sql`update platform.relay_key_subjects set current_version=null where purpose='agent-default' and subject_id=${configuration.agentId}`;
			expect((await cancel(task, kind)).status).toBe(202);
			expect((await cancel(task, kind)).status).toBe(202);
			expect(
				await (await cancel(task, kind, "cancel-again")).json(),
			).toMatchObject({ status: "already_finished" });
			expect(await (await request(path(task), kind)).json()).toMatchObject({
				status: "cancelled",
			});
			const state = await snapshot(task);
			expect(state).toMatchObject({
				execution: {
					status: "cancelled",
					delivery_fence: 0,
					relay_key_id: "original-key",
					relay_key_version: 1,
				},
				message: { status: "failed", failure_code: "TASK_CANCELLED" },
				outbox: { status: "failed", lease_owner: null, lease_expires_at: null },
				stops: 1,
				audits: 1,
			});
			const [settled] =
				await sql`select c.xmin::text as conversation,e.xmin::text as execution,m.xmin::text as message,o.xmin::text as outbox,s.xmin::text as stop,v.xmin::text as event,i.xmin::text as idempotency,ca.xmin::text as stop_audit,sa.xmin::text as status_audit,a.xmin::text as platform_audit from platform.conversation_executions e join platform.conversations c on c.id=e.conversation_id join platform.idempotency_records i on i.result->>'executionId'=e.execution_id and i.command_type='stop' and i.idempotency_key='cancel' join platform.conversation_audit_events ca on ca.execution_id=e.execution_id and ca.action='conversation.stop.accepted' join platform.conversation_audit_events sa on sa.execution_id=e.execution_id and sa.action='conversation.task.status' join platform.audit_events a on a.target_id=e.execution_id and a.action='task.status.changed' join platform.conversation_messages m on m.execution_id=e.execution_id join platform.outbox_items o on o.id=${`conversation:turn:${task.executionId}`} join platform.conversation_stops s on s.execution_id=e.execution_id join platform.conversation_events v on v.execution_id=e.execution_id and v.event_payload->>'status'='cancelled' where e.execution_id=${task.executionId}`;
			if (!settled) throw new Error("Missing cancellation transaction facts");
			expect(new Set(Object.values(settled)).size).toBe(1);
			expect(
				await sql`select id from platform.outbox_items where operation='conversation.turn.stop.v1'`,
			).toHaveLength(0);
		},
	);
	it.each(["user", "application"] as const)(
		"keeps %s's Conversation occupancy/session while cancelling waiting work with a different revision",
		async (kind) => {
			const task = await submit(kind);
			await sql`update platform.conversations set authorization_revision='old-conversation',status='active',host_session_ref='original-session' where id=${task.conversationId}`;
			expect((await cancel(task, kind)).status).toBe(202);
			expect((await snapshot(task))?.conversation).toMatchObject({
				status: "active",
				host_session_ref: "original-session",
				session_generation: 1,
				authorization_revision: "old-conversation",
			});
		},
	);
	it.each(["user", "application"] as const)(
		"rejects %s waiting cancellation with a mismatched original outbox or Message state without partial facts",
		async (kind) => {
			for (const fault of ["binding", "message"] as const) {
				const task = await submit(kind, `invalid-${fault}`);
				if (fault === "binding")
					await sql`update platform.outbox_items set payload=jsonb_set(payload,'{sessionGeneration}','99') where id=${`conversation:turn:${task.executionId}`}`;
				else
					await sql`update platform.conversation_messages set status='failed',failure_code='ORIGINAL_FAILURE' where execution_id=${task.executionId}`;
				const before = await snapshot(task);
				expect((await cancel(task, kind)).status).toBe(503);
				expect(await snapshot(task)).toEqual(before);
			}
		},
	);
	it.each(["user", "application"] as const)(
		"rejects %s waiting cancellation with missing or mismatched persisted typed authority",
		async (kind) => {
			for (const fault of ["missing", "typed-binding"] as const) {
				const task = await submit(kind, `authority-${fault}`);
				if (fault === "missing")
					await sql`delete from platform.task_authorization_records where execution_id=${task.executionId}`;
				else {
					const opposite = kind === "user" ? "application" : "user";
					await sql`update platform.task_authorization_records set boundary=jsonb_set(jsonb_set(boundary,'{principal,kind}',${sql.json(opposite)}),'{channelId}',${sql.json(`api:${opposite}`)}) where execution_id=${task.executionId}`;
				}
				const before = await snapshot(task);
				expect((await cancel(task, kind)).status).toBe(503);
				expect(await snapshot(task)).toEqual(before);
			}
		},
	);
	it.each(["user", "application"] as const)(
		"rolls back %s cancellation on either necessary audit failure or authority loss after the waiting finisher",
		async (kind) => {
			const task = await submit(kind);
			for (const fault of [
				"status-audit",
				"stop-audit",
				"credential",
				"disabled",
				"grant",
			] as const) {
				const before = await snapshot(task);
				const effect =
					fault === "credential"
						? `update platform.platform_api_credentials set expires_at=clock_timestamp()-interval '1 second' where id='credential-${kind}';`
						: fault === "disabled"
							? kind === "user"
								? "insert into platform.platform_user_disables(user_id,disabled_by) values('same-id','synthetic-admin');"
								: "update platform.platform_applications set status='disabled' where id='same-id';"
							: fault === "grant"
								? `update platform.agent_principal_grants set revoked_at=clock_timestamp() where principal_type='${kind}' and principal_id='same-id';`
								: "raise exception 'private audit fault';";
				const action =
					fault === "status-audit"
						? "task.status.changed"
						: "conversation.stop.accepted";
				await sql.unsafe(
					`create function platform.task_cancel_fault() returns trigger language plpgsql as $$ begin if NEW.action='${action}' then ${effect} end if; return NEW; end $$`,
				);
				const table =
					fault === "status-audit"
						? "platform.audit_events"
						: "platform.conversation_audit_events";
				await sql.unsafe(
					`create trigger task_cancel_fault before insert on ${table} for each row execute function platform.task_cancel_fault()`,
				);
				try {
					const response = await cancel(task, kind);
					expect(response.status).toBe(503);
					expect(await response.text()).not.toContain("private audit fault");
					expect(await snapshot(task)).toEqual(before);
					const [credential] =
						await sql`select expires_at from platform.platform_api_credentials where id=${`credential-${kind}`}`;
					expect(credential?.expires_at).toBeNull();
					expect(
						await sql`select user_id from platform.platform_user_disables where user_id='same-id'`,
					).toHaveLength(0);
					const [application] =
						await sql`select status from platform.platform_applications where id='same-id'`;
					expect(application?.status).toBe("active");
					const [grant] =
						await sql`select revoked_at from platform.agent_principal_grants where principal_type=${kind} and principal_id='same-id'`;
					expect(grant?.revoked_at).toBeNull();
				} finally {
					await sql.unsafe(`drop trigger task_cancel_fault on ${table}`);
					await sql.unsafe("drop function platform.task_cancel_fault()");
				}
			}
			expect((await cancel(task, kind)).status).toBe(202);
		},
	);
});
