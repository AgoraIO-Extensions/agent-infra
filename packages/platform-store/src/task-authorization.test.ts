import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import {
	insertTaskAuthorization,
	PostgresTaskAuthorizationStoreV1,
} from "./task-authorization.ts";

describe("PostgreSQL task authorization current application facts", () => {
	let databaseUrl = "";
	let adminClient: ReturnType<typeof postgres>;
	let testDatabase: PostgresTestDatabase | undefined;
	let store: PostgresTaskAuthorizationStoreV1;

	beforeAll(async () => {
		testDatabase = await startPostgresTestDatabase("task-authorization");
		databaseUrl = testDatabase.databaseUrl;
		await migratePlatformDatabase({ databaseUrl });
		adminClient = postgres(databaseUrl, { max: 5 });
		store = new PostgresTaskAuthorizationStoreV1({ databaseUrl });
	}, 120_000);

	afterAll(async () => {
		await store?.close();
		await adminClient?.end();
		await testDatabase?.stop();
	});

	async function reset(): Promise<void> {
		await adminClient`truncate platform.task_authorization_records,
			platform.conversation_executions, platform.conversations,
			platform.agent_principal_grants, platform.agent_owners,
			platform.agent_applications, platform.agents,
			platform.platform_applications cascade`;
	}

	async function seed(): Promise<void> {
		await adminClient`
			insert into platform.agents (id, authorization_revision)
			values ('agent_task_application', 'agent-revision-1')
		`;
		await adminClient`
			insert into platform.agent_applications
				(id, agent_id, applicant_id, name, description, status,
				 management_revision, approval_revision, service_availability,
				 desired_state, workload_revision, fence, trace_id, request_id,
				 submitted_at)
			values
				('agent-application-record', 'agent_task_application', 'user-owner',
				 'Task application', 'Task application fixture', 'available',
				 1, 1, 'ready', 'running', 1, 1, 'trace-task', 'request-task', now())
		`;
		await adminClient`
			insert into platform.agent_owners (agent_id, owner_id, created_at)
			values ('agent_task_application', 'user-owner', now())
		`;
		await adminClient`
			insert into platform.platform_applications
				(id, name, responsible_user_id, status, authorization_revision)
			values
				('task-caller', 'Task caller', 'user-owner', 'active', 'app-revision-1')
		`;
		await adminClient`
			insert into platform.agent_principal_grants
				(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values
				('agent_task_application', 'application', 'task-caller', 'use',
				 'agent-revision-1')
		`;
	}

	async function seedExecution(): Promise<void> {
		await adminClient`
			insert into platform.conversations
				(id, agent_id, actor_id, channel_id, status, session_generation,
				 authorization_revision)
			values
				('conversation_task_application', 'agent_task_application', 'task-caller',
				 'api', 'ready', 1, 'agent-revision-1')
		`;
		await adminClient`
			insert into platform.conversation_executions
				(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id,
				 status, session_generation, delivery_fence, authorization_revision,
				 created_at)
			values
				('execution_task_application', 'conversation_task_application',
				 'agent_task_application', 'task-caller', 'api', 'turn-task',
				 'submitted', 1, 0, 'agent-revision-1', now())
		`;
	}

	async function insertBoundary(boundary: unknown): Promise<void> {
		await adminClient`
			insert into platform.task_authorization_records (id, execution_id, boundary)
			values ('authorization_task_application', 'execution_task_application',
				${adminClient.json(boundary as never)})
		`;
	}

	async function acceptBoundary(boundary: unknown): Promise<void> {
		await adminClient.begin(async (transaction) => {
			await insertTaskAuthorization(transaction, {
				executionId: "execution_task_application",
				boundary: boundary as never,
				traceId: "trace-accept",
				requestId: "request-accept",
			});
		});
	}

	it("rejects acceptance when the execution revision is stale", async () => {
		await reset();
		await seed();
		const boundary = await store.captureApplicationBoundary({
			applicationId: "task-caller",
			agentId: "agent_task_application",
			channelId: "api",
		});
		if (!boundary) throw new Error("Expected an application boundary");
		await seedExecution();
		await adminClient`
			update platform.conversation_executions
			set authorization_revision = 'stale-execution-revision'
			where execution_id = 'execution_task_application'
		`;
		await expect(acceptBoundary(boundary)).rejects.toThrow(
			"Task authorization persistence is unavailable",
		);
		expect(
			await adminClient`select id from platform.task_authorization_records`,
		).toEqual([]);
	});

	it("captures active application facts and reads them back with the execution", async () => {
		await reset();
		await seed();
		const boundary = await store.captureApplicationBoundary({
			applicationId: "task-caller",
			agentId: "agent_task_application",
			channelId: "api",
		});
		expect(boundary).toMatchObject({
			principal: { kind: "application", id: "task-caller" },
			agentId: "agent_task_application",
			channelId: "api",
			identityRevision: "app-revision-1",
			agentAuthorizationRevision: "agent-revision-1",
			accessSources: [{ kind: "application", applicationId: "task-caller" }],
		});
		expect(
			await store.captureApplicationBoundary({
				applicationId: "task-caller",
				agentId: "agent_task_application",
				channelId: "web",
			}),
		).toBeNull();
		expect(
			await store.captureApplicationBoundary({
				applicationId: "task-caller",
				agentId: "agent_task_application",
				channelId: "api-other",
			}),
		).toBeNull();
		if (!boundary) throw new Error("Expected an application boundary");
		await seedExecution();
		await insertBoundary(boundary);
		await expect(
			store.readExecution("execution_task_application"),
		).resolves.toMatchObject({
			application: {
				applicationId: "task-caller",
				accountStatus: "active",
				authorizationRevision: "app-revision-1",
			},
			boundary,
		});
	});

	it("rejects disabled, stale-revision, and revoked application authority before acceptance writes", async () => {
		await reset();
		await seed();
		const boundary = await store.captureApplicationBoundary({
			applicationId: "task-caller",
			agentId: "agent_task_application",
			channelId: "api",
		});
		if (!boundary) throw new Error("Expected an application boundary");
		expect(
			await store.captureApplicationBoundary({
				applicationId: "task-caller",
				agentId: "agent_task_application",
				channelId: "api",
			}),
		).not.toBeNull();
		await adminClient`
			update platform.platform_applications set status = 'disabled'
			where id = 'task-caller'
		`;
		expect(
			await store.captureApplicationBoundary({
				applicationId: "task-caller",
				agentId: "agent_task_application",
				channelId: "api",
			}),
		).toBeNull();
		await adminClient`
			update platform.platform_applications
			set status = 'active', authorization_revision = 'app-revision-2'
			where id = 'task-caller'
		`;
		await seedExecution();
		await expect(acceptBoundary(boundary)).rejects.toThrow(
			"Task authorization persistence is unavailable",
		);
		expect(
			await adminClient`select id from platform.task_authorization_records`,
		).toEqual([]);
		await adminClient`
			update platform.agent_principal_grants set revoked_at = now()
			where agent_id = 'agent_task_application'
				and principal_id = 'task-caller'
		`;
		await expect(acceptBoundary(boundary)).rejects.toThrow(
			"Task authorization persistence is unavailable",
		);
		expect(
			await adminClient`select id from platform.task_authorization_records`,
		).toEqual([]);
	});
});
