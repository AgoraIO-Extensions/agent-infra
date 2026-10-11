import { once } from "node:events";
import {
	SkillHubDirectoryPageV1Schema,
	SkillHubVersionMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	migratePlatformDatabase,
	PostgresSkillHubLifecycleV1,
} from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createClient } from "../../web/src/pilot/generated-v2/client/index.js";
import {
	listSkillHubVersionsV1,
	readSkillHubVersionV1,
} from "../../web/src/pilot/generated-v2/sdk.gen.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
let database: PostgresTestDatabase | undefined;
let sql: ReturnType<typeof postgres>;
let supplier: PostgresSkillHubLifecycleV1;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof serve>;
let baseUrl: string;
const user = (
	userId: string,
	organizationId: string,
	admin = false,
): IdentityContext => ({
	schemaVersion: 1,
	userId,
	displayName: userId,
	accountStatus: "active",
	organizationIds: [organizationId],
	roles: admin ? ["employee", "system_admin"] : ["employee"],
	authorizationRevision: "identity-1",
});
const users = {
	"owner-a": user("owner-a", "org-a"),
	"owner-b": user("owner-b", "org-b"),
	admin: user("admin", "org-a", true),
};
const currentUser = (request: Request) =>
	users[
		request.headers
			.get("cookie")
			?.match(/fixture-user=([\w-]+)/)?.[1] as keyof typeof users
	] ?? null;
const identity = {
	resolve: vi.fn(
		async (request: Request): Promise<unknown | null> => currentUser(request),
	),
	hydrateUsers: async () => [],
} satisfies IdentityAdapter;
const trusted = (userId = "owner-a") => ({
	userId,
	requestId: "supplier-request",
	traceId: "supplier-trace",
});
const fetchRead = (
	path = "/api/v2/skills",
	userId: string | null = "owner-a",
	extraHeaders: Record<string, string> = {},
) =>
	fetch(`${baseUrl}${path}`, {
		headers: {
			...(userId ? { cookie: `fixture-user=${userId}` } : {}),
			...extraHeaders,
		},
	});
const fetchInstallation = (
	path: string,
	userId: string | null,
	init: RequestInit = {},
) =>
	fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			...(init.body !== undefined
				? { "content-type": "application/json" }
				: {}),
			...(userId ? { cookie: `fixture-user=${userId}` } : {}),
			...(init.headers ?? {}),
		},
	});
const ids = (body: unknown) =>
	SkillHubDirectoryPageV1Schema.parse(body).items.map(
		(item) => item.skillVersionId,
	);

beforeAll(async () => {
	database = await startPostgresTestDatabase("skill-hub-http-read");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
	supplier = new PostgresSkillHubLifecycleV1({
		databaseUrl: database.databaseUrl,
		async resolveIdentity(userId) {
			const current = users[userId as keyof typeof users];
			return {
				actor: {
					schemaVersion: 1,
					userId,
					accountStatus: current.accountStatus,
					organizationIds: current.organizationIds,
					isAdministrator: current.roles.includes("system_admin"),
				},
				authorizationRevision: current.authorizationRevision,
			};
		},
	});
	// Internal supplier fixture only: no public metadata-registration route exists.
	const seeds = [
		["a", "PRIVATE", "owner-a", true],
		["b", "PRIVATE", "owner-b", true],
		["c", "MEMBER", "owner-b", true],
		["d", "ORGANIZATION", "owner-a", true],
		["e", "ORGANIZATION", "owner-b", true],
		["f", "MARKET", "owner-b", true],
		["g", "MARKET", "owner-a", false],
		["h", "PRIVATE", "owner-a", true],
		["i", "MARKET", "owner-a", true],
	] as const;
	for (const [key, visibility, ownerId, approved] of seeds) {
		await supplier.registerVersion(trusted(ownerId), `register-${key}`, {
			schemaVersion: 1,
			name: `skill-${key}`,
			skillId: `skill-${key}`,
			skillVersionId: `version-${key}`,
			visibility,
			provider: "my_library",
			version: "1.0.0",
			packageObjectVersion: `internal-object-${key}`,
			packageDigest: "a".repeat(64),
			manifestDigest: "b".repeat(64),
			signatureDigest: "c".repeat(64),
			...(visibility === "ORGANIZATION"
				? { organizationId: users[ownerId].organizationIds[0] }
				: {}),
		});
		if (visibility !== "PRIVATE" && approved)
			await supplier.reviewVersion(
				trusted("admin"),
				`version-${key}`,
				`approve-${key}`,
				{ decision: "approve" },
			);
	}
	for (const key of ["a", "c", "d", "e", "f"]) {
		const now = new Date();
		await sql`insert into platform.idempotency_records
			(id, scope_type, scope_id, actor_id, command_type, idempotency_key,
			 request_digest, status, result, created_at, updated_at)
			values (${`admission-version-${key}`}, 'skill_package', ${`version-${key}`},
			 'owner-a', 'skill.package.publish.v1', ${`admission-version-${key}`},
			 ${"d".repeat(64)}, 'completed', ${sql.json({ operationId: `admission-version-${key}`, skillVersionId: `version-${key}` })}, ${now}, ${now})`;
	}
	await supplier.revokeVersion(trusted(), "version-i", "revoke-i");
	await sql`update platform.skill_hub_skills set status = 'disabled' where id = 'skill-h'`;
	const unused = async (): Promise<never> => {
		throw new Error("Unused controlled fixture adapter");
	};
	assembly = assemblePlatformApi({
		databaseUrl: database.databaseUrl,
		identity,
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
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
	server = serve({
		fetch: createPlatformApp(assembly.dependencies).fetch,
		hostname: "127.0.0.1",
		port: 0,
	});
	if (!server.listening) await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Test server did not bind");
	baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
	identity.resolve
		.mockReset()
		.mockImplementation(async (request) => currentUser(request));
	await sql`truncate platform.audit_events, platform.platform_user_disables`;
});
afterAll(async () => {
	if (server)
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	await assembly?.close();
	await supplier?.close();
	await sql?.end();
	await database?.stop();
});

describe("Skill Hub authenticated HTTP reads with PostgreSQL", () => {
	it("reads only current visible published versions and resumes bounded pages", async () => {
		const first = await fetchRead("/api/v2/skills?limit=2");
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-store");
		const page = SkillHubDirectoryPageV1Schema.parse(await first.json());
		expect(ids(page)).toEqual(["version-a", "version-c"]);
		expect(page.nextCursor).toBe("version-c");
		const next = await fetchRead(
			`/api/v2/skills?limit=2&cursor=${page.nextCursor}`,
		);
		const second = SkillHubDirectoryPageV1Schema.parse(await next.json());
		expect(ids(second)).toEqual(["version-d", "version-f"]);
		expect(second.nextCursor).toBeNull();
		expect(
			ids(await (await fetchRead("/api/v2/skills", "owner-b")).json()),
		).toEqual(["version-b", "version-c", "version-e", "version-f"]);
	});

	it("allows visible non-owner details and makes invisible, unapproved, revoked, disabled and unknown versions indistinguishable", async () => {
		for (const versionId of ["version-c", "version-d", "version-f"]) {
			const response = await fetchRead(`/api/v2/skills/versions/${versionId}`);
			expect(response.status).toBe(200);
			expect(
				SkillHubVersionMetadataV1Schema.parse(await response.json())
					.skillVersionId,
			).toBe(versionId);
		}
		for (const versionId of [
			"version-b",
			"version-e",
			"version-g",
			"version-h",
			"version-i",
			"unknown-version",
		]) {
			const response = await fetchRead(`/api/v2/skills/versions/${versionId}`);
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({
				code: "RESOURCE_UNAVAILABLE",
			});
		}
		expect(
			(await fetchRead("/api/v2/skills/versions/version-a", "owner-b")).status,
		).toBe(404);
		expect(
			(await fetchRead("/api/v2/skills/versions/version-b", "admin")).status,
		).toBe(200);
	});

	it.each([
		"?userId=owner-b",
		"?organizationId=org-b",
		"?limit=1&limit=2",
		"?cursor=a&cursor=b",
		"?limit=0",
		"?limit=101",
		"?limit=",
		"?cursor=../internal",
	])("rejects forged/ambiguous query %s", async (query) => {
		expect((await fetchRead(`/api/v2/skills${query}`)).status).toBe(400);
		const [row] =
			await sql`select details from platform.audit_events where action = 'skill.version.refused'`;
		expect(row?.details).toEqual({ reason: "invalid_input" });
	});

	it("rejects detail query fields, malformed IDs and ignores forged identity headers", async () => {
		expect(
			(await fetchRead("/api/v2/skills/versions/version-a?userId=owner-b"))
				.status,
		).toBe(400);
		expect((await fetchRead("/api/v2/skills/versions/bad%20id")).status).toBe(
			400,
		);
		expect(
			(
				await fetchRead("/api/v2/skills/versions/version-b", "owner-a", {
					"x-user-id": "owner-b",
					"x-organization-id": "org-b",
					"x-role": "system_admin",
				})
			).status,
		).toBe(404);
	});

	it("refuses unauthenticated and Bearer-only calls with sanitized refusal audits", async () => {
		expect((await fetchRead("/api/v2/skills", null)).status).toBe(401);
		expect(
			(
				await fetchRead("/api/v2/skills", "owner-a", {
					Authorization: "Bearer private-test-sentinel",
				})
			).status,
		).toBe(401);
		const rows =
			await sql`select actor_type, actor_id, details from platform.audit_events`;
		expect(rows).toHaveLength(2);
		expect(
			rows.every(
				(row) => row.actor_type === "unknown" && row.actor_id === "anonymous",
			),
		).toBe(true);
		expect(JSON.stringify(rows)).not.toContain("private-test-sentinel");
	});

	it("checks platform disable facts and rolls back successful reads on authorization revision changes", async () => {
		await sql`insert into platform.platform_user_disables (user_id) values ('owner-a')`;
		expect((await fetchRead()).status).toBe(403);
		await sql`truncate platform.platform_user_disables, platform.audit_events`;
		let calls = 0;
		identity.resolve.mockImplementation(async (request) => {
			calls++;
			return {
				...currentUser(request),
				authorizationRevision: calls >= 3 ? "identity-2" : "identity-1",
			};
		});
		expect((await fetchRead()).status).toBe(503);
		const rows = await sql`select outcome, details from platform.audit_events`;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			outcome: "failed",
			details: { reason: "unavailable" },
		});
	});

	it("fails closed on malformed/dependent identity and includes no internal references or runtime claims in successful responses/audits", async () => {
		identity.resolve.mockResolvedValueOnce({
			...users["owner-a"],
			roles: ["invented_admin"],
		});
		expect((await fetchRead()).status).toBe(503);
		identity.resolve.mockRejectedValueOnce(
			new Error("private-directory-error"),
		);
		expect((await fetchRead()).status).toBe(503);
		const response = await fetchRead("/api/v2/skills/versions/version-a");
		const body = SkillHubVersionMetadataV1Schema.parse(await response.json());
		expect(Object.keys(body).toSorted()).toEqual(
			[
				"schemaVersion",
				"skillId",
				"skillVersionId",
				"name",
				"visibility",
				"provider",
				"version",
				"packageDigest",
				"manifestDigest",
				"signatureDigest",
				"state",
			].toSorted(),
		);
		const rows = await sql`select details from platform.audit_events`;
		expect(JSON.stringify({ body, rows })).not.toMatch(
			/internal-object|packageObjectVersion|ownerId|reviewReason|private-directory-error|installed|synced/,
		);
	});

	it("isolates concurrent authenticated requests in the shared production Store", async () => {
		const results = await Promise.all(
			["owner-a", "owner-b", "owner-a", "owner-b"].map(async (userId) => {
				const response = await fetchRead("/api/v2/skills", userId);
				expect(response.status).toBe(200);
				return ids(await response.json());
			}),
		);
		expect(results).toEqual([
			["version-a", "version-c", "version-d", "version-f"],
			["version-b", "version-c", "version-e", "version-f"],
			["version-a", "version-c", "version-d", "version-f"],
			["version-b", "version-c", "version-e", "version-f"],
		]);
	});

	it("calls both actual endpoints through the generated Browser v2 client", async () => {
		const client = createClient({
			baseUrl,
			headers: { cookie: "fixture-user=owner-a" },
		});
		const directory = await listSkillHubVersionsV1({
			client,
			query: { limit: 2 },
			throwOnError: true,
		});
		expect(directory.data?.items.map((item) => item.skillVersionId)).toEqual([
			"version-a",
			"version-c",
		]);
		const detail = await readSkillHubVersionV1({
			client,
			path: { skillVersionId: "version-c" },
			throwOnError: true,
		});
		expect(detail.data?.skillVersionId).toBe("version-c");
	});

	it("installs and uninstalls through the authenticated idempotent API", async () => {
		const command = {
			principalType: "user",
			principalId: "owner-a",
			skillVersionId: "version-a",
		};
		const headers = { "Idempotency-Key": "install-version-a" };
		const first = await fetchInstallation(
			"/api/v2/skills/installations",
			"owner-a",
			{
				method: "POST",
				headers,
				body: JSON.stringify(command),
			},
		);
		expect(first.status).toBe(201);
		const installed = (await first.json()) as {
			replayed: boolean;
			installation: { installationId: string; state: string };
		};
		expect(installed.replayed).toBe(false);
		expect(installed.installation.state).toBe("installed");

		const replay = await fetchInstallation(
			"/api/v2/skills/installations",
			"owner-a",
			{
				method: "POST",
				headers,
				body: JSON.stringify(command),
			},
		);
		expect(replay.status).toBe(200);
		expect(
			(
				(await replay.json()) as {
					installation: { installationId: string };
				}
			).installation.installationId,
		).toBe(installed.installation.installationId);

		const conflict = await fetchInstallation(
			"/api/v2/skills/installations",
			"owner-a",
			{
				method: "POST",
				headers: { "Idempotency-Key": "install-version-a-again" },
				body: JSON.stringify(command),
			},
		);
		expect(conflict.status).toBe(409);
		expect(((await conflict.json()) as { code: string }).code).toBe(
			"INVALID_REQUEST",
		);

		const crossPrincipal = await fetchInstallation(
			"/api/v2/skills/installations",
			"owner-b",
			{
				method: "POST",
				headers: { "Idempotency-Key": "install-private-a-as-b" },
				body: JSON.stringify({ ...command, principalId: "owner-b" }),
			},
		);
		expect(crossPrincipal.status).toBe(404);

		const removed = await fetchInstallation(
			`/api/v2/skills/installations/${installed.installation.installationId}`,
			"owner-a",
			{
				method: "DELETE",
				headers: { "Idempotency-Key": "uninstall-version-a" },
			},
		);
		expect(removed.status).toBe(200);
		expect(
			((await removed.json()) as { installation: { state: string } })
				.installation.state,
		).toBe("uninstalled");
		expect(
			(
				await fetchInstallation("/api/v2/skills/installations", null, {
					method: "POST",
					headers: { "Idempotency-Key": "unauthenticated-install" },
					body: JSON.stringify(command),
				})
			).status,
		).toBe(401);
	});
});
