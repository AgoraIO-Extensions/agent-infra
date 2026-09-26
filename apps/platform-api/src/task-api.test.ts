import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
	ScopedPlatformAuditPageV1Schema,
	ScopedPlatformAuditProjectionV1Schema,
	TaskProjectionV1Schema,
	TaskSseMessageV1Schema,
} from "@agent-infra/contracts/pilot";
import { hashApiCredentialV1 } from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresConversationDispatchStoreV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { agentConfigurationConformanceRecordV1 as configuration } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import { startPlatformApi } from "./index.js";

interface DatabaseReader {
	unsafe(
		query: string,
		parameters?: readonly unknown[],
	): Promise<Record<string, unknown>[]>;
	end(): Promise<void>;
}
const connect = createRequire(
	import.meta.resolve("@agent-infra/platform-store"),
)("postgres") as (url: string) => DatabaseReader;
const unavailable = async (): Promise<never> => {
	throw new Error("Unexpected admission call");
};
const sharedId = "task_subject";
const credentials = {
	user: "synthetic-task-user-credential",
	application: "synthetic-task-application-credential",
	replacement: "synthetic-task-replacement-credential",
	owner: "synthetic-task-owner-credential",
};
let database: PostgresTestDatabase;
let db: DatabaseReader;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof startPlatformApi>;
let origin: string;
let userActive = true;

function request(
	path: string,
	credential = credentials.user,
	body?: unknown,
	key = "task_key",
	signal?: AbortSignal,
) {
	return fetch(`${origin}/api/v1${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization: `Bearer ${credential}`,
			"content-type": "application/json",
			"Idempotency-Key": key,
			"X-User-Id": "forged",
			"X-Channel-Id": "web",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal,
	});
}
async function submit(
	credential = credentials.user,
	key = "task_key",
	conversationId?: string,
) {
	const response = await request(
		`/agents/${configuration.agentId}/tasks`,
		credential,
		{
			schemaVersion: 1,
			text: "synthetic task",
			...(conversationId ? { conversationId } : {}),
		},
		key,
	);
	expect(response.status).toBe(202);
	return (await response.json()) as {
		conversationId: string;
		executionId: string;
	};
}
function path(task: { conversationId: string; executionId: string }) {
	return `/conversations/${task.conversationId}/tasks/${task.executionId}`;
}
async function counts() {
	const [row] = await db.unsafe(
		"select (select count(*)::int from platform.conversations) as conversations, (select count(*)::int from platform.conversation_executions) as executions, (select count(*)::int from platform.task_authorization_records) as authorizations",
	);
	return row;
}
async function output(
	task: { conversationId: string; executionId: string },
	text: string,
) {
	const [row] = await db.unsafe(
		"select last_conversation_cursor::int as cursor from platform.conversations where id=$1",
		[task.conversationId],
	);
	if (!row) throw new Error("Synthetic task conversation is missing");
	const cursor = Number(row.cursor) + 1;
	const eventId = `output_${task.executionId}`;
	await db.unsafe(
		"insert into platform.conversation_events(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source) values($1,$2,$3,$1,2,$4,'text.delta',$5::text::jsonb,$6,$1,now(),'runtime')",
		[
			eventId,
			task.conversationId,
			task.executionId,
			cursor,
			JSON.stringify({ type: "text.delta", text }),
			"a".repeat(64),
		],
	);
	await db.unsafe(
		"update platform.conversations set last_conversation_cursor=$2 where id=$1",
		[task.conversationId, cursor],
	);
	return eventId;
}

// This validates formal HTTP/Store assembly with synthetic directory and output facts.
describe("Public durable task API over real HTTP and PostgreSQL", () => {
	beforeAll(async () => {
		database = await startPostgresTestDatabase("public-task-api");
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		db = connect(database.databaseUrl);
		assembly = assemblePlatformApi({
			databaseUrl: database.databaseUrl,
			taskAdmissionPolicy: {
				maximumWaitingTasksPerAgent: 2,
				waitingTimeoutMs: 60_000,
			},
			identity: {
				async resolve(request) {
					return request.headers.get("cookie") === "synthetic-admin-session"
						? {
								schemaVersion: 1,
								userId: "owner_01",
								displayName: "Synthetic administrator",
								accountStatus: "active",
								organizationIds: [],
								roles: ["system_admin"],
								authorizationRevision: "directory_current",
							}
						: null;
				},
				async hydrateUsers(userIds) {
					return userIds.map((userId) => ({
						userId,
						displayName: "Synthetic user",
						roles: ["employee"],
					}));
				},
				async resolveUser(userId) {
					return {
						schemaVersion: 1,
						userId,
						accountStatus: userActive ? "active" : "disabled",
						organizationIds: [],
						authorizationRevision: "directory_current",
					};
				},
			},
			admissions: {
				authorizationAdmission: { authorize: unavailable },
				imageAdmission: { admitImage: unavailable },
				modelAdmission: { admitModels: unavailable },
				secretAdmission: { admitSecrets: unavailable },
				channelAdmission: { admitChannels: unavailable },
			},
			allocateApplicationIds: unavailable,
			prepareApplicationSecrets: unavailable,
			prepareConfigurationSecrets: unavailable,
			presentAgent: unavailable,
		});
		server = startPlatformApi({
			dependencies: assembly.dependencies,
			log: () => {},
			port: 0,
		});
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}, 60_000);
	beforeEach(async () => {
		userActive = true;
		await db.unsafe(
			"truncate platform.agents,platform.conversations,platform.platform_applications cascade",
		);
		await db.unsafe(
			"truncate platform.outbox_items,platform.idempotency_records,platform.audit_events,platform.platform_api_credentials",
		);
		await db.unsafe(
			"insert into platform.agents(id,current_configuration_revision,authorization_revision) values($1,7,'authorization_9')",
			[configuration.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values('agent_application',$1,'owner_01','Agent','Synthetic task test','available','trace_seed','request_seed',now(),11,1,'ready','running',1,1)",
			[configuration.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) values($1,7,'template_01',now(),$2::text::jsonb)",
			[configuration.agentId, JSON.stringify(configuration)],
		);
		await db.unsafe(
			"insert into platform.agent_owners(agent_id,owner_id,created_at) values($1,'owner_01',now())",
			[configuration.agentId],
		);
		await db.unsafe(
			"insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values($1,'Synthetic application','owner_01','application_current')",
			[sharedId],
		);
		for (const kind of ["user", "application"] as const) {
			await db.unsafe(
				"insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision) values($1,$2,$3,'use','authorization_9')",
				[configuration.agentId, kind, sharedId],
			);
		}
		await db.unsafe(
			"insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision) values($1,'user','owner_01','use','authorization_9')",
			[configuration.agentId],
		);
		for (const [id, secret, kind, principalId] of [
			["user_credential", credentials.user, "user", sharedId],
			[
				"application_credential",
				credentials.application,
				"application",
				sharedId,
			],
			["replacement_credential", credentials.replacement, "user", sharedId],
			["owner_credential", credentials.owner, "user", "owner_01"],
		] as const) {
			await db.unsafe(
				"insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values($1,$2,$3,$4,'[\"agent:use\"]'::jsonb)",
				[id, kind, principalId, hashApiCredentialV1(secret)],
			);
		}
	});
	afterAll(async () => {
		if (server)
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		await assembly?.close();
		await db?.end();
		await database?.stop();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await vi.waitFor(
			async () => {
				const [row] = await db.unsafe(
					"select count(*)::int as pending from platform.audit_events started where action='task.api.subscription.started' and not exists (select 1 from platform.audit_events ended where ended.action='task.api.subscription.ended' and ended.details->>'subscriptionId'=started.details->>'subscriptionId')",
				);
				expect(row?.pending).toBe(0);
			},
			{ timeout: 5000 },
		);
	});
	it("preserves distinct authentication and authorization query denials through PostgreSQL and administrator detail HTTP", async () => {
		for (const [credential, status, reason] of [
			["PRIVATE_INVALID_BEARER", 401, "AUTHENTICATION_REQUIRED"],
			[credentials.user, 403, "AUTHORIZATION_REVOKED"],
		] as const) {
			userActive = credential !== credentials.user;
			const response = await request(
				"/audit?agentId=PRIVATE_FILTER_SENTINEL",
				credential,
			);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ code: reason });
		}
		userActive = true;
		const rows = await db.unsafe(
			"select id, actor_type, actor_id, details from platform.audit_events where action='audit.query.failed' order by occurred_at",
		);
		expect(rows).toHaveLength(2);
		for (const [index, reason] of [
			"AUTHENTICATION_REQUIRED",
			"AUTHORIZATION_REVOKED",
		].entries()) {
			const row = rows[index];
			if (!row) throw new Error("Early query denial audit is missing");
			expect(row).toMatchObject({
				actor_type: "unknown",
				actor_id: "unknown",
				details: {
					reason,
					scope: { kind: "denied", requestedScope: "execution" },
				},
			});
			const response = await fetch(`${origin}/api/v3/admin/audit/${row.id}`, {
				headers: { cookie: "synthetic-admin-session" },
			});
			expect(response.status).toBe(200);
			const record = ScopedPlatformAuditProjectionV1Schema.parse(
				await response.json(),
			);
			expect(record.summary).toBe(`audit.query.failed: reason=${reason}`);
			expect(record.actor).toEqual({ kind: "unknown", actorId: "unknown" });
			expect(JSON.stringify([row, record])).not.toMatch(
				/PRIVATE|synthetic-task-user-credential/,
			);
		}
	});

	it("retains the persisted credential adapter's generic authentication denial for expired bearers", async () => {
		await db.unsafe(
			"update platform.platform_api_credentials set expires_at=now()-interval '1 minute' where id='user_credential'",
		);
		const response = await request("/audit");
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			code: "AUTHENTICATION_REQUIRED",
		});
		const [row] = await db.unsafe(
			"select id, actor_type, actor_id, details from platform.audit_events where action='audit.query.failed'",
		);
		expect(row).toMatchObject({
			actor_type: "unknown",
			actor_id: "unknown",
			details: { reason: "AUTHENTICATION_REQUIRED" },
		});
		if (!row) throw new Error("Expired credential query audit is missing");
		const readback = await fetch(`${origin}/api/v3/admin/audit/${row.id}`, {
			headers: { cookie: "synthetic-admin-session" },
		});
		expect(readback.status).toBe(200);
		expect(await readback.json()).toMatchObject({
			summary: "audit.query.failed: reason=AUTHENTICATION_REQUIRED",
		});
		expect(JSON.stringify(row)).not.toContain(credentials.user);
	});

	it("keeps early query denial closed and sanitized when its PostgreSQL audit cannot persist", async () => {
		await db.unsafe(
			"create function platform.early_audit_http_failure() returns trigger language plpgsql as $$ begin if NEW.action='audit.query.failed' then raise exception 'PRIVATE_DENIAL_DATABASE_SENTINEL'; end if; return NEW; end $$",
		);
		await db.unsafe(
			"create trigger early_audit_http_failure before insert on platform.audit_events for each row execute function platform.early_audit_http_failure()",
		);
		try {
			const response = await request("/audit", "PRIVATE_INVALID_BEARER");
			expect(response.status).toBe(503);
			const body = await response.json();
			expect(body).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
			expect(JSON.stringify(body)).not.toMatch(/PRIVATE|items|nextCursor/);
			expect(
				await db.unsafe(
					"select id from platform.audit_events where action like 'audit.query.%'",
				),
			).toHaveLength(0);
		} finally {
			await db.unsafe(
				"drop trigger early_audit_http_failure on platform.audit_events",
			);
			await db.unsafe("drop function platform.early_audit_http_failure()");
		}
	});

	it("reads the actual accepted task audit through list and default detail HTTP queries", async () => {
		const task = await submit();
		const response = await request(
			`/audit?executionId=${task.executionId}&action=task.authorization.accepted`,
		);
		expect(response.status).toBe(200);
		const page = ScopedPlatformAuditPageV1Schema.parse(await response.json());
		expect(page.items).toHaveLength(1);
		const accepted = page.items[0];
		expect(accepted).toMatchObject({
			executionId: task.executionId,
			originalPrincipal: { kind: "user", id: sharedId },
			result: "accepted",
		});
		const detail = await request(`/audit/${accepted?.auditId}`);
		expect(detail.status).toBe(200);
		expect(
			ScopedPlatformAuditProjectionV1Schema.parse(await detail.json()),
		).toEqual(accepted);
	});
	it("reads own submission attempts and replays without inventing an Execution association", async () => {
		const task = await submit();
		expect(await submit()).toEqual(task);
		const response = await request(
			`/audit?agentId=${configuration.agentId}&action=task.api.access`,
		);
		expect(response.status).toBe(200);
		const page = ScopedPlatformAuditPageV1Schema.parse(await response.json());
		expect(page.items).toHaveLength(2);
		for (const attempt of page.items) {
			expect(attempt).toMatchObject({
				actor: { kind: "user", actorId: sharedId },
				subject: { kind: "agent", subjectId: configuration.agentId },
				result: "succeeded",
				summary: "task.api.access: request_accepted",
				taskApi: {
					operation: "submit",
					phase: "access",
					reason: "request_accepted",
				},
				executionId: null,
				authorizationRecordId: null,
				originalPrincipal: null,
				operation: null,
			});
			const detail = await request(`/audit/${attempt.auditId}`);
			expect(detail.status).toBe(200);
			expect(
				ScopedPlatformAuditProjectionV1Schema.parse(await detail.json()),
			).toEqual(attempt);
		}
		expect(new Set(page.items.map((attempt) => attempt.requestId)).size).toBe(
			2,
		);
		const associated = await request(
			`/audit?executionId=${task.executionId}&action=task.api.access`,
		);
		expect(associated.status).toBe(200);
		expect(
			ScopedPlatformAuditPageV1Schema.parse(await associated.json()).items,
		).toEqual([]);
		expect((await request(path(task))).status).toBe(200);
		expect(
			(
				await request(`${path(task)}/cancel`, credentials.user, {
					schemaVersion: 1,
				})
			).status,
		).toBe(202);
		const operations = await request(
			`/audit?executionId=${task.executionId}&action=task.api.access`,
		);
		expect(operations.status).toBe(200);
		const operationPage = ScopedPlatformAuditPageV1Schema.parse(
			await operations.json(),
		);
		expect(
			operationPage.items.map((attempt) => attempt.taskApi?.operation).sort(),
		).toEqual(["cancel", "read"]);
		for (const attempt of operationPage.items) {
			expect(attempt).toMatchObject({
				executionId: task.executionId,
				taskApi: { phase: "access", reason: "request_accepted" },
			});
			const detail = await request(`/audit/${attempt.auditId}`);
			expect(detail.status).toBe(200);
			expect(
				ScopedPlatformAuditProjectionV1Schema.parse(await detail.json()),
			).toEqual(attempt);
		}
	});
	it("atomically accepts and replays user/application tasks with the same ID and key", async () => {
		const user = await submit();
		const application = await submit(credentials.application);
		expect(application.executionId).not.toBe(user.executionId);
		expect(await submit()).toEqual(user);
		expect(await counts()).toEqual({
			conversations: 2,
			executions: 2,
			authorizations: 2,
		});
		const rows = await db.unsafe(
			"select boundary from platform.task_authorization_records order by boundary->>'channelId'",
		);
		expect(
			rows.map((row) => (row.boundary as { channelId: string }).channelId),
		).toEqual(["api:application", "api:user"]);
		expect((await request(path(user), credentials.application)).status).toBe(
			404,
		);
		expect((await request(path(application), credentials.user)).status).toBe(
			404,
		);
		expect(
			(
				await request(`${path(application)}/cancel`, credentials.owner, {
					schemaVersion: 1,
				})
			).status,
		).toBe(404);
		expect(
			(await request(`${path(application)}/events`, credentials.owner)).status,
		).toBe(404);
	});
	it("isolates actual task audit producers for two users, the application and the administrator", async () => {
		const user = await submit();
		const application = await submit(credentials.application);
		expect(
			(
				await request(`${path(user)}/cancel`, credentials.user, {
					schemaVersion: 1,
				})
			).status,
		).toBe(202);
		const owner = await submit(credentials.owner);
		expect(await submit(credentials.application)).toEqual(application);
		const records = [];
		for (const [task, credential, principal] of [
			[user, credentials.user, { kind: "user", id: sharedId }],
			[
				application,
				credentials.application,
				{ kind: "application", id: sharedId },
			],
			[owner, credentials.owner, { kind: "user", id: "owner_01" }],
		] as const) {
			const response = await request(
				"/audit?action=task.authorization.accepted",
				credential,
			);
			expect(response.status).toBe(200);
			const page = ScopedPlatformAuditPageV1Schema.parse(await response.json());
			expect(page.items).toHaveLength(1);
			expect(page.items[0]).toMatchObject({
				executionId: task.executionId,
				originalPrincipal: principal,
			});
			const attempts = await request(
				`/audit?agentId=${configuration.agentId}&action=task.api.access`,
				credential,
			);
			expect(attempts.status).toBe(200);
			const attemptPage = ScopedPlatformAuditPageV1Schema.parse(
				await attempts.json(),
			);
			for (const attempt of attemptPage.items)
				expect(attempt.actor).toEqual({
					kind: principal.kind,
					actorId: principal.id,
				});
			const submitAttempts = attemptPage.items.filter(
				(attempt) => attempt.taskApi?.operation === "submit",
			);
			expect(submitAttempts).toHaveLength(
				principal.kind === "application" ? 2 : 1,
			);
			for (const attempt of submitAttempts)
				expect(attempt).toMatchObject({
					subject: { kind: "agent", subjectId: configuration.agentId },
					executionId: null,
					authorizationRecordId: null,
					taskApi: { phase: "access", reason: "request_accepted" },
				});
			records.push({
				task,
				credential,
				auditId: page.items[0]?.auditId,
				attemptAuditIds: submitAttempts.map((attempt) => attempt.auditId),
			});
		}
		for (const record of records) {
			for (const other of records.filter((candidate) => candidate !== record)) {
				expect(
					(await request(`/audit/${record.auditId}`, other.credential)).status,
				).toBe(404);
				for (const attemptAuditId of record.attemptAuditIds)
					expect(
						(await request(`/audit/${attemptAuditId}`, other.credential))
							.status,
					).toBe(404);
				expect(
					(
						await request(
							`/audit?executionId=${record.task.executionId}`,
							other.credential,
						)
					).status,
				).toBe(404);
			}
		}
		const administrator = await fetch(
			`${origin}/api/v3/admin/audit?action=task.authorization.accepted`,
			{
				headers: { cookie: "synthetic-admin-session" },
			},
		);
		expect(administrator.status).toBe(200);
		const page = ScopedPlatformAuditPageV1Schema.parse(
			await administrator.json(),
		);
		expect(page.items.map((record) => record.executionId).sort()).toEqual(
			[user.executionId, application.executionId, owner.executionId].sort(),
		);
		expect(JSON.stringify(page)).not.toContain("synthetic task");
	});
	it("rechecks audit authority and returns sanitized HTTP failure when necessary query audit cannot persist", async () => {
		const task = await submit();
		const response = await request(
			`/audit?executionId=${task.executionId}&limit=1`,
		);
		expect(response.status).toBe(200);
		const page = ScopedPlatformAuditPageV1Schema.parse(await response.json());
		expect(page.nextCursor).not.toBeNull();
		await db.unsafe(
			"update platform.agent_principal_grants set revoked_at=now() where principal_type='user' and principal_id=$1",
			[sharedId],
		);
		for (const url of [
			`/audit/${page.items[0]?.auditId}`,
			`/audit?executionId=${task.executionId}&limit=1&cursor=${page.nextCursor}`,
		])
			expect((await request(url)).status).toBe(404);
		await db.unsafe(
			"update platform.agent_principal_grants set revoked_at=null where principal_type='user' and principal_id=$1",
			[sharedId],
		);
		await db.unsafe(
			"create function platform.audit_http_failure() returns trigger language plpgsql as $$ begin if NEW.action like 'audit.query.%' then raise exception 'PRIVATE_AUDIT_DATABASE_SENTINEL'; end if; return NEW; end $$",
		);
		await db.unsafe(
			"create trigger audit_http_failure before insert on platform.audit_events for each row execute function platform.audit_http_failure()",
		);
		try {
			const failed = await request(`/audit?executionId=${task.executionId}`);
			expect(failed.status).toBe(503);
			expect(await failed.json()).toMatchObject({
				code: "DEPENDENCY_UNAVAILABLE",
			});
			const failedDetail = await request(`/audit/${page.items[0]?.auditId}`);
			expect(failedDetail.status).toBe(503);
			expect(await failedDetail.text()).not.toMatch(
				/PRIVATE_AUDIT_DATABASE_SENTINEL|items|nextCursor/,
			);
		} finally {
			await db.unsafe(
				"drop trigger audit_http_failure on platform.audit_events",
			);
			await db.unsafe("drop function platform.audit_http_failure()");
		}
	});
	it("preserves legacy administrator audit and mixed-record paging without inventing user ownership", async () => {
		await db.unsafe(
			"insert into platform.audit_events(id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,agent_id,occurred_at,details) values('legacy_audit','legacy_trace','user',$1,'agent.application.rejected','agent_application','legacy_application','rejected',$2,'2026-09-01T00:00:00Z',null)",
			[sharedId, configuration.agentId],
		);
		const adminHeaders = { cookie: "synthetic-admin-session" };
		const legacy = await fetch(`${origin}/api/v1/admin/audit`, {
			headers: adminHeaders,
		});
		expect(legacy.status).toBe(200);
		expect(await legacy.json()).toMatchObject({
			items: [
				{ auditId: "legacy_audit", action: "agent.application.rejected" },
			],
		});
		const task = await submit();
		const records = [];
		let cursor: string | null = null;
		do {
			const search = new URLSearchParams({
				limit: "1",
				agentId: configuration.agentId,
			});
			if (cursor) search.set("cursor", cursor);
			const response = await fetch(`${origin}/api/v3/admin/audit?${search}`, {
				headers: adminHeaders,
			});
			expect(response.status).toBe(200);
			const page = ScopedPlatformAuditPageV1Schema.parse(await response.json());
			records.push(...page.items);
			cursor = page.nextCursor;
			expect(records.length).toBeLessThan(20);
		} while (cursor);
		expect(new Set(records.map((record) => record.auditId)).size).toBe(
			records.length,
		);
		expect(
			records.find((record) => record.auditId === "legacy_audit"),
		).toMatchObject({
			result: "rejected",
			originalPrincipal: null,
			executionId: null,
		});
		expect(
			records.some((record) => record.executionId === task.executionId),
		).toBe(true);
		expect(JSON.stringify(records)).not.toContain("details");
		const own = await request(`/audit?agentId=${configuration.agentId}`);
		expect(own.status).toBe(200);
		const page = ScopedPlatformAuditPageV1Schema.parse(await own.json());
		const executions = page.items.filter(
			(record) => record.executionId !== null,
		);
		expect(executions.length).toBeGreaterThan(0);
		expect(
			executions.every((record) => record.executionId === task.executionId),
		).toBe(true);
		const attempts = page.items.filter((record) => record.executionId === null);
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({
			action: "task.api.access",
			actor: { kind: "user", actorId: sharedId },
			subject: { kind: "agent", subjectId: configuration.agentId },
			taskApi: {
				operation: "submit",
				phase: "access",
				reason: "request_accepted",
			},
			authorizationRecordId: null,
			originalPrincipal: null,
		});
		expect(page.items.some((record) => record.auditId === "legacy_audit")).toBe(
			false,
		);
		expect((await request("/audit/legacy_audit")).status).toBe(404);
	});
	it("rejects conflicting retries and capacity before creating another conversation", async () => {
		await submit();
		expect(
			(
				await request(
					`/agents/${configuration.agentId}/tasks`,
					credentials.user,
					{ schemaVersion: 1, text: "different synthetic request" },
				)
			).status,
		).toBe(409);
		await submit(credentials.application);
		expect(
			(
				await request(
					`/agents/${configuration.agentId}/tasks`,
					credentials.user,
					{ schemaVersion: 1, text: "synthetic task" },
					"third",
				)
			).status,
		).toBe(409);
		expect(await counts()).toEqual({
			conversations: 2,
			executions: 2,
			authorizations: 2,
		});
	});
	it("allows startup waiting and rejects stopped Agents without orphan records", async () => {
		await db.unsafe(
			"update platform.agent_applications set service_availability='starting' where agent_id=$1",
			[configuration.agentId],
		);
		const task = await submit();
		expect(await (await request(path(task))).json()).toMatchObject({
			status: "waiting",
			output: "",
		});
		await db.unsafe(
			"update platform.agent_applications set status='stopped',desired_state='stopped',service_availability=null where agent_id=$1",
			[configuration.agentId],
		);
		expect(
			(
				await request(
					`/agents/${configuration.agentId}/tasks`,
					credentials.user,
					{ schemaVersion: 1, text: "synthetic task" },
					"stopped",
				)
			).status,
		).toBe(503);
		expect(await counts()).toEqual({
			conversations: 1,
			executions: 1,
			authorizations: 1,
		});
	});
	it("explicitly continues only the same principal and channel and cancels waiting work", async () => {
		const task = await submit();
		expect(
			(
				await request(
					`/agents/${configuration.agentId}/tasks`,
					credentials.application,
					{
						schemaVersion: 1,
						text: "synthetic task",
						conversationId: task.conversationId,
					},
					"continue",
				)
			).status,
		).toBe(404);
		const next = await submit(
			credentials.user,
			"continue",
			task.conversationId,
		);
		expect(next.conversationId).toBe(task.conversationId);
		const cancelled = await request(
			`${path(next)}/cancel`,
			credentials.user,
			{ schemaVersion: 1 },
			"cancel",
		);
		expect(cancelled.status).toBe(202);
		expect(await (await request(path(next))).json()).toMatchObject({
			status: "cancelled",
		});
		expect(await (await request(path(task))).json()).toMatchObject({
			status: "waiting",
		});
	});
	it("credential revocation preserves the task and a replacement credential reads it", async () => {
		const task = await submit();
		await db.unsafe(
			"update platform.platform_api_credentials set revoked_at=now() where id='user_credential'",
		);
		expect((await request(path(task))).status).toBe(401);
		expect(
			await (await request(path(task), credentials.replacement)).json(),
		).toMatchObject({ executionId: task.executionId, status: "waiting" });
		const [row] = await db.unsafe(
			"select revoked_at from platform.task_authorization_records where execution_id=$1",
			[task.executionId],
		);
		expect(row?.revoked_at).toBeNull();
	});
	it("use grant revocation rejects access even for the responsible Owner", async () => {
		const task = await submit(credentials.application);
		await db.unsafe(
			"update platform.agent_principal_grants set revoked_at=now() where principal_type='application'",
		);
		expect((await request(path(task), credentials.application)).status).toBe(
			404,
		);
		expect((await request(path(task), credentials.owner)).status).toBe(404);
		expect(
			(
				await request(`${path(task)}/cancel`, credentials.application, {
					schemaVersion: 1,
				})
			).status,
		).toBe(404);
	});
	it("queries and streams only the requested execution, then closes on credential revoke", async () => {
		const first = await submit();
		const second = await submit(
			credentials.user,
			"second",
			first.conversationId,
		);
		await output(first, "first synthetic output");
		await output(second, "other execution output");
		const projection = (await (await request(path(first))).json()) as {
			output: string;
			events: { executionId: string }[];
		};
		expect(projection.output).toBe("first synthetic output");
		expect(
			projection.events.every(
				(event) => event.executionId === first.executionId,
			),
		).toBe(true);
		const controller = new AbortController();
		try {
			const response = await request(
				`${path(first)}/events`,
				credentials.user,
				undefined,
				"stream",
				controller.signal,
			);
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			let text = "";
			while (!text.includes('"type":"heartbeat"')) {
				const chunk = await reader?.read();
				if (chunk?.done)
					throw new Error("Task stream closed before its heartbeat");
				text += new TextDecoder().decode(chunk?.value);
			}
			expect(text).toContain("first synthetic output");
			expect(text).not.toContain("other execution output");
			await db.unsafe(
				"update platform.platform_api_credentials set revoked_at=now() where id='user_credential'",
			);
			for (;;) {
				const chunk = await reader?.read();
				if (chunk?.done) break;
				text += new TextDecoder().decode(chunk?.value);
			}
			expect(text).toContain('"type":"authorization.revoked"');
			expect(
				await (await request(path(first), credentials.replacement)).json(),
			).toMatchObject({ status: "waiting" });
		} finally {
			controller.abort();
		}
	}, 10_000);
	it("reads and streams the formal stop-timeout reason without exposing it across principals", async () => {
		const task = await submit();
		await db.unsafe(
			"update platform.conversation_executions set status='processing' where execution_id=$1",
			[task.executionId],
		);
		await db.unsafe(
			"update platform.conversations set status='active',host_session_ref='original-timeout-session' where id=$1",
			[task.conversationId],
		);
		await db.unsafe(
			"update platform.outbox_items set available_at=now() where id=$1",
			[`conversation:turn:${task.executionId}`],
		);
		const store = new PostgresConversationDispatchStoreV1({
			databaseUrl: database.databaseUrl,
		});
		const controls = new PostgresTaskAuthorizationStoreV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			const decision = await store.claim({
				schemaVersion: 1,
				itemId: `conversation:turn:${task.executionId}`,
				workerId: "timeout-worker",
				leaseDurationMs: 30_000,
			});
			if (decision.outcome !== "claimed")
				throw new Error(`Expected task claim: ${decision.outcome}`);
			const [authorization] = await db.unsafe(
				"select id from platform.task_authorization_records where execution_id=$1",
				[task.executionId],
			);
			await controls.recordControl({
				executionId: task.executionId,
				authorizationRecordId: String(authorization?.id),
				reason: "stop",
				workerId: "timeout-worker",
				traceId: "trace-stop-timeout",
				requestId: "request-stop-timeout",
			});
			await db.unsafe(
				"update platform.conversation_stops set confirmation_deadline=now()-interval '1 second' where execution_id=$1",
				[task.executionId],
			);
			expect(
				await store.renew({ claim: decision.claim, leaseDurationMs: 30_000 }),
			).toBe(true);
			const response = await request(path(task));
			expect(response.status).toBe(200);
			const projection = TaskProjectionV1Schema.parse(await response.json());
			expect(projection.status).toBe("unknown");
			expect(projection.events).toContainEqual(
				expect.objectContaining({
					schemaVersion: 2,
					type: "task.status",
					payload: { status: "unknown", reason: "STOP_CONFIRMATION_TIMEOUT" },
				}),
			);
			expect((await request(path(task), credentials.application)).status).toBe(
				404,
			);
			const controller = new AbortController();
			try {
				const stream = await request(
					`${path(task)}/events`,
					credentials.user,
					undefined,
					"timeout-stream",
					controller.signal,
				);
				const reader = stream.body?.getReader();
				let text = "";
				while (!text.includes("STOP_CONFIRMATION_TIMEOUT")) {
					const chunk = await reader?.read();
					if (!chunk || chunk.done)
						throw new Error("Stream closed without stop reason");
					text += new TextDecoder().decode(chunk.value);
				}
				for (const line of text
					.split("\n")
					.filter((line) => line.startsWith("data: ")))
					TaskSseMessageV1Schema.parse(JSON.parse(line.slice(6)));
			} finally {
				controller.abort();
			}
		} finally {
			await Promise.all([store.close(), controls.close()]);
		}
	}, 10_000);

	it("reads and replays persisted V2 operation facts through the Store projection", async () => {
		const task = await submit();
		const outputId = await output(task, "synthetic operation output");
		const fact = {
			kind: "model",
			operationRef: "synthetic-model-operation",
			attemptRef: "synthetic-model-attempt",
			phase: "intent",
			model: {
				configVersion: "revision-7",
				modelOptionId: "option-1",
				modelId: "model-1",
				reasoningLevel: "medium",
			},
		};
		const eventId = `operation_${task.executionId}`;
		await db.unsafe(
			"insert into platform.conversation_events(event_id,conversation_id,execution_id,adapter_event_key,sequence,conversation_cursor,event_type,event_payload,event_digest,runtime_cursor,occurred_at,source) select $1,$2,$3,$1,3,last_conversation_cursor+1,'execution.operation',$4::text::jsonb,$5,$1,now(),'runtime' from platform.conversations where id=$2",
			[
				eventId,
				task.conversationId,
				task.executionId,
				JSON.stringify({ schemaVersion: 2, type: "execution.operation", fact }),
				"b".repeat(64),
			],
		);
		await db.unsafe(
			"update platform.conversations set last_conversation_cursor=last_conversation_cursor+1 where id=$1",
			[task.conversationId],
		);
		await db.unsafe(
			"update platform.conversation_executions set status='completed' where execution_id=$1",
			[task.executionId],
		);
		const read = await request(path(task));
		expect(read.status).toBe(200);
		const projection = TaskProjectionV1Schema.parse(await read.json());
		expect(projection.output).toBe("synthetic operation output");
		expect(projection.events.at(-1)).toMatchObject({
			schemaVersion: 2,
			type: "execution.operation",
			eventId,
			payload: fact,
		});
		const replay = await fetch(`${origin}/api/v1${path(task)}/events`, {
			headers: {
				authorization: `Bearer ${credentials.user}`,
				"Last-Event-ID": outputId,
			},
			signal: AbortSignal.timeout(5000),
		});
		expect(replay.status).toBe(200);
		const reader = replay.body?.getReader();
		if (!reader) throw new Error("Task replay body is missing");
		try {
			let stream = "";
			while (!stream.includes('"type":"heartbeat"')) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("Task replay ended before heartbeat");
				stream += new TextDecoder().decode(chunk.value);
			}
			const messages = stream
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => TaskSseMessageV1Schema.parse(JSON.parse(line.slice(6))));
			expect(messages).toContainEqual(projection.events.at(-1));
			expect(stream).not.toContain("synthetic operation output");
			expect(stream).not.toContain('"type":"task.stream.error"');
		} finally {
			await reader.cancel();
		}
	});
	it("closes the stream as revoked when the credential loses its use scope", async () => {
		const task = await submit();
		const controller = new AbortController();
		try {
			const response = await request(
				`${path(task)}/events`,
				credentials.user,
				undefined,
				"stream",
				controller.signal,
			);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Task stream body is missing");
			let text = "";
			while (!text.includes('"type":"heartbeat"')) {
				const chunk = await reader.read();
				if (chunk.done)
					throw new Error("Task stream closed before its heartbeat");
				text += new TextDecoder().decode(chunk.value);
			}
			await db.unsafe(
				"update platform.platform_api_credentials set scopes='[\"agent:manage\"]'::jsonb where id='user_credential'",
			);
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				text += new TextDecoder().decode(chunk.value);
			}
			expect(text).toContain('"type":"authorization.revoked"');
			expect(text).not.toContain('"type":"task.stream.error"');
			expect(
				await (await request(path(task), credentials.replacement)).json(),
			).toMatchObject({ executionId: task.executionId, status: "waiting" });
		} finally {
			controller.abort();
		}
	}, 10_000);
	it("reconnects using original event IDs and rejects another execution's event ID", async () => {
		const first = await submit();
		const second = await submit(
			credentials.user,
			"second",
			first.conversationId,
		);
		const firstEvent = await output(first, "first synthetic output");
		const otherEvent = await output(second, "other execution output");
		const firstDetail = TaskProjectionV1Schema.parse(
			await (await request(path(first))).json(),
		);
		const otherDetail = TaskProjectionV1Schema.parse(
			await (await request(path(second))).json(),
		);
		const firstCursor = firstDetail.events.at(-1)?.conversationCursor;
		const otherCursor = otherDetail.events.at(-1)?.conversationCursor;
		if (!firstCursor || !otherCursor)
			throw new Error("Task cursor fixtures are missing");
		const unknownCursor = `v1.${Buffer.from(
			JSON.stringify(["conversation", first.conversationId, 1024]),
		).toString("base64url")}`;
		for (const [kind, value, expected] of [
			["last-event-id", firstEvent, "heartbeat"],
			["last-event-id", otherEvent, "timeline.reload"],
			["cursor", firstCursor, "heartbeat"],
			["cursor", otherCursor, "timeline.reload"],
			["cursor", unknownCursor, "timeline.reload"],
		] as const) {
			const controller = new AbortController();
			try {
				const url = new URL(`${origin}/api/v1${path(first)}/events`);
				if (kind === "cursor") url.searchParams.set("cursor", value);
				const response = await fetch(url, {
					headers: {
						authorization: `Bearer ${credentials.user}`,
						...(kind === "last-event-id" ? { "Last-Event-ID": value } : {}),
					},
					signal: controller.signal,
				});
				expect(response.status).toBe(200);
				const reader = response.body?.getReader();
				let text = "";
				while (
					!text.includes('"type":"heartbeat"') &&
					!text.includes('"type":"timeline.reload"')
				) {
					const chunk = await reader?.read();
					if (chunk?.done) break;
					text += new TextDecoder().decode(chunk?.value);
				}
				expect(text).toContain(expected);
				expect(text).not.toContain("other execution output");
				expect(text).not.toContain("first synthetic output");
			} finally {
				controller.abort();
			}
		}
		expect(
			(await request(`${path(first)}/events?cursor=malformed`)).status,
		).toBe(400);
	}, 10_000);
	it("reports replay dependency failure as a retryable stream control without error details", async () => {
		const task = await submit();
		const query = assembly.dependencies.tasks?.query;
		if (!query) throw new Error("Formal task assembly is absent");
		const replay = query.replayExecution.bind(query);
		let calls = 0;
		vi.spyOn(query, "replayExecution").mockImplementation(async (...input) => {
			if (++calls > 1) throw new Error("synthetic private storage diagnostic");
			return replay(...input);
		});
		const controller = new AbortController();
		try {
			const response = await request(
				`${path(task)}/events`,
				credentials.user,
				undefined,
				"stream",
				controller.signal,
			);
			expect(response.status).toBe(200);
			const text = await response.text();
			expect(text).toContain('"type":"task.stream.error"');
			expect(text).toContain('"code":"DEPENDENCY_UNAVAILABLE"');
			expect(text).toContain('"retryable":true');
			expect(text).not.toContain("synthetic private storage diagnostic");
		} finally {
			controller.abort();
		}
	}, 10_000);
	it("persists access, denial and correlated subscription lifecycle without content or credentials", async () => {
		const task = await submit(credentials.application);
		await output(task, "synthetic private audit canary");
		expect((await request(path(task), credentials.application)).status).toBe(
			200,
		);
		expect((await request(path(task), credentials.owner)).status).toBe(404);
		expect(
			(await request(path(task), "invalid-synthetic-credential")).status,
		).toBe(401);
		const controller = new AbortController();
		const response = await request(
			`${path(task)}/events`,
			credentials.application,
			undefined,
			"stream",
			controller.signal,
		);
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Task stream body is missing");
		await reader.read();
		controller.abort();
		await vi.waitFor(
			async () => {
				const [row] = await db.unsafe(
					"select count(*)::int as count from platform.audit_events where action='task.api.subscription.ended'",
				);
				expect(row?.count).toBe(1);
			},
			{ timeout: 5000 },
		);
		const rows = await db.unsafe(
			"select action,actor_type,actor_id,target_type,target_id,outcome,details,request_id,trace_id from platform.audit_events where action like 'task.api.%' order by occurred_at",
		);
		const subscription = rows.filter((row) => row.action !== "task.api.access");
		expect(subscription.map((row) => row.action)).toEqual([
			"task.api.subscription.started",
			"task.api.subscription.ended",
		]);
		expect(subscription[0]?.request_id).toBe(subscription[1]?.request_id);
		expect(subscription[0]?.trace_id).toBe(subscription[1]?.trace_id);
		expect(subscription[0]?.details).toMatchObject({
			subscriptionId: expect.any(String),
		});
		const started = subscription[0]?.details as
			| { subscriptionId: string }
			| undefined;
		const ended = subscription[1]?.details as
			| { subscriptionId: string }
			| undefined;
		expect(started?.subscriptionId).toBe(ended?.subscriptionId);
		expect(
			subscription.every(
				(row) => row.actor_type === "application" && row.actor_id === sharedId,
			),
		).toBe(true);
		expect(rows).toContainEqual(
			expect.objectContaining({
				action: "task.api.access",
				actor_type: "unknown",
				target_type: "unknown",
				outcome: "rejected",
			}),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				action: "task.api.access",
				actor_type: "user",
				actor_id: "owner_01",
				target_type: "unknown",
				outcome: "rejected",
			}),
		);
		const serialized = JSON.stringify(rows);
		expect(serialized).not.toContain("synthetic private audit canary");
		expect(serialized).not.toContain("synthetic task");
		for (const credential of Object.values(credentials))
			expect(serialized).not.toContain(credential);
	});
	it("fails closed before task mutation, output or subscription when required audit persistence fails", async () => {
		const task = await submit();
		await output(task, "synthetic private output");
		const audit = assembly.dependencies.tasks?.audit;
		if (!audit) throw new Error("Formal task audit assembly is absent");
		vi.spyOn(audit, "record").mockRejectedValue(
			new Error("synthetic private audit failure"),
		);
		const deniedSubmit = await request(
			`/agents/${configuration.agentId}/tasks`,
			credentials.user,
			{ schemaVersion: 1, text: "synthetic" },
			"unwritten",
		);
		expect(deniedSubmit.status).toBe(503);
		expect(await counts()).toEqual({
			conversations: 1,
			executions: 1,
			authorizations: 1,
		});
		const deniedRead = await request(path(task));
		expect(deniedRead.status).toBe(503);
		expect(await deniedRead.text()).not.toContain("synthetic private output");
		expect(
			(
				await request(
					`${path(task)}/cancel`,
					credentials.user,
					{ schemaVersion: 1 },
					"cancel",
				)
			).status,
		).toBe(503);
		expect((await request(`${path(task)}/events`)).status).toBe(503);
		const [row] = await db.unsafe(
			"select status from platform.conversation_executions where execution_id=$1",
			[task.executionId],
		);
		expect(row?.status).toBe("waiting");
	});
	it("does not open a stream when its subscription-start audit cannot be saved", async () => {
		const task = await submit();
		const audit = assembly.dependencies.tasks?.audit;
		if (!audit) throw new Error("Formal task audit assembly is absent");
		const record = audit.record.bind(audit);
		vi.spyOn(audit, "record").mockImplementation(async (input) => {
			if (input.phase === "subscription.started")
				throw new Error("synthetic private audit failure");
			return record(input);
		});
		const response = await request(`${path(task)}/events`);
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain(
			"synthetic private audit failure",
		);
		const [row] = await db.unsafe(
			"select count(*)::int as count from platform.audit_events where action like 'task.api.subscription.%'",
		);
		expect(row?.count).toBe(0);
	});
	it("recovers a subscription end from its durable intent after end persistence fails", async () => {
		const task = await submit();
		const audit = assembly.dependencies.tasks?.audit;
		if (!audit) throw new Error("Formal task audit assembly is absent");
		const record = audit.record.bind(audit);
		const failedEnd = vi.fn();
		vi.spyOn(audit, "record").mockImplementation(async (input) => {
			if (input.phase === "subscription.ended") {
				failedEnd();
				throw new Error("Synthetic subscription end failure");
			}
			return record(input);
		});
		const controller = new AbortController();
		const response = await request(
			`${path(task)}/events`,
			credentials.user,
			undefined,
			"task_key",
			controller.signal,
		);
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Task stream body is missing");
		await reader.read();
		controller.abort();
		await vi.waitFor(() => expect(failedEnd).toHaveBeenCalledOnce());
		const [pending] = await db.unsafe(
			"select status from platform.outbox_items where scope_type='task_api_subscription'",
		);
		expect(pending?.status).toBe("processing");
		const [before] = await db.unsafe(
			"select count(*)::int as count from platform.audit_events where action='task.api.subscription.ended'",
		);
		expect(before?.count).toBe(0);
		await db.unsafe(
			"update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second' where scope_type='task_api_subscription'",
		);
		await vi.waitFor(
			async () => {
				const [ended] = await db.unsafe(
					"select outcome,details from platform.audit_events where action='task.api.subscription.ended'",
				);
				expect(ended).toMatchObject({
					outcome: "failed",
					details: {
						reason: "subscription_unconfirmed",
						target: { executionId: task.executionId },
					},
				});
			},
			{ timeout: 10_000 },
		);
		const [execution] = await db.unsafe(
			"select status from platform.conversation_executions where execution_id=$1",
			[task.executionId],
		);
		expect(execution?.status).toBe("waiting");
		expect(await audit.recoverSubscriptions()).toBe(0);
	}, 15_000);
	it("closes a subscription before output when its audit lease cannot be renewed", async () => {
		const task = await submit();
		await output(task, "synthetic protected output");
		const audit = assembly.dependencies.tasks?.audit;
		if (!audit) throw new Error("Formal task audit assembly is absent");
		vi.spyOn(audit, "renewSubscription").mockRejectedValue(
			new Error("Synthetic private lease failure"),
		);
		const response = await request(`${path(task)}/events`);
		const body = await response.text();
		expect(body).not.toContain("synthetic protected output");
		expect(body).not.toContain("Synthetic private lease failure");
		await vi.waitFor(async () => {
			const [ended] = await db.unsafe(
				"select outcome,details from platform.audit_events where action='task.api.subscription.ended'",
			);
			expect(ended).toMatchObject({
				outcome: "failed",
				details: { reason: "dependency_unavailable" },
			});
		});
	});
	it.each(["credential", "use grant"] as const)(
		"rechecks a revoked %s after a subscription renewal wait before sending output",
		async (revocation) => {
			const task = await submit();
			await output(task, "synthetic renewal protected output");
			const audit = assembly.dependencies.tasks?.audit;
			if (!audit) throw new Error("Formal task audit assembly is absent");
			const renew = audit.renewSubscription.bind(audit);
			let renewals = 0;
			vi.spyOn(audit, "renewSubscription").mockImplementation(async (id) => {
				await renew(id);
				if (++renewals === 2) {
					if (revocation === "credential")
						await db.unsafe(
							"update platform.platform_api_credentials set revoked_at=now() where id='user_credential'",
						);
					else
						await db.unsafe(
							"update platform.agent_principal_grants set revoked_at=now() where principal_type='user' and principal_id=$1 and grant_type='use'",
							[sharedId],
						);
				}
			});
			const response = await request(`${path(task)}/events`);
			const body = await response.text();
			expect(renewals).toBeGreaterThanOrEqual(2);
			expect(body).not.toContain("synthetic renewal protected output");
		},
	);
	it.each(["submit", "read", "cancel"] as const)(
		"rechecks the original credential after an audit wait before %s",
		async (operation) => {
			const task = await submit();
			const audit = assembly.dependencies.tasks?.audit;
			if (!audit) throw new Error("Formal task audit assembly is absent");
			const record = audit.record.bind(audit);
			vi.spyOn(audit, "record").mockImplementation(async (input) => {
				await record(input);
				if (input.phase === "access" && input.result === "succeeded")
					await db.unsafe(
						"update platform.platform_api_credentials set revoked_at=now() where id='user_credential'",
					);
			});
			const response =
				operation === "submit"
					? await request(
							`/agents/${configuration.agentId}/tasks`,
							credentials.user,
							{ schemaVersion: 1, text: "synthetic" },
							"second",
						)
					: operation === "cancel"
						? await request(
								`${path(task)}/cancel`,
								credentials.user,
								{ schemaVersion: 1 },
								"cancel",
							)
						: await request(path(task));
			expect(response.status).toBe(401);
			expect(await counts()).toEqual({
				conversations: 1,
				executions: 1,
				authorizations: 1,
			});
			const [row] = await db.unsafe(
				"select status from platform.conversation_executions where execution_id=$1",
				[task.executionId],
			);
			expect(row?.status).toBe("waiting");
		},
	);
	it("preserves the published management audit views after task access records are written", async () => {
		await db.unsafe(
			"insert into platform.audit_events(id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome,occurred_at) values('old_management_audit','trace_seed','user','owner_01','agent.application.submitted','agent_application','agent_application','succeeded',now()-interval '1 minute')",
		);
		const task = await submit(credentials.application);
		await request(path(task), credentials.application);
		await request(path(task), "invalid-synthetic-credential");
		for (const prefix of ["v1", "v2"]) {
			const response = await fetch(
				`${origin}/api/${prefix}/admin/audit?limit=1`,
				{
					headers: { cookie: "synthetic-admin-session" },
				},
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				items: [
					{
						auditId: "old_management_audit",
						action: "agent.application.submitted",
					},
				],
				nextCursor: null,
			});
		}
		const [row] = await db.unsafe(
			"select count(*)::int as count from platform.audit_events where action='task.api.access'",
		);
		expect(row?.count).toBe(3);
	});
	it("requires credentials/use scope and rejects caller-supplied identity fields", async () => {
		expect(
			(
				await request(
					`/agents/${configuration.agentId}/tasks`,
					"invalid-synthetic",
					{ schemaVersion: 1, text: "synthetic" },
				)
			).status,
		).toBe(401);
		expect(
			(
				await request(
					`/agents/${configuration.agentId}/tasks`,
					credentials.user,
					{ schemaVersion: 1, text: "synthetic", actorId: "owner_01" },
				)
			).status,
		).toBe(400);
		await db.unsafe(
			"update platform.platform_api_credentials set scopes='[\"agent:manage\"]'::jsonb where id='user_credential'",
		);
		expect(
			(
				await request(
					`/agents/${configuration.agentId}/tasks`,
					credentials.user,
					{ schemaVersion: 1, text: "synthetic" },
				)
			).status,
		).toBe(403);
		expect(await counts()).toEqual({
			conversations: 0,
			executions: 0,
			authorizations: 0,
		});
	});
});
