import { createHash } from "node:crypto";
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
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import { createClient } from "../../web/src/pilot/generated-v2/client/index.ts";
import {
	issuePersonalApiCredentialV2,
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

async function start() {
	const output = new PassThrough();
	output.on("data", (chunk) => logLines.push(String(chunk)));
	const running = await startPlatformApiFromDeployment({
		moduleSpecifier,
		port: 0,
		log: (line) => logLines.push(line),
		observabilityOptions: { output, otlpEndpoint: undefined },
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
});
