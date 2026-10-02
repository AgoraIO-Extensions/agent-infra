import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
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
import { createClient } from "../../web/src/pilot/generated-v2/client/index.ts";
import {
	issuePersonalApiCredentialV2,
	listPersonalApiCredentialsV2,
	narrowPersonalApiCredentialV2,
	revokePersonalApiCredentialV2,
} from "../../web/src/pilot/generated-v2/sdk.gen.ts";
import type { IssuePersonalApiCredentialV2Data } from "../../web/src/pilot/generated-v2/types.gen.ts";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "./index.ts";

// The generated Fetch SDK names BodyInit. Use Node's actual Request body
// type in this Node integration test without importing browser globals.
declare global {
	type BodyInit = NonNullable<RequestInit["body"]>;
}

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const moduleSpecifier = new URL(
	"../../../tests/fixtures/personal-credential-deployment.ts",
	import.meta.url,
).href;
const deployment: typeof import("../../../tests/fixtures/personal-credential-deployment.ts") =
	await import(moduleSpecifier);
const command: IssuePersonalApiCredentialV2Data["body"] = {
	scopes: ["agent:read", "agent:use"],
	expiresAt: null,
};
let database: PostgresTestDatabase;
let databaseClient: ReturnType<typeof postgres>;
const shutdowns: (() => Promise<void>)[] = [];
const logLines: string[] = [];
const sentHeaders: { cookie: string | null; authorization: string | null }[] =
	[];

async function start(otlpEndpoint?: string) {
	const output = new PassThrough();
	output.on("data", (chunk) => logLines.push(String(chunk)));
	const running = await startPlatformApiFromDeployment({
		moduleSpecifier,
		port: 0,
		log: (line) => logLines.push(line),
		observabilityOptions: { output, otlpEndpoint },
	});
	const shutdown = createPlatformApiShutdown(running);
	shutdowns.push(shutdown);
	const address = running.server.address();
	if (!address || typeof address === "string")
		throw new Error("Test API did not bind");
	const origin = `http://127.0.0.1:${address.port}`;
	const client = createClient({
		baseUrl: origin,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			sentHeaders.push({
				cookie: request.headers.get("Cookie"),
				authorization: request.headers.get("Authorization"),
			});
			return fetch(request);
		},
	});
	return { client, origin, shutdown };
}

function issue(
	client: ReturnType<typeof createClient>,
	key: string,
	auth = "session_alice",
	body = command,
) {
	return issuePersonalApiCredentialV2({
		client,
		auth,
		body,
		headers: { "Idempotency-Key": key },
	});
}

function revoke(
	client: ReturnType<typeof createClient>,
	key: string,
	credentialId: string,
	auth = "session_alice",
) {
	return revokePersonalApiCredentialV2({
		client,
		auth,
		path: { credentialId },
		headers: { "Idempotency-Key": key },
	});
}

async function succeededCounts() {
	const [row] = await databaseClient`select
		(select count(*)::int from platform.platform_api_credentials) as credentials,
		(select count(*)::int from platform.idempotency_records) as idempotency,
		(select count(*)::int from platform.audit_events where outcome='succeeded') as succeeded`;
	return row;
}

async function armAuditFailure(deferred: boolean) {
	await databaseClient`create function platform.fail_credential_http_audit() returns trigger language plpgsql as $$
		begin raise exception 'PRIVATE_SQL_SENTINEL'; end $$`;
	await databaseClient.unsafe(
		deferred
			? "create constraint trigger fail_credential_http_audit after insert on platform.audit_events deferrable initially deferred for each row execute function platform.fail_credential_http_audit()"
			: "create trigger fail_credential_http_audit before insert on platform.audit_events for each row execute function platform.fail_credential_http_audit()",
	);
}

async function removeAuditFailure() {
	await databaseClient`drop trigger if exists fail_credential_http_audit on platform.audit_events`;
	await databaseClient`drop function if exists platform.fail_credential_http_audit()`;
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("personal-credential-http");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	databaseClient = postgres(database.databaseUrl, { max: 1 });
	deployment.state.databaseUrl = database.databaseUrl;
});

beforeEach(async () => {
	deployment.state.directoryMode = "active";
	deployment.state.directoryCalls = 0;
	logLines.length = 0;
	sentHeaders.length = 0;
	vi.spyOn(console, "error").mockImplementation((...args) =>
		logLines.push(JSON.stringify(args)),
	);
	await databaseClient`truncate platform.platform_api_credentials, platform.idempotency_records,
		platform.audit_events, platform.platform_user_disables`;
});

afterEach(async () => {
	await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
	await removeAuditFailure();
	vi.restoreAllMocks();
});

afterAll(async () => {
	await databaseClient?.end();
	await database?.stop();
});

describe("formal deployment personal credential governance over PostgreSQL and generated SDK", () => {
	it("uses generated GET/PATCH and the same real material under current scope restrictions", async () => {
		const agentId = "agent_personal_narrowing";
		const record = {
			...structuredClone(agentConfigurationConformanceRecordV1),
			agentId,
		};
		await databaseClient`insert into platform.agents(id,current_configuration_revision) values (${agentId},${record.revision})`;
		try {
			await databaseClient`insert into platform.agent_applications
				(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence)
				values ('application_personal_narrowing',${agentId},'user_alice','Agent','Description','available','trace_seed','request_seed',clock_timestamp(),1,1,'ready','running',1,1)`;
			await databaseClient`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,configuration,created_at)
				values (${agentId},${record.revision},${record.source.kind === "standard" ? record.source.templateId : record.source.imageDigest},${databaseClient.json(record as never)},clock_timestamp())`;
			await databaseClient`insert into platform.agent_owners(agent_id,owner_id,created_at) values (${agentId},'user_alice',clock_timestamp())`;
			await databaseClient`insert into platform.agent_availability(agent_id,target_type,target_id) values (${agentId},'organization','org_1')`;
			await databaseClient`insert into platform.agent_principal_grants(agent_id,principal_type,principal_id,grant_type,authorization_revision)
				values (${agentId},'user','user_alice','use','grant_1')`;
			const { client, origin } = await start();
			const issued = await issue(client, "management.issue", "session_alice", {
				scopes: ["agent:read", "agent:manage"],
				expiresAt: null,
			});
			expect(issued.response?.status).toBe(201);
			if (!issued.data?.credential)
				throw new Error("No actual issued material");
			const material = issued.data.credential;
			const credentialId = issued.data.metadata.credentialId;
			const hash = createHash("sha256").update(material).digest("hex");
			const read = () =>
				fetch(`${origin}/api/v2/agents`, {
					headers: { Authorization: `Bearer ${material}` },
				});
			const before = await read();
			expect(before.status).toBe(200);
			expect((await before.json()).items).toEqual(
				expect.arrayContaining([expect.objectContaining({ agentId })]),
			);
			const narrowed = await narrowPersonalApiCredentialV2({
				client,
				auth: "session_alice",
				path: { credentialId },
				headers: { "Idempotency-Key": "management.patch" },
				body: { scopes: ["agent:read"], expiresAt: "2030-01-01T00:00:00Z" },
			});
			expect(narrowed.response?.status).toBe(200);
			expect((await read()).status).toBe(200);
			const page = await listPersonalApiCredentialsV2({
				client,
				auth: "session_alice",
				query: { limit: 1 },
			});
			expect(page.response?.status).toBe(200);
			const [used] = await databaseClient<{ last_used_at: Date | null }[]>`
				select last_used_at from platform.platform_api_credentials where id = ${credentialId}
			`;
			if (!used?.last_used_at || !narrowed.data?.metadata.lastUsedAt)
				throw new Error("No actual credential usage timestamp");
			expect(used.last_used_at.getTime()).toBeGreaterThanOrEqual(
				Date.parse(narrowed.data.metadata.lastUsedAt),
			);
			expect(page.data?.items).toEqual([
				{
					...narrowed.data.metadata,
					lastUsedAt: used.last_used_at.toISOString(),
				},
			]);
			expect(page.response?.headers.get("Cache-Control")).toBe("no-store");
			const other = await listPersonalApiCredentialsV2({
				client,
				auth: "session_bob",
			});
			expect(other.response?.status).toBe(200);
			expect(other.data?.items).toEqual([]);
			const replay = await narrowPersonalApiCredentialV2({
				client,
				auth: "session_alice",
				path: { credentialId },
				headers: { "Idempotency-Key": "management.patch" },
				body: { scopes: ["agent:read"], expiresAt: "2030-01-01T00:00:00.000Z" },
			});
			expect(replay.response?.status).toBe(200);
			expect(replay.data?.replayed).toBe(true);
			const expired = await narrowPersonalApiCredentialV2({
				client,
				auth: "session_alice",
				path: { credentialId },
				headers: { "Idempotency-Key": "management.remove-read" },
				body: { scopes: ["agent:read"], expiresAt: "2020-01-01T00:00:00Z" },
			});
			expect(expired.response?.status).toBe(200);
			expect((await read()).status).toBe(401);
			const scoped = await issue(
				client,
				"management.scope.issue",
				"session_alice",
				{ scopes: ["agent:read", "agent:manage"], expiresAt: null },
			);
			if (!scoped.data?.credential)
				throw new Error("No second actual material");
			const removedRead = await narrowPersonalApiCredentialV2({
				client,
				auth: "session_alice",
				path: { credentialId: scoped.data.metadata.credentialId },
				headers: { "Idempotency-Key": "management.scope.patch" },
				body: { scopes: ["agent:manage"] },
			});
			expect(removedRead.response?.status).toBe(200);
			expect(
				(
					await fetch(`${origin}/api/v2/agents`, {
						headers: { Authorization: `Bearer ${scoped.data.credential}` },
					})
				).status,
			).toBe(403);

			const [persisted] =
				await databaseClient`select credential_hash from platform.platform_api_credentials where id=${credentialId}`;
			expect(persisted?.credential_hash).toBe(hash);
			const audits = await databaseClient`select * from platform.audit_events`;
			const idempotency =
				await databaseClient`select result from platform.idempotency_records`;
			const serialized = JSON.stringify({
				page: page.data,
				other: other.data,
				narrowed: narrowed.data,
				replay: replay.data,
				audits,
				idempotency,
				logLines,
			});
			expect(serialized).not.toContain(material);
			expect(serialized).not.toContain(hash);
			expect(serialized).not.toContain(scoped.data.credential);
			expect(serialized).not.toContain(
				createHash("sha256").update(scoped.data.credential).digest("hex"),
			);
		} finally {
			await databaseClient`delete from platform.agent_principal_grants where agent_id=${agentId}`;
			await databaseClient`delete from platform.agents where id=${agentId}`;
		}
	});

	it("lists only current personal metadata through the actual process and generated SDK", async () => {
		const { client } = await start();
		const issued = await Promise.all(
			["list.one", "list.two", "list.three"].map((key) => issue(client, key)),
		);
		const foreign = await issue(client, "list.foreign", "session_bob");
		const expected = issued
			.map((result) => {
				expect(result.response?.status).toBe(201);
				if (!result.data || result.data.replayed)
					throw new Error("No actual first-delivery credential");
				return result.data.metadata;
			})
			.toSorted((left, right) =>
				left.credentialId.localeCompare(right.credentialId),
			);
		const first = await listPersonalApiCredentialsV2({
			client,
			auth: "session_alice",
			query: { limit: 2 },
		});
		expect(first.response?.status).toBe(200);
		expect(first.response?.headers.get("Cache-Control")).toBe("no-store");
		if (!first.data?.nextCursor) throw new Error("No actual pagination cursor");
		const second = await listPersonalApiCredentialsV2({
			client,
			auth: "session_alice",
			query: { limit: 2, cursor: first.data.nextCursor },
		});
		expect(second.response?.status).toBe(200);
		expect(second.data?.nextCursor).toBeNull();
		expect([
			...(first.data?.items ?? []),
			...(second.data?.items ?? []),
		]).toEqual(expected);
		const bob = await listPersonalApiCredentialsV2({
			client,
			auth: "session_bob",
		});
		expect(bob.response?.status).toBe(200);
		expect(bob.data?.items).toEqual([foreign.data?.metadata]);
		const audits =
			await databaseClient`select * from platform.audit_events where action='api.credential.metadata.read'`;
		expect(audits).toHaveLength(3);
		const serialized = JSON.stringify({
			first: first.data,
			second: second.data,
			bob: bob.data,
			audits,
			logLines,
		});
		for (const result of [...issued, foreign]) {
			if (!result.data?.credential)
				throw new Error("No actual issued material");
			expect(serialized).not.toContain(result.data.credential);
			expect(serialized).not.toContain(
				createHash("sha256").update(result.data.credential).digest("hex"),
			);
		}
	});
	it.each([
		"disabled",
		"missing",
		"malformed",
		"error",
		"revision_changed",
		"finally_disabled",
	] as const)(
		"GET/PATCH recheck current identity and roll back on %s",
		async (mode) => {
			const { client } = await start();
			const issued = await issue(client, "identity.issue");
			if (!issued.data) throw new Error("No issued credential");
			deployment.state.directoryMode = mode;
			deployment.state.directoryCalls = 0;
			const list = await listPersonalApiCredentialsV2({
				client,
				auth: "session_alice",
			});
			expect(list.response?.status).toBe(
				mode === "disabled" || mode === "missing" || mode === "finally_disabled"
					? 403
					: 503,
			);
			deployment.state.directoryCalls = 0;
			const patch = await narrowPersonalApiCredentialV2({
				client,
				auth: "session_alice",
				path: { credentialId: issued.data.metadata.credentialId },
				headers: { "Idempotency-Key": "identity.patch" },
				body: { scopes: ["agent:read"] },
			});
			expect(patch.response?.status).toBe(
				mode === "disabled" || mode === "missing" || mode === "finally_disabled"
					? 403
					: 503,
			);
			const [row] =
				await databaseClient`select scopes from platform.platform_api_credentials where id=${issued.data.metadata.credentialId}`;
			expect(row?.scopes).toEqual(issued.data.metadata.scopes);
			const [idempotency] =
				await databaseClient`select count(*)::int as count from platform.idempotency_records where command_type='api.credential.narrowed'`;
			expect(idempotency?.count).toBe(0);
		},
	);

	it("exports actual correlated governance traces without credential material or hashes", async () => {
		const exports: { path: string; body: Buffer }[] = [];
		const collector = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			exports.push({
				path: request.url ?? "",
				body: Buffer.concat(chunks),
			});
			response.writeHead(200);
			response.end();
		});
		await new Promise<void>((resolve, reject) => {
			collector.once("error", reject);
			collector.listen(0, "127.0.0.1", resolve);
		});
		let service: Awaited<ReturnType<typeof start>> | undefined;
		try {
			const address = collector.address();
			if (!address || typeof address === "string")
				throw new Error("Test OTLP receiver did not bind");
			service = await start(`http://127.0.0.1:${address.port}`);
			const first = await issue(service.client, "trace.issue");
			expect(first.response?.status).toBe(201);
			if (!first.data?.credential)
				throw new Error("No first-delivery material");
			const material = first.data.credential;
			const digest = createHash("sha256").update(material).digest("hex");
			const credentialId = first.data.metadata.credentialId;
			const [persisted] = await databaseClient`select credential_hash
				from platform.platform_api_credentials where id=${credentialId}`;
			expect(persisted?.credential_hash).toBe(digest);
			const replay = await issue(service.client, "trace.issue");
			expect(replay.response?.status).toBe(200);
			expect(replay.data?.credential).toBeNull();
			const denied = await issuePersonalApiCredentialV2({
				client: service.client,
				auth: "session_alice",
				body: command,
				headers: {
					"Idempotency-Key": "trace.denied",
					Authorization: `Bearer ${material}`,
					"X-Request-Id": digest,
				},
			});
			expect(denied.response?.status).toBe(401);
			await armAuditFailure(false);
			const failed = await issue(service.client, "trace.audit.failure");
			expect(failed.response?.status).toBe(503);
			expect(failed.data).toBeUndefined();
			await removeAuditFailure();
			const revoked = await revoke(
				service.client,
				"trace.revoke",
				credentialId,
			);
			expect(revoked.response?.status).toBe(200);
			const audits = await databaseClient`select * from platform.audit_events`;
			expect(await succeededCounts()).toEqual({
				credentials: 1,
				idempotency: 2,
				succeeded: 2,
			});
			// Production shutdown flushes its actual exporter to the loopback receiver.
			await service.shutdown();
			const traces = exports.filter((item) => item.path === "/v1/traces");
			expect(traces.length).toBeGreaterThan(0);
			const traceBodies = traces.map((item) => item.body.toString()).join("\n");
			expect(traceBodies).toContain("platform.http");
			for (const outcome of ["completed", "rejected", "failed"])
				expect(traceBodies).toContain(outcome);
			for (const audit of audits) {
				expect(audit.request_id).toBeTruthy();
				expect(audit.trace_id).toBeTruthy();
				expect(traceBodies).toContain(audit.request_id);
				expect(traceBodies).toContain(audit.trace_id);
			}
			const serialized = JSON.stringify({
				exports: exports.map((item) => ({
					path: item.path,
					body: item.body.toString(),
				})),
				audits,
				logLines,
				errors: [denied.error, failed.error],
				metadata: [first.data.metadata, replay.data, revoked.data],
			});
			for (const secret of [material, digest, "PRIVATE_SQL_SENTINEL"]) {
				expect(serialized).not.toContain(secret);
				for (const exported of exports)
					expect(exported.body.includes(secret)).toBe(false);
			}
			// Written only after actual exporter and all redaction assertions pass.
			const evidencePath = process.env.PERSONAL_CREDENTIAL_TRACE_EVIDENCE;
			if (evidencePath)
				await writeFile(
					evidencePath,
					JSON.stringify(
						{
							classification:
								"actual production OTLP export from controlled HTTP/SDK governance and real PostgreSQL",
							statuses: [
								first.response?.status,
								replay.response?.status,
								denied.response?.status,
								failed.response?.status,
								revoked.response?.status,
							],
							credentialId,
							materialHashMatchedDatabase: true,
							materialAndHashAbsent: true,
							exports: exports.map((item) => ({
								path: item.path,
								bodyBase64: item.body.toString("base64"),
								sha256: createHash("sha256").update(item.body).digest("hex"),
							})),
							audits,
							logLines,
							metadata: [first.data.metadata, replay.data, revoked.data],
						},
						null,
						2,
					),
				);
		} finally {
			await service?.shutdown();
			await new Promise<void>((resolve) => collector.close(() => resolve()));
		}
	});

	it("delivers hash-matching material once and recovers lost delivery through restart, original-ID revoke and a new key", async () => {
		const firstServer = await start();
		const first = await issue(firstServer.client, "issue.once");
		expect(first.response?.status).toBe(201);
		expect(first.response?.headers.get("Cache-Control")).toBe("no-store");
		if (!first.data?.credential) throw new Error("No first-delivery material");
		const material = first.data.credential;
		const digest = createHash("sha256").update(material).digest("hex");
		const credentialId = first.data.metadata.credentialId;
		const [persisted] =
			await databaseClient`select * from platform.platform_api_credentials where id=${credentialId}`;
		expect(persisted?.credential_hash).toBe(digest);
		expect(JSON.stringify(persisted)).not.toContain(material);
		expect(JSON.stringify(first.data.metadata)).not.toContain(digest);
		expect(sentHeaders[0]).toEqual({
			cookie: "__Host-platform-session=session_alice",
			authorization: null,
		});
		await firstServer.shutdown();
		const restarted = await start();
		const replay = await issue(
			restarted.client,
			"issue.once",
			"session_alice",
			{ ...command, scopes: ["agent:use", "agent:read"] },
		);
		expect(replay.response?.status).toBe(200);
		expect(replay.data).toEqual({
			metadata: first.data.metadata,
			credential: null,
			replayed: true,
		});
		const revoked = await revoke(restarted.client, "revoke.once", credentialId);
		expect(revoked.response?.status).toBe(200);
		expect(revoked.data?.metadata.revokedAt).not.toBeNull();
		const revokedReplay = await issue(restarted.client, "issue.once");
		expect(revokedReplay.data).toEqual({
			metadata: revoked.data?.metadata,
			credential: null,
			replayed: true,
		});
		expect(
			(await revoke(restarted.client, "revoke.once", credentialId)).data,
		).toEqual({ metadata: revoked.data?.metadata, replayed: true });
		const replacement = await issue(restarted.client, "issue.new");
		expect(replacement.response?.status).toBe(201);
		expect(replacement.data?.metadata.credentialId).not.toBe(credentialId);
		expect(replacement.data?.credential).not.toBe(material);
		expect(await succeededCounts()).toEqual({
			credentials: 2,
			idempotency: 3,
			succeeded: 3,
		});
		const records =
			await databaseClient`select result from platform.idempotency_records`;
		for (const row of records)
			expect(Object.keys(row.result)).toEqual(["credentialId"]);
		const audits = await databaseClient`select * from platform.audit_events`;
		expect(
			audits.filter((event) => event.action === "api.credential.issued"),
		).toHaveLength(2);
		expect(
			audits.every(
				(event) =>
					event.actor_id === "user_alice" && event.actor_type === "user",
			),
		).toBe(true);
		expect(audits.every((event) => event.request_id && event.trace_id)).toBe(
			true,
		);
		const serialized = JSON.stringify({ records, audits, logLines });
		expect(serialized).not.toContain(material);
		expect(serialized).not.toContain(digest);
		const [outbox] =
			await databaseClient`select count(*)::int as count from platform.outbox_items`;
		expect(outbox?.count).toBe(0);
	});

	it("serializes issuance and DELETE across two formal service instances, isolates users and rejects changed keys", async () => {
		const services = [await start(), await start()] as const;
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				issue(
					services[i % 2]?.client ?? services[0].client,
					"concurrent.issue",
				),
			),
		);
		expect(
			results.filter((result) => result.response?.status === 201),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.response?.status === 200),
		).toHaveLength(7);
		const ids = new Set(
			results.map((result) => result.data?.metadata.credentialId),
		);
		expect(ids.size).toBe(1);
		const credentialId = results[0]?.data?.metadata.credentialId;
		if (!credentialId) throw new Error("No committed credential ID");
		expect(
			(await issue(services[0].client, "concurrent.issue", "session_bob"))
				.response?.status,
		).toBe(201);
		expect(
			(
				await issue(services[0].client, "concurrent.issue", "session_alice", {
					scopes: ["agent:read"],
					expiresAt: null,
				})
			).response?.status,
		).toBe(409);
		const revocations = await Promise.all(
			services.map(({ client }) =>
				revoke(client, "concurrent.revoke", credentialId),
			),
		);
		expect(revocations.every((result) => result.response?.status === 200)).toBe(
			true,
		);
		expect(
			revocations.filter((result) => result.data?.replayed === false),
		).toHaveLength(1);
		expect(
			revocations.filter((result) => result.data?.replayed === true),
		).toHaveLength(1);
		expect(
			(
				await revoke(
					services[0].client,
					"concurrent.revoke",
					"credential_missing",
				)
			).response?.status,
		).toBe(409);
		expect(await succeededCounts()).toEqual({
			credentials: 2,
			idempotency: 3,
			succeeded: 3,
		});
	});

	it("makes another person's credential and a missing credential return the same 404 without exposing their audit target", async () => {
		const { client } = await start();
		const first = await issue(client, "issue.bob", "session_bob");
		const credentialId = first.data?.metadata.credentialId;
		if (!credentialId) throw new Error("No committed credential ID");
		const cross = await revoke(client, "cross.revoke", credentialId);
		const missing = await revoke(
			client,
			"missing.revoke",
			"credential_missing",
		);
		expect([cross.response?.status, missing.response?.status]).toEqual([
			404, 404,
		]);
		expect(cross.error?.code).toBe(missing.error?.code);
		const rows =
			await databaseClient`select * from platform.audit_events where outcome='rejected' order by occurred_at`;
		expect(rows).toHaveLength(2);
		expect(
			rows.every(
				(row) => row.actor_id === "user_alice" && row.target_id === "unknown",
			),
		).toBe(true);
		const [credential] =
			await databaseClient`select revoked_at from platform.platform_api_credentials where id=${credentialId}`;
		expect(credential?.revoked_at).toBeNull();
	});

	it.each([
		{ mode: "disabled", status: 403 },
		{ mode: "missing", status: 403 },
		{ mode: "mismatched", status: 503 },
		{ mode: "malformed", status: 503 },
		{ mode: "error", status: 503 },
		{ mode: "revision_changed", status: 503 },
		{ mode: "finally_disabled", status: 403 },
	] as const)(
		"rejects current $mode directory facts for both issue and revoke",
		async ({ mode, status }) => {
			const { client } = await start();
			const initial = await issue(client, "before.directory.change");
			const credentialId = initial.data?.metadata.credentialId;
			if (!credentialId) throw new Error("No committed credential ID");
			deployment.state.directoryMode = mode;
			deployment.state.directoryCalls = 0;
			const deniedIssue = await issue(client, "after.directory.change");
			deployment.state.directoryCalls = 0;
			const deniedRevoke = await revoke(
				client,
				"after.directory.change",
				credentialId,
			);
			expect([
				deniedIssue.response?.status,
				deniedRevoke.response?.status,
			]).toEqual([status, status]);
			expect(await succeededCounts()).toEqual({
				credentials: 1,
				idempotency: 1,
				succeeded: 1,
			});
			const [credential] =
				await databaseClient`select revoked_at from platform.platform_api_credentials where id=${credentialId}`;
			expect(credential?.revoked_at).toBeNull();
			expect(
				JSON.stringify({
					deniedIssue: deniedIssue.error,
					deniedRevoke: deniedRevoke.error,
					logLines,
				}),
			).not.toContain("PRIVATE_DIRECTORY_SENTINEL");
		},
	);

	it("gives persisted manual disable priority over a broken current directory", async () => {
		const { client } = await start();
		const issued = await issue(client, "before.disable");
		const credentialId = issued.data?.metadata.credentialId;
		if (!credentialId) throw new Error("No committed credential ID");
		await databaseClient`insert into platform.platform_user_disables (user_id) values ('user_alice')`;
		deployment.state.directoryMode = "error";
		deployment.state.directoryCalls = 0;
		expect((await issue(client, "after.disable")).response?.status).toBe(403);
		expect(
			(await revoke(client, "after.disable", credentialId)).response?.status,
		).toBe(403);
		expect(deployment.state.directoryCalls).toBe(0);
		expect(await succeededCounts()).toEqual({
			credentials: 1,
			idempotency: 1,
			succeeded: 1,
		});
	});

	it.each([false, true])(
		"rolls back issue and revoke on actual audit failure (deferred=%s)",
		async (deferred) => {
			const { client } = await start();
			await armAuditFailure(deferred);
			const rejectedIssue = await issue(client, "fault.issue");
			expect(rejectedIssue.response?.status).toBe(503);
			expect(rejectedIssue.data).toBeUndefined();
			expect(await succeededCounts()).toEqual({
				credentials: 0,
				idempotency: 0,
				succeeded: 0,
			});
			await removeAuditFailure();
			const initial = await issue(client, "before.revoke.fault");
			const credentialId = initial.data?.metadata.credentialId;
			if (!credentialId) throw new Error("No committed credential ID");
			await armAuditFailure(deferred);
			const rejectedRevoke = await revoke(client, "fault.revoke", credentialId);
			expect(rejectedRevoke.response?.status).toBe(503);
			expect(await succeededCounts()).toEqual({
				credentials: 1,
				idempotency: 1,
				succeeded: 1,
			});
			const [persisted] =
				await databaseClient`select revoked_at from platform.platform_api_credentials where id=${credentialId}`;
			expect(persisted?.revoked_at).toBeNull();
			const mixed = await issuePersonalApiCredentialV2({
				client,
				auth: "session_alice",
				body: command,
				headers: {
					"Idempotency-Key": "fault.rejected",
					Authorization: "Bearer PRIVATE_MATERIAL_SENTINEL",
				},
			});
			expect(mixed.response?.status).toBe(401);
			expect(
				JSON.stringify({
					errors: [rejectedIssue.error, rejectedRevoke.error, mixed.error],
					logLines,
				}),
			).not.toMatch(/PRIVATE_SQL_SENTINEL|PRIVATE_MATERIAL_SENTINEL/);
		},
	);

	it.each(["principal", "userId", "applicationId", "recipient", "role"])(
		"rejects caller-provided %s through the formal HTTP boundary",
		async (field) => {
			const { origin } = await start();
			const response = await fetch(`${origin}/api/v2/me/api-credentials`, {
				method: "POST",
				headers: {
					Cookie: "__Host-platform-session=session_alice",
					"Content-Type": "application/json",
					"Idempotency-Key": "forged.identity",
				},
				body: JSON.stringify({
					...command,
					[field]: "PRIVATE_FORGED_SENTINEL",
				}),
			});
			expect(response.status).toBe(400);
			expect(await response.text()).not.toContain("PRIVATE_FORGED_SENTINEL");
			expect(await succeededCounts()).toEqual({
				credentials: 0,
				idempotency: 0,
				succeeded: 0,
			});
		},
	);

	it("preserves browser discovery and administrator reads while rejecting Authorization governance and anonymous requests", async () => {
		const { client, origin } = await start();
		for (const authorization of ["", "Basic invalid", "Bearer invalid"]) {
			const denied = await issuePersonalApiCredentialV2({
				client,
				auth: "session_alice",
				body: command,
				headers: {
					"Idempotency-Key": "mixed.authorization",
					Authorization: authorization,
				},
			});
			expect(denied.response?.status).toBe(401);
		}
		expect(
			(await issue(client, "anonymous", "invalid_session")).response?.status,
		).toBe(401);
		const browser = await fetch(`${origin}/api/v2/agents`, {
			headers: { Cookie: "__Host-platform-session=session_alice" },
		});
		expect(browser.status).toBe(200);
		const admin = await fetch(`${origin}/api/v2/admin/agents`, {
			headers: { Cookie: "__Host-platform-session=session_admin" },
		});
		expect(admin.status).toBe(200);
		const mixedAdmin = await fetch(`${origin}/api/v2/admin/agents`, {
			headers: {
				Cookie: "__Host-platform-session=session_admin",
				Authorization: "Bearer invalid",
			},
		});
		expect(mixedAdmin.status).toBe(401);
		expect(await succeededCounts()).toEqual({
			credentials: 0,
			idempotency: 0,
			succeeded: 0,
		});
	});
	it("preserves existing accepted Task control and outbox records and current browser Owner access", async () => {
		const agentId = "agent_governance_preservation";
		const conversationId = "conversation_governance_preservation";
		const executionId = "execution_governance_preservation";
		const authorizationId = "authorization_governance_preservation";
		const messageId = "message_governance_preservation";
		const configuration = {
			...structuredClone(agentConfigurationConformanceRecordV1),
			agentId,
			revision: 1,
		};
		if (configuration.source.kind !== "standard")
			throw new Error("Expected standard fixture configuration");
		const boundary = {
			schemaVersion: 1,
			principal: { kind: "user", id: "user_alice" },
			agentId,
			channelId: "web",
			identityRevision: "revision_1",
			agentAuthorizationRevision: "agent_revision_1",
			accessSources: [{ kind: "organization", organizationId: "org_1" }],
		};
		// Controlled, nonempty previously accepted facts; no Worker or task runtime
		// is invoked. Governance uses the real loader, app, Core and Store below.
		await databaseClient`insert into platform.agents (id, authorization_revision)
			values (${agentId}, 'agent_revision_1')`;
		await databaseClient`insert into platform.agent_applications
			(id, agent_id, applicant_id, name, description, status, trace_id, request_id,
			 submitted_at, management_revision, approval_revision, desired_state, workload_revision, fence)
			values ('application_governance_preservation', ${agentId}, 'user_alice', 'Existing Agent',
			 'Existing description', 'stopped', 'original_trace', 'original_request', now(), 1, 1, 'stopped', 1, 1)`;
		await databaseClient`insert into platform.agent_configuration_revisions
			(agent_id, revision, source_reference, created_at, configuration)
			values (${agentId}, 1, ${configuration.source.templateId}, now(), ${databaseClient.json(configuration as unknown as postgres.JSONValue)})`;
		await databaseClient`insert into platform.agent_owners (agent_id, owner_id, created_at)
			values (${agentId}, 'user_alice', now())`;
		await databaseClient`insert into platform.conversations
			(id, agent_id, actor_id, channel_id, status, session_generation, authorization_revision)
			values (${conversationId}, ${agentId}, 'user_alice', 'web', 'active', 1, 'agent_revision_1')`;
		await databaseClient`insert into platform.conversation_executions
			(execution_id, conversation_id, agent_id, actor_id, channel_id, turn_id, status,
			 session_generation, authorization_revision, created_at, model_configuration_revision, model_option_id, reasoning_level)
			values (${executionId}, ${conversationId}, ${agentId}, 'user_alice', 'web',
			 'turn_governance_preservation', 'submitted', 1, 'agent_revision_1', now(), 1, 'model_primary', 'low')`;
		await databaseClient`insert into platform.conversation_messages
			(message_id, conversation_id, actor_id, role, text, execution_id, status, created_at)
			values (${messageId}, ${conversationId}, 'user_alice', 'user', 'Synthetic accepted task', ${executionId}, 'submitted', now())`;
		await databaseClient`insert into platform.conversation_audit_events
			(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at)
			values ('acceptance_governance_preservation', ${conversationId}, ${executionId}, ${agentId}, 'user_alice',
			 'conversation.message.accepted', 'original_trace', 'original_request', now())`;
		await databaseClient`insert into platform.task_authorization_records (id, execution_id, boundary)
			values (${authorizationId}, ${executionId}, ${databaseClient.json(boundary)})`;
		await databaseClient`insert into platform.task_control_records
			(id, execution_id, authorization_record_id, reason)
			values ('control_governance_preservation', ${executionId}, ${authorizationId}, 'recovery')`;
		await databaseClient`insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, trace_id, request_id)
			values ('outbox_governance_preservation', 'conversation', ${conversationId},
			 'conversation.turn.submit.v1', ${databaseClient.json({
					schemaVersion: 1,
					executionId,
					conversationId,
					messageId,
					turnId: "turn_governance_preservation",
					sessionGeneration: 1,
					modelConfigurationRevision: 1,
					modelOptionId: "model_primary",
					reasoningLevel: "low",
				})}, 'original_trace', 'original_request')`;
		const snapshot = async () => {
			const records: Record<string, unknown[]> = {};
			for (const table of [
				"agents",
				"agent_applications",
				"agent_configuration_revisions",
				"agent_owners",
				"conversations",
				"conversation_executions",
				"conversation_messages",
				"conversation_audit_events",
				"task_authorization_records",
				"task_control_records",
				"outbox_items",
			]) {
				records[table] = (
					await databaseClient.unsafe(
						`select to_jsonb(t) as row from platform.${table} t order by to_jsonb(t)::text`,
					)
				).map((row) => row.row);
			}
			return records;
		};
		const before = await snapshot();
		for (const rows of Object.values(before)) expect(rows).toHaveLength(1);
		expect(before.conversation_executions).toEqual([
			expect.objectContaining({
				execution_id: executionId,
				status: "submitted",
			}),
		]);
		expect(before.task_authorization_records).toEqual([
			expect.objectContaining({
				id: authorizationId,
				execution_id: executionId,
				boundary,
			}),
		]);
		expect(before.task_control_records).toEqual([
			expect.objectContaining({
				execution_id: executionId,
				authorization_record_id: authorizationId,
			}),
		]);
		expect(before.outbox_items).toEqual([
			expect.objectContaining({
				scope_id: conversationId,
				status: "pending",
				payload: expect.objectContaining({
					executionId,
					conversationId,
					messageId,
				}),
			}),
		]);
		const { client, origin } = await start();
		const read = async (path: string, session: string) => {
			const response = await fetch(`${origin}${path}`, {
				headers: { Cookie: `__Host-platform-session=${session}` },
			});
			expect(response.status).toBe(200);
			return response.json() as Promise<{ items: { agentId: string }[] }>;
		};
		const readViews = async () => ({
			owner: await read("/api/v2/agents?scope=owner", "session_alice"),
			nonOwner: await read("/api/v2/agents?scope=owner", "session_bob"),
			discover: await read("/api/v2/agents", "session_alice"),
			admin: await read("/api/v2/admin/agents", "session_admin"),
		});
		const beforeViews = await readViews();
		for (const view of [
			beforeViews.owner,
			beforeViews.discover,
			beforeViews.admin,
		])
			expect(view.items.map((item) => item.agentId)).toEqual([agentId]);
		expect(beforeViews.nonOwner.items).toEqual([]);
		const issued = await issue(client, "preservation.issue");
		expect(issued.response?.status).toBe(201);
		if (!issued.data) throw new Error("No issued credential");
		const afterIssue = await snapshot();
		expect(afterIssue).toEqual(before);
		expect(await readViews()).toEqual(beforeViews);
		const revoked = await revoke(
			client,
			"preservation.revoke",
			issued.data.metadata.credentialId,
		);
		expect(revoked.response?.status).toBe(200);
		expect(revoked.data?.metadata.revokedAt).not.toBeNull();
		const afterRevoke = await snapshot();
		expect(afterRevoke).toEqual(before);
		const afterViews = await readViews();
		expect(afterViews).toEqual(beforeViews);
		const evidencePath = process.env.PERSONAL_CREDENTIAL_PRESERVATION_EVIDENCE;
		if (evidencePath)
			await writeFile(
				evidencePath,
				JSON.stringify(
					{
						classification:
							"controlled previously accepted nonempty Task facts in actual PostgreSQL, formal governance and browser queries",
						actual: {
							before,
							afterIssue,
							afterRevoke,
							beforeViews,
							afterViews,
						},
						fingerprints: [before, afterIssue, afterRevoke].map((state) =>
							createHash("sha256").update(JSON.stringify(state)).digest("hex"),
						),
						credentialId: issued.data.metadata.credentialId,
						statuses: [issued.response?.status, revoked.response?.status],
					},
					null,
					2,
				),
			);
		// Keep later existing empty-page/outbox cases isolated if the full suite
		// executes these definitions in a different order.
		await databaseClient`truncate platform.agents, platform.conversations cascade`;
		await databaseClient`truncate platform.outbox_items`;
	});
});
