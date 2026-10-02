import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import type { TaskUserDirectoryV1 } from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresConversationExecutionTransactionV1,
	PostgresConversationQueryV1,
} from "@agent-infra/platform-store";
import { Hono } from "hono";
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
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createTaskRoutesDependenciesV1 } from "./http/task-dependencies.js";
import {
	registerTaskRoutes,
	type TaskRoutesDependencies,
} from "./http/task-routes.js";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "./index.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let query: PostgresConversationQueryV1;
const stores: PostgresConversationExecutionTransactionV1[] = [];
const material = {
	user: `papi_${"U".repeat(43)}`,
	application: `papi_${"A".repeat(43)}`,
	replacement: `papi_${"B".repeat(43)}`,
};
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
function transaction(userDirectory = directory) {
	const value = new PostgresConversationExecutionTransactionV1({
		databaseUrl: database.databaseUrl,
		userDirectory,
	});
	stores.push(value);
	return value;
}
function dependencies(userDirectory = directory) {
	return createTaskRoutesDependenciesV1({
		transaction: transaction(userDirectory),
		query,
		policy: { maximumWaitingTasksPerAgent: 8, waitingTimeoutMs: 30_000 },
	});
}

function app(deps: TaskRoutesDependencies) {
	const value = new Hono();
	registerTaskRoutes(value, deps);
	return value;
}
function headers(kind: keyof typeof material) {
	return { Authorization: `Bearer ${material[kind]}` };
}
const path = (kind = "application") =>
	`/api/v1/conversations/conversation-${kind}/tasks/execution-${kind}`;
beforeAll(async () => {
	database = await startPostgresTestDatabase("task-http-application-consumer");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
	query = new PostgresConversationQueryV1({
		databaseUrl: database.databaseUrl,
	});
}, 120_000);
beforeEach(async () => {
	await sql`truncate platform.audit_events,platform.outbox_items,platform.platform_api_credentials,platform.platform_user_disables,platform.platform_applications,platform.agents,platform.conversations cascade`;
	await sql`insert into platform.agents(id,authorization_revision) values('agent','agent-1')`;
	await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('same-id','Fixture','owner','app-1')`;
	for (const kind of ["user", "application"] as const) {
		await sql`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision) values('agent',${kind},'same-id','use',${`use-${kind}`})`;
		await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values(${`credential-${kind}`},${kind},'same-id',${createHash("sha256").update(material[kind]).digest("hex")},${sql.json(["agent:read", "agent:use"])})`;
		await sql`insert into platform.conversations(id,agent_id,actor_id,principal_type,channel_id,status,session_generation,authorization_revision,last_conversation_cursor) values(${`conversation-${kind}`},'agent','same-id',${kind},'api','ready',1,'agent-1',1)`;
		await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,principal_type,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,last_event_sequence,created_at) values(${`execution-${kind}`},${`conversation-${kind}`},'agent','same-id',${kind},'api',${`turn-${kind}`},'completed',1,1,'agent-1',1,'2026-01-01T00:00:00Z')`;
		await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source) values(${`event-${kind}`},${`conversation-${kind}`},${`execution-${kind}`},${`adapter-${kind}`},1,1,'text.delta',${sql.json({ type: "text.delta", text: `${kind} output` })},${"c".repeat(64)},${`runtime-${kind}`},now(),'runtime')`;
	}
});
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
});
afterAll(async () => {
	await query?.close();
	await sql?.end();
	await database?.stop();
});
describe("Task router/factory with actual Bearer and PostgreSQL", () => {
	it("registers C without any subscription factory or SSE route", async () => {
		const router = app(dependencies());
		expect(
			(await router.request(path(), { headers: headers("application") }))
				.status,
		).toBe(200);
		expect(
			(
				await router.request(`${path()}/events`, {
					headers: headers("application"),
				})
			).status,
		).toBe(404);
		expect(
			await sql`select id from platform.outbox_items where scope_type='task_api_subscription'`,
		).toHaveLength(0);
	});
	it("consumes the original deployment loader and production assembly over real HTTP with typed Bearer isolation", async () => {
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
				for (const kind of ["user", "application"] as const) {
					const response = await fetch(`${origin}${path(kind)}`, {
						headers: headers(kind),
					});
					expect(response.status).toBe(200);
					expect(await response.json()).toMatchObject({
						executionId: `execution-${kind}`,
						output: `${kind} output`,
					});
					expect(
						(
							await fetch(
								`${origin}${path(kind === "user" ? "application" : "user")}`,
								{
									headers: headers(kind),
								},
							)
						).status,
					).toBe(404);
				}
				expect(
					(
						await fetch(`${origin}${path()}`, {
							headers: {
								Cookie: "__Host-platform-session=session_admin",
								"X-Principal-Type": "application",
								"X-Actor-Id": "same-id",
							},
						})
					).status,
				).toBe(401);
				await sql`update platform.platform_api_credentials set scopes=${sql.json(["agent:read"])} where id='credential-application'`;
				expect(
					(
						await fetch(`${origin}${path()}/cancel`, {
							method: "POST",
							headers: {
								...headers("application"),
								"Content-Type": "application/json",
								"Idempotency-Key": "cancel-assembly",
							},
							body: JSON.stringify({ schemaVersion: 1 }),
						})
					).status,
				).toBe(403);
				expect(
					await sql`select id from platform.task_control_records`,
				).toHaveLength(0);
				expect(
					await sql`select execution_id from platform.conversation_stops`,
				).toHaveLength(0);
			} finally {
				await createPlatformApiShutdown(running)();
			}
		} finally {
			deployment.state.databaseUrl = "";
			output.destroy();
		}
	});
	it.each(["user", "application"] as const)(
		"isolates same-ID %s from opposite kind on GET",
		async (kind) => {
			const router = app(dependencies());
			const response = await router.request(path(kind), {
				headers: headers(kind),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				executionId: `execution-${kind}`,
				output: `${kind} output`,
			});
			expect(
				(
					await router.request(path(kind === "user" ? "application" : "user"), {
						headers: headers(kind),
					})
				).status,
			).toBe(404);
		},
	);
	it("ignores session/claimed identity and does not use an Owner or same-ID user disable for an application", async () => {
		await sql`insert into platform.platform_user_disables(user_id) values('same-id')`;
		const router = app(
			dependencies({
				async resolveUser() {
					throw new Error("Application must skip directory");
				},
			}),
		);
		expect(
			(
				await router.request(path(), {
					headers: {
						Cookie: "session=claimed",
						"X-Principal-Type": "application",
						"X-Actor-Id": "same-id",
					},
				})
			).status,
		).toBe(401);
		expect(
			(await router.request(path(), { headers: headers("application") }))
				.status,
		).toBe(200);
	});
	it.each(["credential", "use", "agent"] as const)(
		"rejects %s loss after the final real audit await before returning output",
		async (change) => {
			const deps = dependencies();
			let changed = false;
			const router = app({
				...deps,
				audit: {
					...deps.audit,
					async record(input) {
						await deps.audit.record(input);
						if (
							!changed &&
							input.phase === "access" &&
							input.result === "succeeded"
						) {
							changed = true;
							if (change === "credential")
								await sql`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id='credential-application'`;
							else if (change === "use")
								await sql`update platform.agent_principal_grants set authorization_revision='changed' where principal_type='application'`;
							else
								await sql`update platform.agents set authorization_revision='changed' where id='agent'`;
						}
					},
				},
			});
			const response = await router.request(path(), {
				headers: headers("application"),
			});
			expect(response.status).toBe(change === "credential" ? 401 : 403);
			expect(await response.text()).not.toContain("application output");
			expect(
				await sql`select execution_id from platform.conversation_executions where execution_id='execution-application' and status='completed'`,
			).toHaveLength(1);
			expect(
				await sql`select id from platform.task_control_records`,
			).toHaveLength(0);
		},
	);
	it("keeps a revoked credential from access while a new credential of the same application reads the original Task", async () => {
		await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values('replacement','application','same-id',${createHash("sha256").update(material.replacement).digest("hex")},${sql.json(["agent:read"])})`;
		await sql`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id='credential-application'`;
		const router = app(dependencies());
		expect(
			(await router.request(path(), { headers: headers("application") }))
				.status,
		).toBe(401);
		expect(
			(await router.request(path(), { headers: headers("replacement") }))
				.status,
		).toBe(200);
		expect(
			await sql`select id from platform.task_control_records`,
		).toHaveLength(0);
	});
	it("refuses read-only credential on cancel without writing stop or control", async () => {
		await sql`update platform.platform_api_credentials set scopes=${sql.json(["agent:read"])} where id='credential-application'`;
		const response = await app(dependencies()).request(`${path()}/cancel`, {
			method: "POST",
			headers: {
				...headers("application"),
				"Content-Type": "application/json",
				"Idempotency-Key": "cancel",
			},
			body: JSON.stringify({ schemaVersion: 1 }),
		});
		expect(response.status).toBe(403);
		expect(
			await sql`select execution_id from platform.conversation_stops`,
		).toHaveLength(0);
		expect(
			await sql`select id from platform.task_control_records`,
		).toHaveLength(0);
	});
	it.each(["user", "application"] as const)(
		"projects original Platform status through GET for %s",
		async (kind) => {
			await sql`insert into platform.conversation_events(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source) values(${`status-${kind}`},${`conversation-${kind}`},${`execution-${kind}`},${`status-${kind}`},2,2,'task.status',${sql.json({ type: "task.status", status: "completed" })},${"d".repeat(64)},null,now(),'platform')`;
			await sql`update platform.conversations set last_conversation_cursor=2 where id=${`conversation-${kind}`}`;
			await sql`update platform.conversation_executions set last_event_sequence=2 where execution_id=${`execution-${kind}`}`;
			const router = app(dependencies());
			const response = await router.request(path(kind), {
				headers: headers(kind),
			});
			expect(response.status).toBe(200);
			const detail = await response.json();
			expect(detail).toMatchObject({
				status: "completed",
				output: `${kind} output`,
				events: [
					{ type: "text.delta" },
					{
						eventId: `status-${kind}`,
						type: "task.status",
						payload: { status: "completed" },
					},
				],
			});
		},
	);
});
