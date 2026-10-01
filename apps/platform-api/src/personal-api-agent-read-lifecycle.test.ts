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
	issuePersonalApiCredentialV2,
	listAdminAgentsV2,
	listAgentsV2,
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
		begin if new.action='api.agent.metadata.read' then raise exception 'PRIVATE_SQL_SENTINEL'; end if; return new; end $$`;
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
				await client`select * from platform.audit_events where action='api.agent.metadata.read' order by occurred_at`;
			expect(audits.map((audit) => audit.outcome)).toEqual([
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
