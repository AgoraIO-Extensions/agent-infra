import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import {
	SkillHubOwnedVersionPageV1Schema,
	SkillHubVersionDetailV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	FakeObjectStorageV1,
	packSkillProjectSnapshotV1,
	prepareSkillPackageV1,
	SkillPackageSupplierV1,
	type SkillPackageSupplyInputV1,
} from "@agent-infra/object-storage";
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
	listOwnedSkillHubVersionsV1,
	readSkillHubVersionDetailV1,
} from "../../web/src/pilot/generated-v2/sdk.gen.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";

// 版本详情与本人版本目录（#2904）：真实供应流程写入固定包对象，详情从同一存储有界回读。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 180_000 });
let database: PostgresTestDatabase | undefined;
let sql: ReturnType<typeof postgres>;
let lifecycle: PostgresSkillHubLifecycleV1;
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
const snapshot = (userId: keyof typeof users) => {
	const current = users[userId];
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
};
const trusted = (userId = "owner-a") => ({
	userId,
	requestId: "detail-supplier-request",
	traceId: "detail-supplier-trace",
});
const encoder = new TextEncoder();
const bodyMarker = "Release notes body marker";
const shortArchive = packSkillProjectSnapshotV1([
	{
		path: "SKILL.md",
		bytes: encoder.encode(
			`# notes\n${bodyMarker}\n<script>alert(1)</script>\n`,
		),
	},
	{ path: "scripts/run.sh", bytes: encoder.encode("echo run") },
	{ path: "references/guide.md", bytes: encoder.encode("guide") },
	{ path: "assets/logo.txt", bytes: encoder.encode("logo") },
]);
const longArchive = packSkillProjectSnapshotV1([
	{ path: "SKILL.md", bytes: encoder.encode("x".repeat(70_000)) },
]);
const keys = generateKeyPairSync("ed25519");
const storage = new FakeObjectStorageV1({ contentPolicy: "skill-package" });
const policy = {
	policyRevision: "policy-1",
	maximumReceiptAgeMs: 3_600_000,
	scannerId: "scanner-1",
	engineVersion: "engine-1",
	rulesetDigest: "e".repeat(64),
	signer: { ...keys, keyId: "key-1", trustRevision: "trust-1" },
};
const sourceVerifier = {
	verify: async (selected: {
		provider: string;
		ownerId: string;
		sourceVersion: string;
		sourceDigest: string;
		approvalRef: string | null;
		trustRevision: string;
	}) => ({
		schemaVersion: 1 as const,
		provider: selected.provider,
		publisherId: selected.ownerId,
		sourceVersion: selected.sourceVersion,
		sourceDigest: selected.sourceDigest,
		approvalRef: selected.approvalRef,
		trustRevision: selected.trustRevision,
	}),
};
const scanner = {
	scan: async (selected: {
		packageDigest: string;
		manifestDigest: string;
		fileCount: number;
		totalBytes: number;
		policyRevision: string;
	}) => ({
		schemaVersion: 1 as const,
		scannerId: policy.scannerId,
		engineVersion: policy.engineVersion,
		rulesetDigest: policy.rulesetDigest,
		policyRevision: selected.policyRevision,
		scannedAt: new Date(Date.now() - 1_000).toISOString(),
		expiresAt: new Date(Date.now() + 600_000).toISOString(),
		packageDigest: selected.packageDigest,
		manifestDigest: selected.manifestDigest,
		scannedFileCount: selected.fileCount,
		scannedBytes: selected.totalBytes,
		verdict: "clean" as const,
	}),
};
const supply = (
	skillVersionId: string,
	skillId: string,
	visibility: SkillPackageSupplyInputV1["visibility"],
	version: string,
	archiveBytes = shortArchive,
): SkillPackageSupplyInputV1 => ({
	name: skillId,
	skillId,
	skillVersionId,
	visibility,
	provider: "my_library",
	version,
	sourceVersion: `snapshot-${skillVersionId}`,
	sourceDigest: prepareSkillPackageV1({ archiveBytes, name: skillId, version })
		.packageDigest,
	approvalRef: null,
	trustRevision: "trust-1",
	policyRevision: "policy-1",
	archiveBytes,
});
const fetchAs = (
	path: string,
	userId: string | null = "owner-a",
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
const detailOf = async (versionId: string, userId = "owner-a") => {
	const response = await fetchAs(
		`/api/v2/skills/versions/${versionId}/detail`,
		userId,
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	return SkillHubVersionDetailV1Schema.parse(await response.json());
};

beforeAll(async () => {
	database = await startPostgresTestDatabase("skill-hub-http-version-detail");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
	lifecycle = new PostgresSkillHubLifecycleV1({
		databaseUrl: database.databaseUrl,
		resolveIdentity: async (userId) => snapshot(userId as keyof typeof users),
	});
	const supplier = new SkillPackageSupplierV1({
		storage,
		lifecycle,
		resolveAdmissionPolicy: async () => policy,
		sourceVerifier,
		scanner,
	});
	// owner-a：共享已发布、待审核、已驳回、私有已撤销与超长正文各一；另有一个无包描述的旧登记版本。
	await supplier.admitVersion(
		trusted(),
		supply("notes-v1", "notes", "MARKET", "1.0.0"),
	);
	await lifecycle.reviewVersion(trusted("admin"), "notes-v1", "approve-1", {
		decision: "approve",
	});
	await supplier.admitVersion(
		trusted(),
		supply("notes-v2", "notes", "MARKET", "2.0.0"),
	);
	await supplier.admitVersion(
		trusted(),
		supply("notes-v3", "notes", "MEMBER", "3.0.0"),
	);
	await lifecycle.reviewVersion(trusted("admin"), "notes-v3", "reject-3", {
		decision: "reject",
		reason: "private review text",
	});
	await supplier.admitVersion(
		trusted(),
		supply("draft-v1", "draft", "PRIVATE", "1.0.0"),
	);
	await lifecycle.revokeVersion(trusted(), "draft-v1", "revoke-draft");
	await supplier.admitVersion(
		trusted(),
		supply("long-v1", "long", "MARKET", "1.0.0", longArchive),
	);
	await lifecycle.reviewVersion(trusted("admin"), "long-v1", "approve-long", {
		decision: "approve",
	});
	await lifecycle.registerVersion(trusted(), "register-legacy", {
		schemaVersion: 1,
		name: "legacy",
		skillId: "legacy",
		skillVersionId: "legacy-v1",
		visibility: "PRIVATE",
		provider: "my_library",
		version: "1.0.0",
		packageObjectVersion: "legacy-object",
		packageDigest: "a".repeat(64),
		manifestDigest: "b".repeat(64),
		signatureDigest: "c".repeat(64),
	});
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
		providerImport: {
			registry: { providers: [], discover: async () => [] },
			storage,
			resolveAdmissionPolicy: async () => policy,
			sourceVerifier,
			scanner,
		},
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
	await lifecycle?.close();
	await sql?.end();
	await database?.stop();
});

describe("Skill Hub version detail over HTTP with PostgreSQL", () => {
	it("returns bounded SKILL.md text, the resource list, the publisher and the caller's own installation", async () => {
		const client = createClient({
			baseUrl,
			headers: { cookie: "fixture-user=owner-b" },
		});
		const read = await readSkillHubVersionDetailV1({
			client,
			path: { skillVersionId: "notes-v1" },
		});
		expect(read.response?.status).toBe(200);
		const detail = SkillHubVersionDetailV1Schema.parse(read.data);
		expect(detail).toMatchObject({
			skillVersionId: "notes-v1",
			name: "notes",
			state: "published",
			ownerId: "owner-a",
			installation: { state: "not_installed" },
			content: {
				state: "available",
				body: `# notes\n${bodyMarker}\n<script>alert(1)</script>\n`,
				bodyTruncated: false,
				resources: [
					{ path: "assets/logo.txt", kind: "asset", sizeBytes: 4 },
					{ path: "references/guide.md", kind: "reference", sizeBytes: 5 },
					{ path: "scripts/run.sh", kind: "script", sizeBytes: 8 },
				],
			},
		});
		// 投影不带对象存储版本、对象引用或审核原因。
		const [version] =
			await sql`select package_object_version from platform.skill_hub_versions where id = 'notes-v1'`;
		const text = JSON.stringify(read.data);
		expect(text).not.toContain(String(version?.package_object_version));
		expect(text).not.toMatch(/objectRef|reviewReason|etag/);

		const long = await detailOf("long-v1", "owner-b");
		expect(long.content).toMatchObject({ bodyTruncated: true });
		expect(long.content.state === "available" && long.content.body).toBe(
			"x".repeat(65_536),
		);
		// 旧登记版本没有供应记录：版本信息照常返回，内容标记不可用。
		expect((await detailOf("legacy-v1")).content).toEqual({
			state: "unavailable",
		});
		const audits =
			await sql`select action, details::text as details from platform.audit_events`;
		expect(audits.length).toBeGreaterThan(0);
		expect(JSON.stringify(audits)).not.toMatch(
			new RegExp(`${bodyMarker}|alert\\(1\\)|x{100}`),
		);
	});

	it("re-reads the caller's installation immediately after install and removal", async () => {
		const install = await fetchAs("/api/v2/skills/installations", "owner-b", {
			method: "POST",
			headers: { "Idempotency-Key": "install-detail-b" },
			body: JSON.stringify({
				principalType: "user",
				principalId: "owner-b",
				skillVersionId: "notes-v1",
			}),
		});
		expect(install.status).toBe(201);
		const installationId = (
			(await install.json()) as { installation: { installationId: string } }
		).installation.installationId;
		expect((await detailOf("notes-v1", "owner-b")).installation).toEqual({
			state: "installed",
			installationId,
		});
		// 别人的安装不出现在本人的详情里。
		expect((await detailOf("notes-v1", "owner-a")).installation).toEqual({
			state: "not_installed",
		});
		const removed = await fetchAs(
			`/api/v2/skills/installations/${installationId}`,
			"owner-b",
			{ method: "DELETE", headers: { "Idempotency-Key": "remove-detail-b" } },
		);
		expect(removed.status).toBe(200);
		expect((await detailOf("notes-v1", "owner-b")).installation).toEqual({
			state: "not_installed",
		});
	});

	it("lets only the publisher read pending, rejected and revoked versions and list them", async () => {
		for (const [versionId, state] of [
			["notes-v2", "pending_review"],
			["notes-v3", "rejected"],
			["draft-v1", "revoked"],
		] as const) {
			const detail = await detailOf(versionId);
			expect(detail.state).toBe(state);
			expect(detail.content.state).toBe("available");
			expect(JSON.stringify(detail)).not.toContain("private review text");
		}
		const client = createClient({
			baseUrl,
			headers: { cookie: "fixture-user=owner-a" },
		});
		const first = await listOwnedSkillHubVersionsV1({
			client,
			query: { limit: 3 },
		});
		expect(first.response?.status).toBe(200);
		const page = SkillHubOwnedVersionPageV1Schema.parse(first.data);
		const next = SkillHubOwnedVersionPageV1Schema.parse(
			(
				await listOwnedSkillHubVersionsV1({
					client,
					query: { cursor: page.nextCursor ?? "", limit: 3 },
				})
			).data,
		);
		expect(
			[...page.items, ...next.items].map((item) => [
				item.skillVersionId,
				item.state,
			]),
		).toEqual([
			["draft-v1", "revoked"],
			["legacy-v1", "published"],
			["long-v1", "published"],
			["notes-v1", "published"],
			["notes-v2", "pending_review"],
			["notes-v3", "rejected"],
		]);
		expect(next.nextCursor).toBeNull();
	});

	it("keeps invisible versions indistinguishable from unknown ones for other users and administrators", async () => {
		const unknown = await fetchAs(
			"/api/v2/skills/versions/unknown-version/detail",
			"owner-b",
		);
		expect(unknown.status).toBe(404);
		const unknownBody = (await unknown.json()) as { code: string };
		for (const [userId, versionId] of [
			["owner-b", "notes-v2"],
			["owner-b", "notes-v3"],
			["owner-b", "draft-v1"],
			["owner-b", "legacy-v1"],
			["admin", "notes-v2"],
			["admin", "notes-v3"],
			["admin", "draft-v1"],
		] as const) {
			const response = await fetchAs(
				`/api/v2/skills/versions/${versionId}/detail`,
				userId,
				// 伪造的身份头不改变服务端解析的主体。
				{
					headers: { "x-user-id": "owner-a", "x-agent-infra-user": "owner-a" },
				},
			);
			expect(response.status).toBe(404);
			const body = (await response.json()) as { code: string };
			expect(body.code).toBe(unknownBody.code);
			expect(JSON.stringify(body)).not.toMatch(/notes|draft|legacy/);
		}
		for (const userId of ["owner-b", "admin"] as const) {
			const response = await fetchAs("/api/v2/skills/owned-versions", userId, {
				headers: { "x-user-id": "owner-a" },
			});
			expect(response.status).toBe(200);
			expect(
				SkillHubOwnedVersionPageV1Schema.parse(await response.json()).items,
			).toEqual([]);
		}
	});

	it("refuses unauthenticated, Bearer and malformed requests", async () => {
		for (const path of [
			"/api/v2/skills/owned-versions",
			"/api/v2/skills/versions/notes-v1/detail",
		]) {
			expect((await fetchAs(path, null)).status).toBe(401);
			expect(
				(
					await fetchAs(path, "owner-a", {
						headers: { authorization: "Bearer platform-token" },
					})
				).status,
			).toBe(401);
		}
		for (const path of [
			"/api/v2/skills/owned-versions?owner=owner-b",
			"/api/v2/skills/owned-versions?limit=1&limit=2",
			"/api/v2/skills/owned-versions?limit=101",
			"/api/v2/skills/owned-versions?cursor=..%2Fx",
			"/api/v2/skills/versions/notes-v1/detail?owner=owner-b",
			"/api/v2/skills/versions/..%2Fnotes-v1/detail",
		])
			expect((await fetchAs(path)).status, path).toBe(400);
		const refusals =
			await sql`select count(*)::int as count from platform.audit_events where action = 'skill.version.refused'`;
		expect(refusals[0]?.count).toBeGreaterThanOrEqual(10);
	});
});
