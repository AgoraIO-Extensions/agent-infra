import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import postgres from "postgres";
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
import { readCurrentTaskApplicationV1 } from "../../../packages/platform-store/src/application-task-authorization.js";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { writeTaskApiAuditV1 } from "../../../packages/platform-store/src/task-api-audit.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof serve>;
let origin: string;
const material = {
	application: `papi_${"A".repeat(43)}`,
	user: `papi_${"U".repeat(43)}`,
	replacement: `papi_${"R".repeat(43)}`,
};
const user = (revision = "user-1") => ({
	schemaVersion: 1,
	userId: "same-id",
	accountStatus: "active",
	organizationIds: [],
	authorizationRevision: revision,
});
const resolveUser = vi.fn(async (_id: string) => user());

beforeAll(async () => {
	database = await startPostgresTestDatabase("agent-api-lifecycle");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 3, onnotice: () => {} });

	const unused = async (): Promise<never> => {
		throw new Error("Unused lifecycle admission dependency");
	};
	assembly = assemblePlatformApi({
		databaseUrl: database.databaseUrl,
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 30_000,
		},
		identity: {
			resolveUser,
			resolve: async (request) => {
				const cookie = request.headers.get("Cookie");
				if (!cookie) return null;
				const id =
					cookie === "session=owner"
						? "same-id"
						: cookie === "session=responsible"
							? "human-responsible"
							: "administrator";
				return {
					schemaVersion: 1,
					userId: id,
					displayName: id,
					accountStatus: "active",
					organizationIds: [],
					roles: id === "administrator" ? ["system_admin"] : ["employee"],
					authorizationRevision: "user-1",
				};
			},
			hydrateUsers: async (ids) =>
				ids.map((id) => ({ userId: id, displayName: id, roles: ["employee"] })),
		},
		admissions: {
			authorizationAdmission: { authorize: unused },
			imageAdmission: { admitImage: unused },
			modelAdmission: { admitModels: unused },
			secretAdmission: { admitSecrets: unused },
			channelAdmission: { admitChannels: unused },
		},
		allocateApplicationIds: unused,
		prepareApplicationSecrets: unused,
		prepareConfigurationSecrets: unused,
		presentAgent: unused,
	});
	const app = createPlatformApp(assembly.dependencies);
	await new Promise<void>((resolve) => {
		server = serve(
			{ fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
			(address) => {
				origin = `http://127.0.0.1:${address.port}`;
				resolve();
			},
		);
	});
}, 120_000);
afterAll(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			if ("closeIdleConnections" in server) server.closeIdleConnections();
		});
	}
	await assembly?.close();
	await sql?.end();
	await database?.stop();
});
afterEach(async () => {
	await sql`drop trigger if exists lifecycle_fault on platform.audit_events`;
	await sql`drop function if exists platform.lifecycle_fault()`;
});

async function credential(kind: "user" | "application", value: string) {
	await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes)
	 values (${kind === "user" ? "user-credential" : value === material.replacement ? "replacement-credential" : "app-credential"},${kind},'same-id',${createHash("sha256").update(value).digest("hex")},'["agent:manage","agent:use","agent:read"]'::jsonb)`;
}
beforeEach(async () => {
	resolveUser.mockReset().mockImplementation(async (...args: unknown[]) => ({
		...user(),
		userId: typeof args[0] === "string" ? args[0] : "same-id",
	}));
	await sql`truncate platform.agents, platform.platform_applications, platform.platform_api_credentials, platform.platform_user_disables, platform.audit_events, platform.outbox_items, platform.idempotency_records cascade`;
	await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('same-id','Robot application','human-responsible','app-1')`;
	for (const agentId of ["agent-a", "agent-b", "agent-foreign"]) {
		await sql`insert into platform.agents(id,authorization_revision) values(${agentId},'agent-1')`;
		await sql`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,management_revision,approval_revision,desired_state,workload_revision,fence,trace_id,request_id,submitted_at)
		 values(${`application-${agentId}`},${agentId},'same-id','Controlled Agent','Controlled lifecycle state','stopped',2,1,'stopped',1,1,'trace-seed','request-seed',clock_timestamp())`;
		await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values(${agentId},'same-id',clock_timestamp())`;
		if (agentId !== "agent-foreign")
			for (const grant of ["manage", "use"]) {
				await sql`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision)
			 values(${agentId},'application','same-id',${grant},${`${grant}-${agentId}-1`})`;
			}
	}
	await sql`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision)
	 values('agent-a','user','same-id','manage','user-manage-1')`;
	await credential("application", material.application);
	await credential("user", material.user);
});
function request(
	agentId = "agent-a",
	command = "start",
	key = "same-key",
	value = material.application,
) {
	return fetch(`${origin}/api/v2/agents/${agentId}/commands`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${value}`,
			"Idempotency-Key": key,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ schemaVersion: 1, command }),
	});
}
async function effects() {
	const [state] =
		await sql`select status,management_revision,workload_revision,fence from platform.agent_applications where agent_id='agent-a'`;
	const [counts] = await sql<
		{ outbox: number; history: number; idempotency: number }[]
	>`select (select count(*)::int from platform.outbox_items) outbox, (select count(*)::int from platform.agent_management_history) history, (select count(*)::int from platform.idempotency_records) idempotency`;
	if (!counts) throw new Error("Missing lifecycle effect counts");
	return { state, ...counts };
}

describe("Agent lifecycle with real PostgreSQL and controlled principals", () => {
	it("new lifecycle, state, grant and refusal audits remain readable through existing administrator APIs", async () => {
		expect(
			(
				await fetch(`${origin}/api/v2/agents/agent-a/state`, {
					headers: { Authorization: `Bearer ${material.application}` },
				})
			).status,
		).toBe(200);
		expect((await request()).status).toBe(202);
		expect((await govern("agent-a", true, "audit-grant")).status).toBe(200);
		expect(
			(await govern("agent-a", true, "audit-use", "session=owner", "use"))
				.status,
		).toBe(200);
		expect(
			(
				await govern(
					"agent-a",
					false,
					"audit-use-revoke",
					"session=owner",
					"use",
				)
			).status,
		).toBe(200);
		expect(
			(await govern("agent-a", true, "audit-use", "session=owner", "use"))
				.status,
		).toBe(200);
		expect(
			(
				await govern(
					"agent-a",
					true,
					"audit-use-denied",
					"session=responsible",
					"use",
				)
			).status,
		).toBe(404);
		expect(
			(await request("agent-a", "start", "different-start-key")).status,
		).toBe(409);
		expect(
			(
				await fetch(`${origin}/api/v2/agents/agent-a/commands`, {
					method: "POST",
					body: "{}",
				})
			).status,
		).toBe(401);
		for (const path of ["/api/v2/admin/audit", "/api/v3/admin/audit"]) {
			const response = await fetch(`${origin}${path}?limit=100`, {
				headers: { Cookie: "session=administrator" },
			});
			expect(response.status).toBe(200);
			const page = (await response.json()) as {
				items: Array<{ action: string; actor: unknown }>;
			};
			expect(page.items.map((row) => row.action)).toEqual(
				expect.arrayContaining([
					"api.agent.state.read",
					"agent.lifecycle.restarted",
					"api.agent.manager.granted",
					"api.agent.use.granted",
					"api.agent.use.revoked",
					"api.agent.use.replayed",
					"api.agent.use.refused",
					"api.agent.lifecycle.refused",
				]),
			);
			expect(
				page.items.some((row) =>
					JSON.stringify(row.actor).includes('"kind":"application"'),
				),
			).toBe(true);
			expect(
				page.items.some((row) =>
					JSON.stringify(row.actor).includes('"kind":"unknown"'),
				),
			).toBe(true);
			expect(JSON.stringify(page)).not.toContain(material.application);
		}
	});

	it("an application Token reads only its explicitly authorized Agent lifecycle state", async () => {
		const headers = { Authorization: `Bearer ${material.application}` };
		const response = await fetch(`${origin}/api/v2/agents/agent-a/state`, {
			headers,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			agentId: "agent-a",
			status: "stopped",
			serviceAvailability: null,
			revision: 2,
		});
		expect(
			(await fetch(`${origin}/api/v2/agents/agent-foreign/state`, { headers }))
				.status,
		).toBe(404);
		expect(resolveUser).not.toHaveBeenCalled();
	});

	function govern(
		agentId: string,
		granted: boolean,
		key: string,
		cookie = "session=owner",
		grantType: "manage" | "use" = "manage",
	) {
		return fetch(
			`${origin}/api/v2/agents/${agentId}/${grantType === "manage" ? "application-managers" : "application-use-grants"}/same-id`,
			{
				method: granted ? "PUT" : "DELETE",
				headers: {
					Cookie: cookie,
					"Idempotency-Key": key,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ schemaVersion: 1 }),
			},
		);
	}

	function revokeUserUse(
		agentId = "agent-a",
		userId = "same-id",
		key = "user-revoke",
	) {
		return fetch(
			`${origin}/api/v2/agents/${agentId}/api-use-grants/${userId}`,
			{
				method: "DELETE",
				headers: {
					Cookie: "session=owner",
					"Idempotency-Key": key,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ schemaVersion: 1, expectedRevision: 2 }),
			},
		);
	}

	it("Owner revokes a typed user API-use grant and replays its original result", async () => {
		await sql`insert into platform.agent_principal_grants
			(agent_id, principal_type, principal_id, grant_type, authorization_revision)
			values ('agent-a', 'user', 'same-id', 'use', 'user-use-1')`;
		const revoked = await revokeUserUse();
		expect(revoked.status).toBe(200);
		expect(await revoked.json()).toMatchObject({
			agentId: "agent-a",
			userId: "same-id",
			granted: false,
			replayed: false,
		});
		const replay = await revokeUserUse("agent-a", "same-id", "user-revoke");
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({
			granted: false,
			replayed: true,
		});
		const [grant] = await sql`
			select revoked_at from platform.agent_principal_grants
			where agent_id='agent-a' and principal_type='user'
				and principal_id='same-id' and grant_type='use'`;
		expect(grant?.revoked_at).not.toBeNull();
	});

	it("Owner-issued independent use revisions authorize only the application's own existing API audits", async () => {
		await sql`delete from platform.agent_principal_grants where principal_type='application' and grant_type='use'`;
		expect(
			(await govern("agent-a", true, "audit-use-new", "session=owner", "use"))
				.status,
		).toBe(200);
		for (const kind of ["application", "user"] as const)
			await sql.begin((transaction) =>
				writeTaskApiAuditV1(transaction, {
					schemaVersion: 1,
					auditId: `owned-attempt-${kind}`,
					operation: "submit",
					phase: "access",
					result: "rejected",
					reason: "resource_unavailable",
					principal: { kind, id: "same-id" },
					target: { kind: "agent", agentId: "agent-a" },
					requestId: `request-${kind}`,
					traceId: `trace-${kind}`,
					action: "task.api.access",
					occurredAt: new Date(),
				}),
			);
		const query = (filter = "") =>
			fetch(`${origin}/api/v1/audit?limit=100${filter}`, {
				headers: { Authorization: `Bearer ${material.application}` },
			});
		for (const filter of ["", "&agentId=agent-a"]) {
			const response = await query(filter);
			expect(response.status).toBe(200);
			const page = (await response.json()) as { items: { auditId: string }[] };
			expect(page.items.map((item) => item.auditId)).toEqual([
				"owned-attempt-application",
			]);
		}
		expect((await govern("agent-a", false, "audit-manage-off")).status).toBe(
			200,
		);
		expect((await query("&agentId=agent-a")).status).toBe(200);
		const previous = await sql.begin((transaction) =>
			readCurrentTaskApplicationV1(transaction, {
				applicationId: "same-id",
				agentId: "agent-a",
			}),
		);
		expect(
			(await govern("agent-a", false, "audit-use-off", "session=owner", "use"))
				.status,
		).toBe(200);
		expect((await query("&agentId=agent-a")).status).toBe(404);
		const page = (await (await query()).json()) as { items: unknown[] };
		expect(page.items).toEqual([]);
		expect(
			(
				await govern(
					"agent-a",
					true,
					"audit-use-regrant",
					"session=owner",
					"use",
				)
			).status,
		).toBe(200);
		const current = await sql.begin((transaction) =>
			readCurrentTaskApplicationV1(transaction, {
				applicationId: "same-id",
				agentId: "agent-a",
			}),
		);
		expect(current?.useGrant?.authorizationRevision).not.toBe(
			previous?.useGrant?.authorizationRevision,
		);
		expect((await query("&agentId=agent-a")).status).toBe(200);
	});
	it("Owner use grants feed the original Task authority reader across two Agents and stay independent from manage", async () => {
		await sql`delete from platform.agent_principal_grants where principal_type='application'`;
		for (const agentId of ["agent-a", "agent-b"]) {
			expect(
				(await govern(agentId, true, "same-grant-key", "session=owner", "use"))
					.status,
			).toBe(200);
			const authority = await sql.begin((transaction) =>
				readCurrentTaskApplicationV1(transaction, {
					applicationId: "same-id",
					agentId,
				}),
			);
			expect(authority?.useGrant).toMatchObject({
				principal: { kind: "application", id: "same-id" },
				agentId,
				grantType: "use",
				revoked: false,
			});
			expect((await request(agentId)).status).toBe(404);
			expect((await govern(agentId, true, "same-grant-key")).status).toBe(200);
			expect((await request(agentId)).status).toBe(202);
		}
		const [manage] =
			await sql`select authorization_revision from platform.agent_principal_grants where principal_type='application' and agent_id='agent-a' and grant_type='manage'`;
		expect(
			(await govern("agent-a", false, "revoke-use", "session=owner", "use"))
				.status,
		).toBe(200);
		const revoked = await sql.begin((transaction) =>
			readCurrentTaskApplicationV1(transaction, {
				applicationId: "same-id",
				agentId: "agent-a",
			}),
		);
		expect(revoked?.useGrant?.revoked).toBe(true);
		expect((await request("agent-a", "stop", "still-manage")).status).toBe(202);
		const [after] =
			await sql`select authorization_revision from platform.agent_principal_grants where principal_type='application' and agent_id='agent-a' and grant_type='manage'`;
		expect(after).toEqual(manage);
		const replay = await govern(
			"agent-a",
			true,
			"same-grant-key",
			"session=owner",
			"use",
		);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({
			granted: false,
			replayed: true,
		});
		const other = await sql.begin((transaction) =>
			readCurrentTaskApplicationV1(transaction, {
				applicationId: "same-id",
				agentId: "agent-b",
			}),
		);
		expect(other?.useGrant?.revoked).toBe(false);
	});
	it.each(["session=responsible", "session=administrator"])(
		"%s cannot grant application use without current Agent Ownership",
		async (cookie) => {
			expect(
				(await govern("agent-a", true, "denied-use", cookie, "use")).status,
			).toBe(404);
		},
	);
	it("an application Token cannot govern its own use grant", async () => {
		const response = await fetch(
			`${origin}/api/v2/agents/agent-a/application-use-grants/same-id`,
			{
				method: "DELETE",
				headers: {
					Authorization: `Bearer ${material.application}`,
					"Content-Type": "application/json",
					"Idempotency-Key": "self-revoke",
				},
				body: JSON.stringify({ schemaVersion: 1 }),
			},
		);
		expect(response.status).toBe(401);
		const authority = await sql.begin((transaction) =>
			readCurrentTaskApplicationV1(transaction, {
				applicationId: "same-id",
				agentId: "agent-a",
			}),
		);
		expect(authority?.useGrant?.revoked).toBe(false);
	});
	it("use governance audit failure rolls back just the attempted use change", async () => {
		await sql.unsafe(
			`create function platform.lifecycle_fault() returns trigger language plpgsql as $$ begin if NEW.action='api.agent.use.revoked' then raise exception 'controlled-use-audit-failure'; end if; return NEW; end $$`,
		);
		await sql.unsafe(
			"create trigger lifecycle_fault before insert on platform.audit_events for each row execute function platform.lifecycle_fault()",
		);
		expect(
			(await govern("agent-a", false, "use-failure", "session=owner", "use"))
				.status,
		).toBe(503);
		const authority = await sql.begin((transaction) =>
			readCurrentTaskApplicationV1(transaction, {
				applicationId: "same-id",
				agentId: "agent-a",
			}),
		);
		expect(authority?.useGrant?.revoked).toBe(false);
		expect((await request()).status).toBe(202);
	});
	it("the production governance path explicitly grants and revokes application manage across two Agents", async () => {
		await sql`delete from platform.agent_principal_grants where principal_type='application' and grant_type='manage'`;
		for (const id of ["agent-a", "agent-b"]) {
			expect((await request(id)).status).toBe(404);
			expect((await govern(id, true, `grant-${id}`)).status).toBe(200);
			expect((await request(id)).status).toBe(202);
		}
		expect((await govern("agent-a", false, "revoke-a")).status).toBe(200);
		expect((await request("agent-a", "stop", "stop-a")).status).toBe(404);
		expect((await request("agent-b", "stop", "stop-b")).status).toBe(202);
		const [grant] =
			await sql`select revoked_at from platform.agent_principal_grants where agent_id='agent-a' and principal_type='application' and grant_type='use'`;
		expect(grant?.revoked_at).toBeNull();
	});
	it.each(["session=responsible", "session=administrator"])(
		"%s does not inherit Agent Owner governance",
		async (cookie) => {
			expect(
				(await govern("agent-a", false, "revoke-denied", cookie)).status,
			).toBe(404);
			expect((await request()).status).toBe(202);
		},
	);
	it("an old grant replay cannot restore manage authority after a later revocation", async () => {
		expect((await govern("agent-a", true, "grant-key")).status).toBe(200);
		expect((await govern("agent-a", false, "revoke-key")).status).toBe(200);
		const replay = await govern("agent-a", true, "grant-key");
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({
			granted: false,
			replayed: true,
		});
		expect((await request()).status).toBe(404);
	});
	it("governance audit failure rolls back a grant without touching the use grant", async () => {
		await sql`delete from platform.agent_principal_grants where agent_id='agent-a' and principal_type='application' and grant_type='manage'`;
		await sql.unsafe(
			`create function platform.lifecycle_fault() returns trigger language plpgsql as $$ begin if NEW.action='api.agent.manager.granted' then raise exception 'controlled-governance-audit-failure'; end if; return NEW; end $$`,
		);
		await sql.unsafe(
			"create trigger lifecycle_fault before insert on platform.audit_events for each row execute function platform.lifecycle_fault()",
		);
		expect((await govern("agent-a", true, "grant-failure")).status).toBe(503);
		expect((await request()).status).toBe(404);
		const grants =
			await sql`select grant_type,revoked_at from platform.agent_principal_grants where agent_id='agent-a' and principal_type='application'`;
		expect(grants).toEqual([{ grant_type: "use", revoked_at: null }]);
	});
	it("final Owner loss in the same transaction rolls back the governance write", async () => {
		await sql`delete from platform.agent_principal_grants where agent_id='agent-a' and principal_type='application' and grant_type='manage'`;
		await sql.unsafe(
			`create function platform.lifecycle_fault() returns trigger language plpgsql as $$ begin if NEW.action='api.agent.manager.granted' then update platform.agent_owners set owner_id='human-responsible' where agent_id='agent-a'; end if; return NEW; end $$`,
		);
		await sql.unsafe(
			"create trigger lifecycle_fault before insert on platform.audit_events for each row execute function platform.lifecycle_fault()",
		);
		expect((await govern("agent-a", true, "grant-owner-race")).status).toBe(
			404,
		);
		expect((await request()).status).toBe(404);
		const [owner] =
			await sql`select owner_id from platform.agent_owners where agent_id='agent-a'`;
		expect(owner?.owner_id).toBe("same-id");
	});

	it("one application Token manages multiple explicitly granted Agents without a personal identity lookup", async () => {
		for (const agentId of ["agent-a", "agent-b"]) {
			const response = await request(agentId);
			expect(response.status).toBe(202);
			expect(await response.json()).toMatchObject({
				agentId,
				status: "available",
				revision: 3,
			});
		}
		expect(resolveUser).not.toHaveBeenCalled();
		const rows =
			await sql`select actor_type,actor_id,action from platform.audit_events order by agent_id`;
		expect(rows).toEqual([
			{
				actor_type: "application",
				actor_id: "same-id",
				action: "agent.lifecycle.restarted",
			},
			{
				actor_type: "application",
				actor_id: "same-id",
				action: "agent.lifecycle.restarted",
			},
		]);
		expect((await effects()).outbox).toBe(2);
		expect(JSON.stringify(rows)).not.toContain(material.application);
	});
	it("does not inherit the human Owner's access even when the application has the same textual ID", async () => {
		expect((await request("agent-foreign")).status).toBe(404);
		expect((await effects()).outbox).toBe(0);
	});
	it("preserves personal Token support and separates same-ID user/application idempotency", async () => {
		expect((await request()).status).toBe(202);
		expect(
			(await request("agent-a", "restart", "same-key", material.user)).status,
		).toBe(202);
		const rows =
			await sql`select actor_type,actor_id from platform.audit_events order by occurred_at`;
		expect(rows).toEqual([
			{ actor_type: "application", actor_id: "same-id" },
			{ actor_type: "user", actor_id: "same-id" },
		]);
		expect((await effects()).idempotency).toBe(2);
	});
	it("replays under a replacement Token for the same subject without repeating lifecycle effects", async () => {
		expect((await request()).status).toBe(202);
		await sql`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id='app-credential'`;
		await credential("application", material.replacement);
		expect((await request()).status).toBe(401);
		const replay = await request(
			"agent-a",
			"start",
			"same-key",
			material.replacement,
		);
		expect(replay.status).toBe(202);
		expect(await replay.json()).toMatchObject({ replayed: true, revision: 3 });
		expect(await effects()).toMatchObject({
			outbox: 1,
			history: 1,
			idempotency: 1,
		});
	});
	it("rechecks current manage authorization before returning a cached result", async () => {
		expect((await request()).status).toBe(202);
		await sql`update platform.agent_principal_grants set revoked_at=clock_timestamp() where agent_id='agent-a' and principal_type='application' and grant_type='manage'`;
		expect((await request()).status).toBe(404);
		expect((await effects()).outbox).toBe(1);
	});
	it("keeps use and manage grants independent", async () => {
		await sql`update platform.agent_principal_grants set revoked_at=clock_timestamp() where principal_type='application' and grant_type='use'`;
		expect((await request()).status).toBe(202);
		expect((await request("agent-a", "stop", "stop-1")).status).toBe(202);
		const [grant] =
			await sql`select revoked_at from platform.agent_principal_grants where agent_id='agent-a' and principal_type='application' and grant_type='use'`;
		expect(grant?.revoked_at).not.toBeNull();
	});
	it.each(["scope", "expiry", "revoked", "disabled"])(
		"rejects current %s failure before writing a lifecycle command",
		async (failure) => {
			if (failure === "scope")
				await sql`update platform.platform_api_credentials set scopes='["agent:use"]'::jsonb where id='app-credential'`;
			if (failure === "expiry")
				await sql`update platform.platform_api_credentials set expires_at=clock_timestamp()-interval '1 second' where id='app-credential'`;
			if (failure === "revoked")
				await sql`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id='app-credential'`;
			if (failure === "disabled")
				await sql`update platform.platform_applications set status='disabled',authorization_revision='app-2' where id='same-id'`;
			expect((await request()).status).toBe(
				["expiry", "revoked"].includes(failure) ? 401 : 403,
			);
			expect(await effects()).toMatchObject({
				state: { status: "stopped", management_revision: "2" },
				outbox: 0,
				history: 0,
				idempotency: 0,
			});
		},
	);
	it("cannot restore an administrator-disabled Agent", async () => {
		await sql`update platform.agent_applications set status='disabled' where agent_id='agent-a'`;
		expect((await request()).status).toBe(409);
		const [audit] =
			await sql`select actor_type,actor_id,target_type,target_id,details from platform.audit_events where action='api.agent.lifecycle.refused'`;
		expect(audit).toEqual({
			actor_type: "application",
			actor_id: "same-id",
			target_type: "agent",
			target_id: "agent-a",
			details: { reason: "conflict", command: "start" },
		});
		expect((await effects()).outbox).toBe(0);
	});
	it("same key with a different command conflicts without a second outbox item", async () => {
		expect((await request()).status).toBe(202);
		expect((await request("agent-a", "stop")).status).toBe(409);
		expect((await effects()).outbox).toBe(1);
	});
	it("rolls back state, history, outbox and idempotency when the necessary audit fails", async () => {
		await sql.unsafe(
			`create function platform.lifecycle_fault() returns trigger language plpgsql as $$ begin if NEW.action='agent.lifecycle.restarted' then raise exception 'controlled-audit-failure'; end if; return NEW; end $$`,
		);
		await sql.unsafe(
			"create trigger lifecycle_fault before insert on platform.audit_events for each row execute function platform.lifecycle_fault()",
		);
		const response = await request();
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("controlled-audit-failure");
		expect(await effects()).toMatchObject({
			state: { status: "stopped", management_revision: "2" },
			outbox: 0,
			history: 0,
			idempotency: 0,
		});
	});
	it("final credential expiration after the write rolls back the complete transaction", async () => {
		await sql.unsafe(
			`create function platform.lifecycle_fault() returns trigger language plpgsql as $$ begin if NEW.action='agent.lifecycle.restarted' then update platform.platform_api_credentials set expires_at=clock_timestamp()-interval '1 second' where id='app-credential'; end if; return NEW; end $$`,
		);
		await sql.unsafe(
			"create trigger lifecycle_fault before insert on platform.audit_events for each row execute function platform.lifecycle_fault()",
		);
		expect((await request()).status).toBe(401);
		expect(await effects()).toMatchObject({
			state: { status: "stopped", management_revision: "2" },
			outbox: 0,
			history: 0,
			idempotency: 0,
		});
		const [record] =
			await sql`select expires_at from platform.platform_api_credentials where id='app-credential'`;
		expect(record?.expires_at).toBeNull();
	});
	it("final current user revision drift rolls back accepted effects", async () => {
		resolveUser
			.mockResolvedValueOnce(user())
			.mockResolvedValueOnce(user("user-2"));
		expect(
			(await request("agent-a", "start", "same-key", material.user)).status,
		).toBe(503);
		expect(await effects()).toMatchObject({
			outbox: 0,
			history: 0,
			idempotency: 0,
		});
	});
});
