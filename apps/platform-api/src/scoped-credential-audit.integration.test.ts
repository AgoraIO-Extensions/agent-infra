import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import {
	ScopedPlatformAuditPageV1Schema,
	ScopedPlatformAuditProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import { createClient } from "../../web/src/pilot/generated-v2/client/index.ts";
import {
	issuePersonalApiCredentialV2,
	narrowPersonalApiCredentialV2,
	revokePersonalApiCredentialV2,
} from "../../web/src/pilot/generated-v2/sdk.gen.ts";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "./index.ts";

const moduleSpecifier = new URL(
	"../../../tests/fixtures/personal-credential-deployment.ts",
	import.meta.url,
).href;
const deployment: typeof import("../../../tests/fixtures/personal-credential-deployment.ts") =
	await import(moduleSpecifier);
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let origin: string;
let shutdown: (() => Promise<void>) | undefined;
const logs: string[] = [];
const privateValues: string[] = [];
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const cookie = (user: string) => ({
	Cookie: `__Host-platform-session=session_${user}`,
});

beforeAll(async () => {
	database = await startPostgresTestDatabase("credential-audit-http");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
	deployment.state.databaseUrl = database.databaseUrl;
	deployment.state.directoryMode = "active";
	const output = new PassThrough();
	output.on("data", (chunk) => logs.push(String(chunk)));
	const running = await startPlatformApiFromDeployment({
		moduleSpecifier,
		port: 0,
		log: (line) => logs.push(line),
		observabilityOptions: { output },
	});
	shutdown = createPlatformApiShutdown(running);
	const address = running.server.address();
	if (!address || typeof address === "string")
		throw new Error("No API listener");
	origin = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
	await shutdown?.();
	await sql?.end();
	await database?.stop();
});

async function read(
	path: string,
	headers: RequestInit["headers"] = cookie("admin"),
	status = 200,
): Promise<unknown> {
	const response = await fetch(`${origin}${path}`, { headers });
	const text = await response.text();
	expect(response.status).toBe(status);
	for (const value of privateValues) expect(text).not.toContain(value);
	return JSON.parse(text);
}

describe("credential governance audit over the original API and PostgreSQL", () => {
	it("pages real issue/narrow/revoke and legacy metadata, while denying own governance access", async () => {
		const client = createClient({ baseUrl: origin });
		const input = {
			client,
			auth: "session_alice",
			headers: { "Idempotency-Key": randomUUID() },
			body: {
				scopes: ["agent:use" as const, "agent:read" as const],
				expiresAt: null,
			},
		};
		const issued = await issuePersonalApiCredentialV2(input);
		expect(issued.response?.status).toBe(201);
		if (!issued.data?.credential) throw new Error("No produced credential");
		privateValues.push(issued.data.credential, hash(issued.data.credential));
		const replay = await issuePersonalApiCredentialV2(input);
		expect(replay.response?.status).toBe(200);
		expect(replay.data).toMatchObject({
			credential: null,
			replayed: true,
			metadata: { credentialId: issued.data.metadata.credentialId },
		});
		const credentialId = issued.data.metadata.credentialId;
		for (const { body, snapshot } of [
			{
				body: { scopes: ["agent:use" as const] },
				snapshot: { scopes: ["agent:use"], expiresAt: null },
			},
			{
				body: { expiresAt: "2030-01-01T00:00:00.000Z" },
				snapshot: {
					scopes: ["agent:use"],
					expiresAt: "2030-01-01T00:00:00.000Z",
				},
			},
		]) {
			const patch = {
				client,
				auth: "session_alice",
				path: { credentialId },
				headers: { "Idempotency-Key": randomUUID() },
				body,
			};
			const narrowed = await narrowPersonalApiCredentialV2(patch);
			expect(narrowed.response?.status).toBe(200);
			expect(narrowed.data).toMatchObject({
				replayed: false,
				metadata: { credentialId, ...snapshot },
			});
			const replayed = await narrowPersonalApiCredentialV2(patch);
			expect(replayed.response?.status).toBe(200);
			expect(replayed.data).toMatchObject({
				replayed: true,
				metadata: { credentialId, ...snapshot },
			});
		}
		const snapshots = await sql<{ details: unknown }[]>`
			select details from platform.audit_events where target_id=${credentialId}
			and action='api.credential.narrowed' order by occurred_at, id`;
		expect(snapshots.map((row) => row.details)).toEqual([
			{ scopes: ["agent:use"], expiresAt: null },
			{ scopes: ["agent:use"], expiresAt: "2030-01-01T00:00:00.000Z" },
		]);
		const revoked = await revokePersonalApiCredentialV2({
			client,
			auth: "session_alice",
			headers: { "Idempotency-Key": randomUUID() },
			path: { credentialId: issued.data.metadata.credentialId },
		});
		expect(revoked.response?.status).toBe(200);
		const rows = await sql<{ id: string; action: string }[]>`
			select id, action from platform.audit_events where actor_id='user_alice'
			and target_id=${credentialId}
			and action in ('api.credential.issued','api.credential.revoked','api.credential.narrowed')`;
		expect(rows.map((row) => row.action).sort()).toEqual([
			"api.credential.issued",
			"api.credential.narrowed",
			"api.credential.narrowed",
			"api.credential.revoked",
		]);
		const legacyId = randomUUID();
		await sql`insert into platform.audit_events(id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome)
			values (${legacyId},'legacy-http','user','user_alice','agent.application.rejected','agent_application','legacy-application','rejected')`;
		const filter = "principalKind=user&principalId=user_alice";
		const expected = ScopedPlatformAuditPageV1Schema.parse(
			await read(`/api/v3/admin/audit?${filter}`),
		);
		expect(expected.items.map((item) => item.auditId).sort()).toEqual(
			[legacyId, ...rows.map((row) => row.id)].sort(),
		);
		let page = ScopedPlatformAuditPageV1Schema.parse(
			await read(`/api/v3/admin/audit?${filter}&limit=1`),
		);
		const later = await issuePersonalApiCredentialV2({
			...input,
			headers: { "Idempotency-Key": randomUUID() },
		});
		expect(later.response?.status).toBe(201);
		if (!later.data?.credential) throw new Error("No later credential");
		privateValues.push(later.data.credential, hash(later.data.credential));
		const ids = page.items.map((item) => item.auditId);
		for (let count = 0; page.nextCursor !== null && count < 10; count++) {
			page = ScopedPlatformAuditPageV1Schema.parse(
				await read(
					`/api/v3/admin/audit?${filter}&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
				),
			);
			ids.push(...page.items.map((item) => item.auditId));
		}
		expect(page.nextCursor).toBeNull();
		expect(ids).toEqual(expected.items.map((item) => item.auditId));

		// Controlled material proves real application authentication, not #1165 issuance.
		const applicationId = randomUUID();
		const material = `papi_${randomBytes(32).toString("base64url")}`;
		const applicationCredentialId = randomUUID();
		privateValues.push(material, hash(material));
		await sql`insert into platform.platform_applications(id,name,responsible_user_id,status,authorization_revision)
			values (${applicationId},'Controlled audit application','user_alice','active','application-current')`;
		await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes)
			values (${applicationCredentialId},'application',${applicationId},${hash(material)},'["agent:use"]'::jsonb)`;
		const applicationHeaders = { Authorization: `Bearer ${material}` };
		const personalHeaders = {
			Authorization: `Bearer ${later.data.credential}`,
		};
		for (const row of rows) {
			const record = ScopedPlatformAuditProjectionV1Schema.parse(
				await read(`/api/v3/admin/audit/${row.id}`),
			);
			expect(record).toMatchObject({
				action: row.action,
				actor: { kind: "user", actorId: "user_alice" },
				summary: row.action,
				result: "succeeded",
				subject: {
					kind: "api_credential",
					subjectId: issued.data.metadata.credentialId,
				},
				executionId: null,
				originalPrincipal: null,
			});
			for (const field of ["details", "scopes", "expiresAt", "credentialHash"])
				expect(record).not.toHaveProperty(field);
			for (const headers of [
				cookie("alice"),
				cookie("bob"),
				personalHeaders,
				applicationHeaders,
			]) {
				const own = ScopedPlatformAuditPageV1Schema.parse(
					await read(`/api/v1/audit?action=${row.action}`, headers),
				);
				expect(own.items).toEqual([]);
				const denied = await read(`/api/v1/audit/${row.id}`, headers, 404);
				const missing = await read(
					`/api/v1/audit/${randomUUID()}`,
					headers,
					404,
				);
				expect(denied).toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
				expect(missing).toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
				await read(
					`/api/v3/admin/audit/${row.id}`,
					headers,
					headers === applicationHeaders || headers === personalHeaders
						? 401
						: 404,
				);
			}
		}
		const revokedPersonal = await revokePersonalApiCredentialV2({
			client,
			auth: "session_alice",
			headers: { "Idempotency-Key": randomUUID() },
			path: { credentialId: later.data.metadata.credentialId },
		});
		expect(revokedPersonal.response?.status).toBe(200);
		await read("/api/v1/audit", personalHeaders, 401);
		await sql`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id=${applicationCredentialId}`;
		await read("/api/v1/audit", applicationHeaders, 401);
		for (const value of privateValues)
			expect(logs.join("\n")).not.toContain(value);
	}, 30_000);

	it.each(["revoke", "narrow"] as const)(
		"retains the real failed %s reason without returning private details",
		async (operation) => {
			const client = createClient({ baseUrl: origin });
			const issued = await issuePersonalApiCredentialV2({
				client,
				auth: "session_alice",
				headers: { "Idempotency-Key": randomUUID() },
				body: { scopes: ["agent:use"], expiresAt: null },
			});
			if (!issued.data?.credential) throw new Error("No produced credential");
			privateValues.push(issued.data.credential, hash(issued.data.credential));
			deployment.state.directoryCalls = 0;
			deployment.state.directoryMode = "revision_changed";
			try {
				const request = {
					client,
					auth: "session_alice",
					headers: { "Idempotency-Key": randomUUID() },
					path: { credentialId: issued.data.metadata.credentialId },
				};
				const failed =
					operation === "revoke"
						? await revokePersonalApiCredentialV2(request)
						: await narrowPersonalApiCredentialV2({
								...request,
								body: { expiresAt: "2030-01-01T00:00:00.000Z" },
							});
				expect(failed.response?.status).toBe(503);
			} finally {
				deployment.state.directoryMode = "active";
			}
			const [row] = await sql<
				{ id: string }[]
			>`select id from platform.audit_events
			where target_id=${issued.data.metadata.credentialId} and action=${operation === "revoke" ? "api.credential.revoked" : "api.credential.narrowed"} and outcome='failed'`;
			if (!row) throw new Error("Actual failed credential audit is missing");
			const record = ScopedPlatformAuditProjectionV1Schema.parse(
				await read(`/api/v3/admin/audit/${row.id}`),
			);
			expect(record).toMatchObject({
				result: "failed",
				action:
					operation === "revoke"
						? "api.credential.revoked"
						: "api.credential.narrowed",
				summary: `api.credential.${operation === "revoke" ? "revoked" : "narrowed"}: reason=unavailable`,
				subject: {
					kind: "api_credential",
					subjectId: issued.data.metadata.credentialId,
				},
			});
			for (const field of ["details", "scopes", "expiresAt", "credentialHash"])
				expect(record).not.toHaveProperty(field);
			for (const value of privateValues)
				expect(logs.join("\n")).not.toContain(value);
		},
		30_000,
	);

	it.each(
		[
			null,
			{ scopes: [], expiresAt: null },
			{
				scopes: ["agent:use"],
				expiresAt: null,
				credential: "PRIVATE_HTTP_AUDIT_SENTINEL",
				credentialHash: "PRIVATE_HTTP_HASH_SENTINEL",
			},
		].flatMap((details) =>
			[
				"api.credential.issued",
				"api.credential.revoked",
				"api.credential.narrowed",
			].map((action) => ({ action, details })),
		),
	)(
		"fails closed on malformed durable credential details %j",
		async ({ action, details }) => {
			privateValues.push(
				"PRIVATE_HTTP_AUDIT_SENTINEL",
				"PRIVATE_HTTP_HASH_SENTINEL",
			);
			const id = randomUUID();
			await sql`insert into platform.audit_events(id,trace_id,request_id,actor_type,actor_id,action,target_type,target_id,outcome,details)
				values (${id},'malformed-http',${randomUUID()},'user','malformed-user',${action},'api_credential',${randomUUID()},'succeeded',${sql.json(details)})`;
			try {
				for (const path of [
					`/api/v3/admin/audit/${id}`,
					"/api/v3/admin/audit?principalKind=user&principalId=malformed-user",
				])
					expect(await read(path, cookie("admin"), 503)).toMatchObject({
						code: "DEPENDENCY_UNAVAILABLE",
					});
				for (const value of privateValues)
					expect(logs.join("\n")).not.toContain(value);
			} finally {
				await sql`delete from platform.audit_events where id=${id}`;
			}
		},
	);
});
