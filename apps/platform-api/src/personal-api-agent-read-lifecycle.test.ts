import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
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
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import {
	getAgentV2,
	getPersonalApiIdentityV2,
	issuePersonalApiCredentialV2,
	listAdminAgentsV2,
	listAgentsV2,
	narrowPersonalApiCredentialV2,
	revokePersonalApiCredentialV2,
} from "../../web/src/pilot/generated-v2/sdk.gen.ts";
import type { IssuePersonalApiCredentialV2Data } from "../../web/src/pilot/generated-v2/types.gen.ts";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "./index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const moduleSpecifier = new URL(
	"../../../tests/fixtures/personal-agent-read-deployment.ts",
	import.meta.url,
).href;
const deployment: typeof import("../../../tests/fixtures/personal-agent-read-deployment.ts") =
	await import(moduleSpecifier);
let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
const shutdowns: (() => Promise<void>)[] = [];
const logs: string[] = [];

async function start(otlpEndpoint?: string) {
	const output = new PassThrough();
	output.on("data", (chunk) => logs.push(String(chunk)));
	const running = await startPlatformApiFromDeployment({
		moduleSpecifier,
		port: 0,
		log: (line) => logs.push(line),
		observabilityOptions: { output, otlpEndpoint },
	});
	const shutdown = createPlatformApiShutdown(running);
	shutdowns.push(shutdown);
	const address = running.server.address();
	if (!address || typeof address === "string")
		throw new Error("API did not bind");
	const requests: Request[] = [];
	const options = {
		baseUrl: `http://127.0.0.1:${address.port}`,
		fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push(request);
			return fetch(request);
		},
	};
	return { options, requests, shutdown };
}

async function issue(
	service: Awaited<ReturnType<typeof start>>,
	key = "read.issue",
	auth = "session_alice",
	scopes: IssuePersonalApiCredentialV2Data["body"]["scopes"] = ["agent:read"],
) {
	const issued = await issuePersonalApiCredentialV2({
		...service.options,
		auth,
		body: { scopes, expiresAt: null },
		headers: { "Idempotency-Key": key },
	});
	expect(issued.response?.status).toBe(201);
	if (!issued.data?.credential) throw new Error("No actual issued credential");
	return { ...issued.data, credential: issued.data.credential };
}

async function seedAgent(agentId: string) {
	const record = {
		...structuredClone(agentConfigurationConformanceRecordV1),
		agentId,
	};
	await client`insert into platform.agents(id,current_configuration_revision)
		values (${agentId},${record.revision})`;
	await client`insert into platform.agent_applications
		(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,
		management_revision,approval_revision,service_availability,desired_state,workload_revision,fence)
		values (${`application_${agentId}`},${agentId},'user_alice','Agent','Description',
		'available','trace_seed','request_seed',clock_timestamp(),1,1,'ready','running',1,1)`;
	await client`insert into platform.agent_configuration_revisions
		(agent_id,revision,source_reference,configuration,created_at)
		values (${agentId},${record.revision},${record.source.kind === "standard" ? record.source.templateId : record.source.imageDigest},${client.json(record as never)},clock_timestamp())`;
	await client`insert into platform.agent_owners(agent_id,owner_id,created_at) values (${agentId},'user_alice',clock_timestamp())`;
	await client`insert into platform.agent_availability(agent_id,target_type,target_id)
		values (${agentId},'organization','org_1')`;
}

async function grant(
	agentId: string,
	kind: "manage" | "use",
	userId = "user_alice",
) {
	await client`insert into platform.agent_principal_grants
		(agent_id,principal_type,principal_id,grant_type,authorization_revision)
		values (${agentId},'user',${userId},${kind},'grant_1')`;
}

async function removeAuditFailure() {
	await client`drop trigger if exists fail_agent_read_http_audit on platform.audit_events`;
	await client`drop function if exists platform.fail_agent_read_http_audit()`;
}

async function armAuditFailure(deferred: boolean) {
	await client`create function platform.fail_agent_read_http_audit() returns trigger language plpgsql as $$
		begin if new.action in ('api.agent.metadata.read','api.credential.identity.read') then raise exception 'PRIVATE_SQL_SENTINEL'; end if; return new; end $$`;
	await client.unsafe(
		deferred
			? "create constraint trigger fail_agent_read_http_audit after insert on platform.audit_events deferrable initially deferred for each row execute function platform.fail_agent_read_http_audit()"
			: "create trigger fail_agent_read_http_audit before insert on platform.audit_events for each row execute function platform.fail_agent_read_http_audit()",
	);
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("personal-agent-read-http");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 1 });
	deployment.state.databaseUrl = database.databaseUrl;
});
beforeEach(async () => {
	deployment.state.directoryMode = "active";
	deployment.state.directoryCalls = 0;
	logs.length = 0;
	vi.spyOn(console, "error").mockImplementation((...args) =>
		logs.push(JSON.stringify(args)),
	);
	await client`truncate platform.platform_api_credentials,platform.platform_user_disables,
		platform.idempotency_records,platform.audit_events,platform.agents cascade`;
	await seedAgent("agent_1");
});
afterEach(async () => {
	await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
	await removeAuditFailure();
	vi.restoreAllMocks();
});
afterAll(async () => {
	await client?.end();
	await database?.stop();
});

describe("formal deployment issued Bearer Agent reads over real PostgreSQL and generated SDK", () => {
	it("keeps stable identity across credentials, narrows current limits and selects Bearer without cookies", async () => {
		const service = await start();
		const first = await issue(service, "first", "session_alice", [
			"agent:read",
			"agent:use",
		]);
		const second = await issue(service, "second");
		const bob = await issue(service, "bob", "session_bob");
		const read = (auth: string) =>
			getPersonalApiIdentityV2({
				...service.options,
				auth,
				credentials: "include",
			});
		const before = await read(first.credential);
		expect(before.response?.status).toBe(200);
		expect(service.requests.at(-1)?.credentials).toBe("omit");
		expect(service.requests.at(-1)?.headers.has("Cookie")).toBe(false);
		expect((await read(second.credential)).data?.principal).toEqual(
			before.data?.principal,
		);
		expect((await read(second.credential)).data?.credentialId).not.toBe(
			before.data?.credentialId,
		);
		expect((await read(bob.credential)).data?.principal).toEqual({
			kind: "user",
			id: "user_bob",
		});
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		const narrowed = await narrowPersonalApiCredentialV2({
			...service.options,
			auth: "session_alice",
			path: { credentialId: first.metadata.credentialId },
			body: { scopes: ["agent:use"], expiresAt },
			headers: { "Idempotency-Key": "narrow.identity" },
		});
		expect(narrowed.response?.status).toBe(200);
		expect((await read(first.credential)).data).toMatchObject({
			scopes: ["agent:use"],
			expiresAt,
		});
		await grant("agent_1", "use");
		expect(
			(
				await getAgentV2({
					...service.options,
					auth: first.credential,
					path: { agentId: "agent_1" },
				})
			).response?.status,
		).toBe(403);
		const allowed = await getAgentV2({
			...service.options,
			auth: second.credential,
			credentials: "include",
			path: { agentId: "agent_1" },
		});
		expect(allowed.response?.status).toBe(200);
		expect(service.requests.at(-1)?.credentials).toBe("omit");
		expect(service.requests.at(-1)?.headers.has("Cookie")).toBe(false);
	});

	it.each(["manage", "use", "both", "neither"] as const)(
		"single Agent honors independent %s grants without Owner or administrator bypass",
		async (kind) => {
			const service = await start();
			const alice = await issue(service);
			const admin = await issue(service, "admin", "session_admin");
			const bob = await issue(service, "bob", "session_bob");
			if (kind === "manage" || kind === "both")
				await grant("agent_1", "manage");
			if (kind === "use" || kind === "both") await grant("agent_1", "use");
			const read = (auth = alice.credential, agentId = "agent_1") =>
				getAgentV2({ ...service.options, auth, path: { agentId } });
			expect((await read()).response?.status).toBe(
				kind === "neither" ? 404 : 200,
			);
			for (const auth of [admin.credential, bob.credential]) {
				const denied = await read(auth);
				const missing = await read(auth, "missing_agent");
				expect(denied.response?.status).toBe(404);
				expect(missing.response?.status).toBe(404);
				expect(denied.error?.code).toBe(missing.error?.code);
			}
			await client`update platform.agent_principal_grants set revoked_at=clock_timestamp() where grant_type='manage'`;
			expect((await read()).response?.status).toBe(
				kind === "use" || kind === "both" ? 200 : 404,
			);
			await client`update platform.agent_principal_grants set revoked_at=clock_timestamp() where grant_type='use'`;
			expect((await read()).response?.status).toBe(404);
			const browser = await getAgentV2({
				...service.options,
				path: { agentId: "agent_1" },
				security: [
					{ type: "apiKey", in: "cookie", name: "__Host-platform-session" },
				],
				auth: "session_alice",
			});
			expect(browser.response?.status).toBe(200);
		},
	);

	it.each(["revoked", "expired", "disabled", "application"] as const)(
		"rejects %s credentials at both new reads",
		async (condition) => {
			const service = await start();
			const issued = await issue(service);
			await grant("agent_1", "use");
			if (condition === "revoked")
				await revokePersonalApiCredentialV2({
					...service.options,
					auth: "session_alice",
					path: { credentialId: issued.metadata.credentialId },
					headers: { "Idempotency-Key": "revoke.new" },
				});
			if (condition === "expired")
				await client`update platform.platform_api_credentials set expires_at=clock_timestamp() where id=${issued.metadata.credentialId}`;
			if (condition === "disabled")
				await client`insert into platform.platform_user_disables(user_id) values ('user_alice')`;
			if (condition === "application")
				await client`update platform.platform_api_credentials set principal_type='application' where id=${issued.metadata.credentialId}`;
			for (const path of [
				"/api/v2/me/api-identity",
				"/api/v2/agents/agent_1",
			]) {
				const response = await fetch(service.options.baseUrl + path, {
					headers: { Authorization: `Bearer ${issued.credential}` },
				});
				expect(response.status).toBe(condition === "disabled" ? 403 : 401);
			}
		},
	);

	it.each([
		"disabled",
		"missing",
		"mismatched",
		"malformed",
		"error",
		"revision_changed",
		"finally_disabled",
	] as const)("both new reads recheck directory %s", async (mode) => {
		const service = await start();
		const issued = await issue(service);
		await grant("agent_1", "use");
		deployment.state.directoryMode = mode;
		for (const path of ["/api/v2/me/api-identity", "/api/v2/agents/agent_1"]) {
			deployment.state.directoryCalls = 0;
			const response = await fetch(service.options.baseUrl + path, {
				headers: { Authorization: `Bearer ${issued.credential}` },
			});
			expect(response.status).toBe(
				["disabled", "missing", "finally_disabled"].includes(mode) ? 403 : 503,
			);
			expect(await response.text()).not.toContain("PRIVATE_DIRECTORY_SENTINEL");
		}
	});

	it.each([false, true])(
		"both new reads withhold success on audit failure deferred=%s",
		async (deferred) => {
			const service = await start();
			const issued = await issue(service);
			await grant("agent_1", "use");
			await armAuditFailure(deferred);
			for (const path of [
				"/api/v2/me/api-identity",
				"/api/v2/agents/agent_1",
			]) {
				const response = await fetch(service.options.baseUrl + path, {
					headers: { Authorization: `Bearer ${issued.credential}` },
				});
				expect(response.status).toBe(503);
				expect(await response.text()).not.toContain("PRIVATE_SQL_SENTINEL");
			}
			await removeAuditFailure();
			expect(
				(
					await getPersonalApiIdentityV2({
						...service.options,
						auth: issued.credential,
					})
				).response?.status,
			).toBe(200);
		},
	);

	it.each([
		"missing",
		"cookie",
		"mixed",
		"basic",
		"duplicate",
		"unknown",
		"query",
		"header",
	] as const)("both new reads reject %s identity input", async (kind) => {
		const service = await start();
		const issued = await issue(service);
		await grant("agent_1", "use");
		const headers = new Headers();
		if (kind !== "missing" && kind !== "cookie")
			headers.set(
				"Authorization",
				kind === "basic"
					? `Basic ${issued.credential}`
					: kind === "duplicate"
						? `Bearer ${issued.credential}, Bearer ${issued.credential}`
						: kind === "unknown"
							? `Bearer papi_${"u".repeat(43)}`
							: `Bearer ${issued.credential}`,
			);
		if (kind === "cookie" || kind === "mixed")
			headers.set("Cookie", "__Host-platform-session=session_admin");
		if (kind === "header") headers.set("X-User-Id", "user_admin");
		for (const path of ["/api/v2/me/api-identity", "/api/v2/agents/agent_1"]) {
			if (kind === "cookie" && path.includes("/agents/")) continue; // Existing browser route is deliberately supported.
			const response = await fetch(
				service.options.baseUrl +
					path +
					(kind === "query" ? "?scope=owner" : ""),
				{ headers },
			);
			expect(response.status).toBe(
				kind === "query" || kind === "header" ? 400 : 401,
			);
			expect(await response.text()).not.toContain(issued.credential);
		}
	});

	it("reads a granted single Agent with the same metadata as the Bearer list", async () => {
		const service = await start();
		const issued = await issue(service);
		await grant("agent_1", "use");
		const response = await fetch(
			`${service.options.baseUrl}/api/v2/agents/agent_1`,
			{
				headers: { Authorization: `Bearer ${issued.credential}` },
			},
		);
		expect(response.status).toBe(200);
		const list = await listAgentsV2({
			...service.options,
			auth: issued.credential,
		});
		expect(await response.json()).toEqual(list.data?.items[0]);
	});

	it("identifies the current personal credential without Agent grants or read scope", async () => {
		const service = await start();
		const issued = await issue(service, "identity.issue", "session_alice", [
			"agent:use",
		]);
		const response = await fetch(
			`${service.options.baseUrl}/api/v2/me/api-identity`,
			{
				headers: { Authorization: `Bearer ${issued.credential}` },
			},
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			principal: { kind: "user", id: "user_alice" },
			credentialId: issued.metadata.credentialId,
			scopes: ["agent:use"],
			expiresAt: null,
		});
	});

	it("issues, reads, restarts, revokes the same actual material and exports redacted correlated traces", async () => {
		const exports: Buffer[] = [];
		const collector = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			if (request.url === "/v1/traces") exports.push(Buffer.concat(chunks));
			response.writeHead(200);
			response.end();
		});
		await new Promise<void>((resolve, reject) => {
			collector.once("error", reject);
			collector.listen(0, "127.0.0.1", resolve);
		});
		try {
			const address = collector.address();
			if (!address || typeof address === "string")
				throw new Error("Collector did not bind");
			const endpoint = `http://127.0.0.1:${address.port}`;
			const firstServer = await start(endpoint);
			await grant("agent_1", "use");
			const issued = await issue(firstServer);
			const material = issued.credential;
			const hash = createHash("sha256").update(material).digest("hex");
			const [stored] =
				await client`select credential_hash from platform.platform_api_credentials
				where id=${issued.metadata.credentialId}`;
			expect(stored?.credential_hash).toBe(hash);
			const read = await listAgentsV2({
				...firstServer.options,
				auth: material,
				credentials: "include",
				headers: { "X-Request-Id": hash },
			});
			expect(read.response?.status).toBe(200);
			expect(read.data?.items.map((agent) => agent.agentId)).toEqual([
				"agent_1",
			]);
			const sent = firstServer.requests.at(-1);
			expect(sent?.headers.get("Authorization")).toBe(`Bearer ${material}`);
			expect(sent?.headers.has("Cookie")).toBe(false);
			expect(sent?.credentials).toBe("omit");
			const identity = await getPersonalApiIdentityV2({
				...firstServer.options,
				auth: material,
			});
			expect(identity.response?.status).toBe(200);
			const single = await getAgentV2({
				...firstServer.options,
				auth: material,
				path: { agentId: "agent_1" },
			});
			expect(single.response?.status).toBe(200);
			await firstServer.shutdown();
			const secondServer = await start(endpoint);
			expect(
				(await listAgentsV2({ ...secondServer.options, auth: material }))
					.response?.status,
			).toBe(200);
			const revoked = await revokePersonalApiCredentialV2({
				...secondServer.options,
				auth: "session_alice",
				path: { credentialId: issued.metadata.credentialId },
				headers: { "Idempotency-Key": "read.revoke" },
			});
			expect(revoked.response?.status).toBe(200);
			const denied = await listAgentsV2({
				...secondServer.options,
				auth: material,
			});
			expect(denied.response?.status).toBe(401);
			await secondServer.shutdown();
			const audits =
				await client`select * from platform.audit_events where action in ('api.agent.metadata.read','api.credential.identity.read') order by occurred_at`;
			expect(audits.map((audit) => audit.outcome)).toEqual([
				"succeeded",
				"succeeded",
				"succeeded",
				"succeeded",
				"rejected",
			]);
			for (const audit of audits) {
				expect(audit.actor_id).toBe("user_alice");
				expect(audit.target_id).toBe(issued.metadata.credentialId);
			}
			expect(exports.length).toBeGreaterThan(0);
			const traces = exports.map((body) => body.toString()).join("\n");
			for (const audit of audits) {
				expect(traces).toContain(audit.request_id);
				expect(traces).toContain(audit.trace_id);
			}
			const persisted =
				await client`select * from platform.idempotency_records`;
			const observable = JSON.stringify({
				audits,
				logs,
				traces,
				persisted,
				read: read.data,
				identity: identity.data,
				single: single.data,
				revoked: revoked.data,
				denied: denied.error,
			});
			for (const secret of [material, hash])
				expect(observable).not.toContain(secret);
		} finally {
			await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
			await new Promise<void>((resolve) => collector.close(() => resolve()));
		}
	});

	it.each(["manage", "use", "both", "neither"] as const)(
		"intersects the issued credential with explicit %s grants and each independent revocation",
		async (kind) => {
			const service = await start();
			const issued = await issue(service);
			if (kind === "manage" || kind === "both")
				await grant("agent_1", "manage");
			if (kind === "use" || kind === "both") await grant("agent_1", "use");
			const read = () =>
				listAgentsV2({ ...service.options, auth: issued.credential });
			expect((await read()).data?.items).toHaveLength(
				kind === "neither" ? 0 : 1,
			);
			await client`update platform.agent_principal_grants set revoked_at=clock_timestamp() where grant_type='manage'`;
			expect((await read()).data?.items).toHaveLength(
				kind === "use" || kind === "both" ? 1 : 0,
			);
			await client`update platform.agent_principal_grants set revoked_at=clock_timestamp() where grant_type='use'`;
			expect((await read()).data?.items).toHaveLength(0);
			const audits =
				await client`select details from platform.audit_events where action='api.agent.metadata.read'`;
			expect(audits).toHaveLength(3);
			for (const audit of audits)
				expect(audit.details.grantFilter).toBe("manage_or_use");
		},
	);

	it("presents an API-only user grant without borrowing Browser visibility, then hides a revoked grant", async () => {
		await client`delete from platform.agent_availability where agent_id='agent_1'`;
		await grant("agent_1", "use", "user_bob");
		const service = await start();
		const bob = await issue(service, "api-only.issue", "session_bob");
		const browser = await listAgentsV2({
			...service.options,
			auth: () => "session_bob",
			security: [
				{ type: "apiKey", in: "cookie", name: "__Host-platform-session" },
			],
		});
		expect(browser.response?.status).toBe(200);
		expect(browser.data?.items).toEqual([]);
		const allowed = await listAgentsV2({
			...service.options,
			auth: bob.credential,
		});
		expect(allowed.response?.status).toBe(200);
		expect(allowed.data?.items.map((agent) => agent.agentId)).toEqual([
			"agent_1",
		]);
		await client`update platform.agent_principal_grants set revoked_at=clock_timestamp() where agent_id='agent_1' and principal_type='user' and principal_id='user_bob'`;
		const revoked = await listAgentsV2({
			...service.options,
			auth: bob.credential,
		});
		expect(revoked.response?.status).toBe(200);
		expect(revoked.data?.items).toEqual([]);
	});

	it.each(["manage", "use"] as const)(
		"presents a stopped API-created Agent for an explicit %s grant",
		async (kind) => {
			await client`update platform.agent_applications set creation_channel='api',
				creator_principal_type='user',creator_principal_id='user_alice',
				approval_revision=null,status='stopped',service_availability=null,
				desired_state='stopped' where agent_id='agent_1'`;
			await client`delete from platform.agent_availability where agent_id='agent_1'`;
			const service = await start();
			const issued = await issue(service, "api-created.issue", "session_bob");
			const read = () =>
				listAgentsV2({ ...service.options, auth: issued.credential });
			expect((await read()).data?.items).toEqual([]);
			await grant("agent_1", kind, "user_bob");
			const allowed = await read();
			expect(allowed.response?.status).toBe(200);
			expect(allowed.data?.items.map((agent) => agent.agentId)).toEqual([
				"agent_1",
			]);
			expect(service.requests.at(-1)?.headers.has("Cookie")).toBe(false);
			await client`update platform.agent_principal_grants set revoked_at=clock_timestamp()
				where agent_id='agent_1' and principal_id='user_bob'`;
			expect((await read()).data?.items).toEqual([]);
		},
	);

	it("rejects an unapproved Web Agent at the persistence boundary", async () => {
		await expect(client`update platform.agent_applications set approval_revision=null,
			status='stopped',service_availability=null,desired_state='stopped'
			where agent_id='agent_1'`).rejects.toMatchObject({
			code: "23514",
			constraint_name: "agent_application_management_state_valid",
		});
	});

	it("filters before paging, isolates users, and preserves browser Owner and administrator discovery", async () => {
		await seedAgent("agent_2");
		await seedAgent("agent_3");
		await grant("agent_2", "use");
		await grant("agent_3", "manage");
		await grant("agent_1", "use", "user_bob");
		const service = await start();
		const alice = await issue(service);
		const bob = await issue(service, "bob.issue", "session_bob");
		const admin = await issue(service, "admin.issue", "session_admin");
		const first = await listAgentsV2({
			...service.options,
			auth: alice.credential,
			query: { limit: 1 },
		});
		expect(first.data?.items.map((agent) => agent.agentId)).toEqual([
			"agent_2",
		]);
		const second = await listAgentsV2({
			...service.options,
			auth: alice.credential,
			query: { limit: 1, cursor: first.data?.nextCursor ?? undefined },
		});
		expect(second.data?.items.map((agent) => agent.agentId)).toEqual([
			"agent_3",
		]);
		expect(
			(
				await listAgentsV2({ ...service.options, auth: bob.credential })
			).data?.items.map((agent) => agent.agentId),
		).toEqual(["agent_1"]);
		expect(
			(await listAgentsV2({ ...service.options, auth: admin.credential })).data
				?.items,
		).toHaveLength(0);
		const cookie = () => "session_alice";
		const browser = await listAgentsV2({
			...service.options,
			auth: cookie,
			security: [
				{ type: "apiKey", in: "cookie", name: "__Host-platform-session" },
			],
		});
		expect(browser.data?.items).toHaveLength(3);
		const owner = await listAgentsV2({
			...service.options,
			auth: cookie,
			security: [
				{ type: "apiKey", in: "cookie", name: "__Host-platform-session" },
			],
			query: { scope: "owner" },
		});
		expect(owner.data?.items).toHaveLength(3);
		expect(
			(
				await listAdminAgentsV2({
					...service.options,
					headers: { Cookie: "__Host-platform-session=session_admin" },
				})
			).data?.items,
		).toHaveLength(3);
	});

	it.each(["revoked", "expired", "scope", "manual-disable"] as const)(
		"rejects the actually used %s credential despite another valid credential",
		async (condition) => {
			await grant("agent_1", "use");
			const service = await start();
			const used = await issue(
				service,
				"used.issue",
				"session_alice",
				condition === "scope" ? ["agent:use"] : ["agent:read"],
			);
			const alternate = await issue(service, "alternate.issue");
			if (condition === "revoked")
				await revokePersonalApiCredentialV2({
					...service.options,
					auth: "session_alice",
					path: { credentialId: used.metadata.credentialId },
					headers: { "Idempotency-Key": "used.revoke" },
				});
			if (condition === "expired")
				await client`update platform.platform_api_credentials set expires_at=clock_timestamp() where id=${used.metadata.credentialId}`;
			if (condition === "manual-disable")
				await client`insert into platform.platform_user_disables(user_id) values ('user_alice')`;
			const denied = await listAgentsV2({
				...service.options,
				auth: used.credential,
			});
			expect(denied.response?.status).toBe(
				condition === "revoked" || condition === "expired" ? 401 : 403,
			);
			if (condition !== "manual-disable")
				expect(
					(
						await listAgentsV2({
							...service.options,
							auth: alternate.credential,
						})
					).response?.status,
				).toBe(200);
			const [row] =
				await client`select last_used_at from platform.platform_api_credentials where id=${used.metadata.credentialId}`;
			expect(row?.last_used_at).toBeNull();
		},
	);

	it.each([
		"disabled",
		"missing",
		"mismatched",
		"malformed",
		"error",
		"revision_changed",
		"finally_disabled",
	] as const)(
		"checks current directory %s for the actual issued credential",
		async (mode) => {
			await grant("agent_1", "use");
			const service = await start();
			const issued = await issue(service);
			deployment.state.directoryMode = mode;
			deployment.state.directoryCalls = 0;
			const denied = await listAgentsV2({
				...service.options,
				auth: issued.credential,
			});
			expect(denied.response?.status).toBe(
				mode === "disabled" || mode === "missing" || mode === "finally_disabled"
					? 403
					: 503,
			);
			expect(JSON.stringify({ error: denied.error, logs })).not.toContain(
				"PRIVATE_DIRECTORY_SENTINEL",
			);
			const [row] =
				await client`select last_used_at from platform.platform_api_credentials where id=${issued.metadata.credentialId}`;
			expect(row?.last_used_at).toBeNull();
		},
	);

	it("fails unavailable when the current directory dependency is absent after issue", async () => {
		await grant("agent_1", "use");
		const service = await start();
		const issued = await issue(service);
		deployment.removeDirectoryDependency();
		const denied = await listAgentsV2({
			...service.options,
			auth: issued.credential,
		});
		expect(denied.response?.status).toBe(503);
		const [row] =
			await client`select last_used_at from platform.platform_api_credentials where id=${issued.metadata.credentialId}`;
		expect(row?.last_used_at).toBeNull();
		expect(
			await client`select id from platform.audit_events where action='api.agent.metadata.read' and outcome='succeeded'`,
		).toHaveLength(0);
	});

	it.each([false, true])(
		"withholds success on immediate/commit audit failure (deferred=%s) and retries against current state",
		async (deferred) => {
			await grant("agent_1", "use");
			const service = await start();
			const issued = await issue(service);
			await armAuditFailure(deferred);
			const failed = await listAgentsV2({
				...service.options,
				auth: issued.credential,
			});
			expect(failed.response?.status).toBe(503);
			const [row] =
				await client`select last_used_at from platform.platform_api_credentials where id=${issued.metadata.credentialId}`;
			expect(row?.last_used_at).toBeNull();
			expect(
				await client`select id from platform.audit_events where action='api.agent.metadata.read' and outcome='succeeded'`,
			).toHaveLength(0);
			expect(logs.join("\n")).toContain(
				"personal_api_credential_audit_unavailable",
			);
			expect(JSON.stringify({ logs, error: failed.error })).not.toContain(
				"PRIVATE_SQL_SENTINEL",
			);
			await removeAuditFailure();
			expect(
				(await listAgentsV2({ ...service.options, auth: issued.credential }))
					.response?.status,
			).toBe(200);
			await revokePersonalApiCredentialV2({
				...service.options,
				auth: "session_alice",
				path: { credentialId: issued.metadata.credentialId },
				headers: { "Idempotency-Key": "fault.revoke" },
			});
			await armAuditFailure(deferred);
			expect(
				(await listAgentsV2({ ...service.options, auth: issued.credential }))
					.response?.status,
			).toBe(401);
		},
	);

	it.each([
		["mixed", "", 401],
		["basic", "", 401],
		["duplicate", "", 401],
		["unknown", "", 401],
		["query", "userId=user_other", 400],
		["query", "principal=user_other", 400],
		["query", "applicationId=application_other", 400],
		["query", "recipient=user_other", 400],
		["query", "role=system_admin", 400],
		["query", "scope=owner", 401],
		["header", "", 400],
	] as const)(
		"rejects %s auth or self-reported query %s over formal HTTP",
		async (kind, query, status) => {
			await grant("agent_1", "use");
			const service = await start();
			const issued = await issue(service);
			const authorization =
				kind === "basic"
					? `Basic ${issued.credential}`
					: kind === "duplicate"
						? `Bearer ${issued.credential}, Bearer ${issued.credential}`
						: kind === "unknown"
							? `Bearer papi_${"u".repeat(43)}`
							: `Bearer ${issued.credential}`;
			const response = await fetch(
				`${service.options.baseUrl}/api/v2/agents?${query}`,
				{
					headers: {
						Authorization: authorization,
						...(kind === "mixed"
							? { Cookie: "__Host-platform-session=session_admin" }
							: {}),
						...(kind === "header" ? { "X-User-Id": "user_admin" } : {}),
					},
				},
			);
			expect(response.status).toBe(status);
			const body = await response.json();
			const audits =
				await client`select * from platform.audit_events where action='api.agent.metadata.read'`;
			expect(audits).toHaveLength(1);
			expect(audits[0]?.actor_type).toBe("unknown");
			const hash = createHash("sha256").update(issued.credential).digest("hex");
			const observed = JSON.stringify({ body, audits, logs });
			for (const secret of [issued.credential, hash])
				expect(observed).not.toContain(secret);
		},
	);
});
