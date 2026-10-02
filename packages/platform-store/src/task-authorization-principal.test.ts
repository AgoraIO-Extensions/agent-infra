import type {
	TaskAuthorizationBoundaryV1,
	TaskPrincipalV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
const principal = (kind: TaskPrincipalV1["kind"]): TaskPrincipalV1 => ({
	kind,
	id: "same-id",
});
const boundary = (
	kind: TaskPrincipalV1["kind"],
	channelId = "api",
): TaskAuthorizationBoundaryV1 => ({
	schemaVersion: 1,
	principal: principal(kind),
	agentId: "agent",
	channelId,
	identityRevision: "identity-1",
	agentAuthorizationRevision: "agent-1",
	accessSources:
		channelId === "web"
			? [{ kind: "user", userId: "same-id" }]
			: [{ kind: "api-use", useGrantRevision: "use-1" }],
});
beforeAll(async () => {
	database = await startPostgresTestDatabase("task-authorization-principal");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 1 });
	store = new PostgresTaskAuthorizationStoreV1({
		databaseUrl: database.databaseUrl,
	});
}, 120_000);
afterEach(async () => {
	await client`truncate platform.audit_events, platform.task_control_records, platform.task_authorization_records,
		platform.conversation_events, platform.conversation_messages, platform.conversation_executions,
		platform.conversations, platform.platform_applications, platform.agents cascade`;
});
afterAll(async () => {
	await store?.close();
	await client?.end();
	await database?.stop();
});
async function seed(kind: TaskPrincipalV1["kind"], channelId = "api") {
	await client`insert into platform.agents (id, authorization_revision) values ('agent', 'agent-1')`;
	await client`insert into platform.agent_applications
		(id, agent_id, applicant_id, name, description, status, management_revision, approval_revision,
		service_availability, desired_state, workload_revision, fence, trace_id, request_id, submitted_at)
		values ('agent-application', 'agent', 'owner', 'Agent', 'Fixture', 'available', 1, 1,
		'ready', 'running', 1, 1, 'trace', 'request', now())`;
	await client`insert into platform.conversations
		(id, agent_id, actor_id, channel_id, principal_type, status, session_generation, authorization_revision)
		values ('conversation', 'agent', 'same-id', ${channelId}, ${kind}, 'ready', 1, 'agent-1')`;
	await client`insert into platform.conversation_executions
		(execution_id, conversation_id, agent_id, actor_id, channel_id, principal_type, turn_id, status,
		session_generation, authorization_revision, created_at)
		values ('execution', 'conversation', 'agent', 'same-id', ${channelId}, ${kind}, 'turn', 'completed', 1, 'agent-1', now())`;
}
async function insert(value: TaskAuthorizationBoundaryV1) {
	await client.begin((transaction) =>
		insertTaskAuthorization(transaction, {
			executionId: "execution",
			boundary: value,
			traceId: "trace",
			requestId: "request",
		}),
	);
}

describe("Task authorization trusted C/E principal", () => {
	it.each(["user", "application"] as const)(
		"writes/reads %s from persistent C/E rather than actor ID",
		async (kind) => {
			await seed(kind);
			await insert(boundary(kind));
			expect(await store.readExecution("execution")).toMatchObject({
				principal: principal(kind),
				boundary: boundary(kind),
				revokedAt: null,
			});
			const [audit] =
				await client`select actor_type, actor_id from platform.audit_events where action = 'task.authorization.accepted'`;
			expect(audit).toEqual({ actor_type: kind, actor_id: "same-id" });
			await client`update platform.task_authorization_records set revoked_at = now() where execution_id = 'execution'`;
			expect(
				(await store.readExecution("execution"))?.revokedAt,
			).toBeInstanceOf(Date);
		},
	);
	it.each(["user", "application"] as const)(
		"refuses same-ID opposite %s type on insert and stored-boundary read",
		async (kind) => {
			await seed(kind);
			const other = boundary(kind === "user" ? "application" : "user");
			await expect(insert(other)).rejects.toBeInstanceOf(
				TaskAuthorizationStoreError,
			);
			expect(await client`select id from platform.audit_events`).toHaveLength(
				0,
			);
			await insert(boundary(kind));
			await client`update platform.task_authorization_records set boundary = ${JSON.stringify(other)}::jsonb where execution_id = 'execution'`;
			await expect(store.readExecution("execution")).rejects.toBeInstanceOf(
				TaskAuthorizationStoreError,
			);
		},
	);
	it("preserves old user/Web authority, ID and revocation", async () => {
		await seed("user", "web");
		await insert(boundary("user", "web"));
		expect(await store.readExecution("execution")).toMatchObject({
			executionId: "execution",
			principal: principal("user"),
			boundary: boundary("user", "web"),
		});
	});
	it("rolls the record back when required acceptance audit fails", async () => {
		await seed("application");
		await client`create function platform.fail_typed_task_audit() returns trigger language plpgsql as $$ begin raise exception 'controlled audit failure'; end $$`;
		try {
			await client`create trigger fail_typed_task_audit before insert on platform.audit_events for each row execute function platform.fail_typed_task_audit()`;
			await expect(insert(boundary("application"))).rejects.toThrow(
				"controlled audit failure",
			);
			expect(
				await client`select id from platform.task_authorization_records`,
			).toHaveLength(0);
		} finally {
			await client`drop trigger if exists fail_typed_task_audit on platform.audit_events`;
			await client`drop function platform.fail_typed_task_audit()`;
		}
	});
	it("refuses an Execution authorization revision different from its boundary", async () => {
		await seed("application");
		await client`update platform.conversation_executions set authorization_revision = 'older-agent'`;
		await expect(insert(boundary("application"))).rejects.toBeInstanceOf(
			TaskAuthorizationStoreError,
		);
	});
});

describe("Store-owned current metadata transactions", () => {
	it("uses the exact application/use namespace and returns disabled/revoked facts", async () => {
		await seed("application");
		await client`insert into platform.platform_applications (id, name, responsible_user_id, authorization_revision, status)
			values ('same-id', 'Fixture', 'owner', 'application-1', 'active')`;
		for (const kind of ["user", "application"] as const) {
			await client`insert into platform.agent_principal_grants (agent_id, principal_type, principal_id, grant_type, authorization_revision)
				values ('agent', ${kind}, 'same-id', 'use', ${`use-${kind}`})`;
			expect(
				await store.readCurrentApiUseGrant({
					principal: principal(kind),
					agentId: "agent",
				}),
			).toMatchObject({
				principal: principal(kind),
				authorizationRevision: `use-${kind}`,
				revoked: false,
			});
		}
		expect(
			await store.readCurrentApplication({
				applicationId: "same-id",
				agentId: "agent",
			}),
		).toMatchObject({
			applicationId: "same-id",
			status: "active",
			useGrant: {
				principal: principal("application"),
				authorizationRevision: "use-application",
			},
		});
		await client`update platform.platform_applications set status = 'disabled' where id = 'same-id'`;
		await client`update platform.agent_principal_grants set revoked_at = now() where principal_type = 'application'`;
		expect(
			await store.readCurrentApplication({
				applicationId: "same-id",
				agentId: "agent",
			}),
		).toMatchObject({ status: "disabled", useGrant: { revoked: true } });
		expect(
			await store.readCurrentApiUseGrant({
				principal: principal("user"),
				agentId: "agent",
			}),
		).toMatchObject({ revoked: false });
		expect(
			await store.readCurrentApplication({
				applicationId: "missing",
				agentId: "agent",
			}),
		).toBeNull();
		expect(
			await store.readCurrentApiUseGrant({
				principal: principal("application"),
				agentId: "missing",
			}),
		).toBeNull();
	});
});
