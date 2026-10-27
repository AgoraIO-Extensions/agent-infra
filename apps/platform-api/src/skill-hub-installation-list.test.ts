import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import {
	PlatformAuditProjectionV2Schema,
	ScopedPlatformAuditPageV1Schema,
	ScopedPlatformAuditPageV2Schema,
	ScopedPlatformAuditProjectionV1Schema,
	ScopedPlatformAuditProjectionV2Schema,
	SkillHubInstallationPageV1Schema,
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
import { listSkillHubInstallationsV1 } from "../../web/src/pilot/generated-v2/sdk.gen.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";

// 「我的安装」（#2953）：真实供应流程产生可安装版本，列表只按会话主体回读本人有效安装。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 180_000 });
let database: PostgresTestDatabase | undefined;
let sql: ReturnType<typeof postgres>;
let lifecycle: PostgresSkillHubLifecycleV1;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof serve>;
let baseUrl: string;
const user = (
	userId: string,
	organizationIds: string[],
	admin = false,
): IdentityContext => ({
	schemaVersion: 1,
	userId,
	displayName: userId,
	accountStatus: "active",
	organizationIds,
	roles: admin ? ["employee", "system_admin"] : ["employee"],
	authorizationRevision: "identity-1",
});
const initialUsers = () => ({
	"owner-a": user("owner-a", ["org-a"]),
	"member-a": user("member-a", ["org-a"]),
	"member-b": user("member-b", ["org-b"]),
	admin: user("admin", ["org-a"], true),
});
let users: Record<string, IdentityContext> = initialUsers();
const currentUser = (request: Request) =>
	users[
		request.headers.get("cookie")?.match(/fixture-user=([\w-]+)/)?.[1] ?? ""
	] ?? null;
const identity = {
	resolve: vi.fn(
		async (request: Request): Promise<unknown | null> => currentUser(request),
	),
	hydrateUsers: async () => [],
	resolveUser: async (userId: string) => {
		const current = users[userId];
		return current
			? {
					schemaVersion: 1 as const,
					userId,
					accountStatus: current.accountStatus,
					organizationIds: current.organizationIds,
					authorizationRevision: current.authorizationRevision,
				}
			: null;
	},
} satisfies IdentityAdapter;
const snapshot = (userId: string) => {
	const current = users[userId];
	if (!current) return null;
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
	requestId: "installation-list-request",
	traceId: "installation-list-trace",
});
const encoder = new TextEncoder();
const archive = packSkillProjectSnapshotV1([
	{ path: "SKILL.md", bytes: encoder.encode("# installed skill\n") },
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
		admissionDecision: "pending_review" as const,
		admissionEvidence: {
			coverage: "complete" as const,
			findings: [],
			dynamicProbe: { required: false, completed: true, violations: [] },
		},
	}),
};
const supply = (
	skillId: string,
	visibility: SkillPackageSupplyInputV1["visibility"],
): SkillPackageSupplyInputV1 => ({
	name: skillId,
	skillId,
	skillVersionId: `${skillId}-v1`,
	visibility,
	provider: "my_library",
	version: "1.0.0",
	sourceVersion: `snapshot-${skillId}`,
	sourceDigest: prepareSkillPackageV1({
		archiveBytes: archive,
		name: skillId,
		version: "1.0.0",
	}).packageDigest,
	approvalRef: null,
	trustRevision: "trust-1",
	policyRevision: "policy-1",
	archiveBytes: archive,
});
const fetchAs = (
	path: string,
	userId: string | null = "member-a",
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
const install = async (
	userId: string,
	skillVersionId: string,
	principalType: "user" | "organization" = "user",
	principalId = userId,
) => {
	const response = await fetchAs("/api/v2/skills/installations", userId, {
		method: "POST",
		headers: {
			"Idempotency-Key": `install-${userId}-${principalType}-${skillVersionId}`,
		},
		body: JSON.stringify({ principalType, principalId, skillVersionId }),
	});
	expect(response.status).toBe(201);
	return (
		(await response.json()) as { installation: { installationId: string } }
	).installation.installationId;
};
const listAll = async (userId = "member-a") => {
	const response = await fetchAs("/api/v2/skills/installations", userId);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	return SkillHubInstallationPageV1Schema.parse(await response.json());
};

beforeAll(async () => {
	database = await startPostgresTestDatabase(
		"skill-hub-http-installation-list",
	);
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
	lifecycle = new PostgresSkillHubLifecycleV1({
		databaseUrl: database.databaseUrl,
		resolveIdentity: async (userId) => snapshot(userId),
	});
	const supplier = new SkillPackageSupplierV1({
		storage,
		lifecycle,
		resolveAdmissionPolicy: async () => policy,
		sourceVerifier,
		scanner,
	});
	// owner-a：内部市场与全体成员版本经管理员批准；另有一个私有版本。
	for (const [skillId, visibility] of [
		["notes", "MARKET"],
		["digest", "MEMBER"],
		["draft", "PRIVATE"],
	] as const) {
		await supplier.admitVersion(trusted(), supply(skillId, visibility));
		if (visibility !== "PRIVATE")
			await lifecycle.reviewVersion(
				trusted("admin"),
				`${skillId}-v1`,
				`approve-${skillId}`,
				{ decision: "approve" },
			);
	}
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
	users = initialUsers();
	identity.resolve
		.mockReset()
		.mockImplementation(async (request) => currentUser(request));
	await sql`truncate platform.skill_hub_installations, platform.audit_events, platform.platform_user_disables`;
	await sql`delete from platform.idempotency_records where scope_type = 'skill_installation'`;
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

describe("Skill Hub installation list over HTTP with PostgreSQL (#2953)", () => {
	it("pages the caller's installed versions and re-reads the list after removal", async () => {
		const notes = await install("member-a", "notes-v1");
		const digest = await install("member-a", "digest-v1");
		const client = createClient({
			baseUrl,
			headers: { cookie: "fixture-user=member-a" },
		});
		const first = await listSkillHubInstallationsV1({
			client,
			query: { limit: 1 },
		});
		expect(first.response?.status).toBe(200);
		const page = SkillHubInstallationPageV1Schema.parse(first.data);
		expect(page.items).toHaveLength(1);
		const next = SkillHubInstallationPageV1Schema.parse(
			(
				await listSkillHubInstallationsV1({
					client,
					query: { cursor: page.nextCursor ?? "", limit: 1 },
				})
			).data,
		);
		const items = [...page.items, ...next.items];
		expect(items.map((item) => item.installationId).toSorted()).toEqual(
			[notes, digest].toSorted(),
		);
		expect(items.find((item) => item.installationId === notes)).toMatchObject({
			skillVersionId: "notes-v1",
			needUpgrade: false,
			version: {
				access: "visible",
				skillId: "notes",
				name: "notes",
				version: "1.0.0",
				provider: "my_library",
				visibility: "MARKET",
				state: "published",
			},
		});
		// 投影不带主体、对象存储版本或摘要。
		const [stored] =
			await sql`select package_object_version, package_digest from platform.skill_hub_versions where id = 'notes-v1'`;
		const text = JSON.stringify(items);
		expect(text).not.toContain(String(stored?.package_object_version));
		expect(text).not.toContain(String(stored?.package_digest));
		expect(text).not.toMatch(/principal|member-a|objectRef|etag/);

		const removed = await fetchAs(
			`/api/v2/skills/installations/${digest}`,
			"member-a",
			{ method: "DELETE", headers: { "Idempotency-Key": "remove-digest" } },
		);
		expect(removed.status).toBe(200);
		expect((await listAll()).items.map((item) => item.installationId)).toEqual([
			notes,
		]);
		const audits =
			await sql`select details from platform.audit_events where action = 'skill.installations.read' order by occurred_at`;
		expect(audits.map((row) => row.details)).toEqual([
			{ count: 1 },
			{ count: 1 },
			{ count: 1 },
		]);
	});

	it("never lists other principals and ignores forged identity fields", async () => {
		const own = await install("member-a", "notes-v1");
		const other = await install("member-b", "notes-v1");
		await install("member-a", "digest-v1", "organization", "org-a");
		const forged = await fetchAs("/api/v2/skills/installations", "member-a", {
			headers: { "x-user-id": "member-b", "x-agent-infra-user": "member-b" },
		});
		expect(forged.status).toBe(200);
		expect(
			SkillHubInstallationPageV1Schema.parse(await forged.json()).items.map(
				(item) => item.installationId,
			),
		).toEqual([own]);
		expect(
			(await listAll("member-b")).items.map((i) => i.installationId),
		).toEqual([other]);
		// 管理员也只看到自己的安装。
		expect((await listAll("admin")).items).toEqual([]);
		// 移除他人安装与不存在一样返回 404，原安装保持不变。
		const crossUser = await fetchAs(
			`/api/v2/skills/installations/${own}`,
			"member-b",
			{ method: "DELETE", headers: { "Idempotency-Key": "remove-cross-user" } },
		);
		expect(crossUser.status).toBe(404);
		expect((await listAll()).items.map((item) => item.installationId)).toEqual([
			own,
		]);
	});

	it("keeps an installation listed without its name once the caller can no longer view the version", async () => {
		await install("member-a", "notes-v1");
		await install("owner-a", "draft-v1");
		await lifecycle.revokeVersion(trusted(), "notes-v1", "revoke-notes");
		const installerView = await listAll();
		expect(installerView.items).toHaveLength(1);
		expect(installerView.items[0]?.version).toEqual({ access: "unavailable" });
		expect(JSON.stringify(installerView)).not.toMatch(/"notes"|1\.0\.0/);
		// 发布者本人仍能读到自己被撤销的版本。
		await lifecycle.revokeVersion(trusted(), "draft-v1", "revoke-draft");
		expect((await listAll("owner-a")).items[0]?.version).toMatchObject({
			access: "visible",
			name: "draft",
			state: "revoked",
		});
	});

	it("reads original anonymous Skill refusals in legacy V2 and scoped administrator audit", async () => {
		const path = "/api/v2/skills/installations";
		expect((await fetchAs(path, null)).status).toBe(401);
		expect(
			(
				await fetchAs(path, "member-a", {
					headers: { authorization: "Bearer platform-token" },
				})
			).status,
		).toBe(401);
		const originals =
			await sql`select * from platform.audit_events where action = 'skill.version.refused' order by id`;
		expect(originals).toHaveLength(2);
		expect(
			originals.every(
				(row) => row.actor_type === "unknown" && row.actor_id === "anonymous",
			),
		).toBe(true);
		for (const base of [
			"/api/v2/admin/audit",
			"/api/v3/admin/audit",
			"/api/v4/admin/audit",
		]) {
			const pageSchema =
				base === "/api/v2/admin/audit"
					? ScopedPlatformAuditPageV1Schema.extend({
							items: PlatformAuditProjectionV2Schema.array(),
						})
					: base === "/api/v3/admin/audit"
						? ScopedPlatformAuditPageV1Schema
						: ScopedPlatformAuditPageV2Schema;
			const unfiltered = await fetchAs(`${base}?limit=100`, "admin");
			expect(unfiltered.status, `${base} default`).toBe(200);
			const unfilteredPage = pageSchema.parse(await unfiltered.json());
			expect(
				unfilteredPage.items
					.filter((item: { auditId: string }) =>
						originals.some((row) => row.id === item.auditId),
					)
					.map((item: { auditId: string }) => item.auditId)
					.toSorted(),
			).toEqual(originals.map((row) => row.id));
			let cursor: string | null = null;
			const ids: string[] = [];
			do {
				const response = await fetchAs(
					`${base}?${new URLSearchParams({ limit: "1", ...(base === "/api/v2/admin/audit" ? {} : { action: "skill.version.refused" }), ...(cursor ? { cursor } : {}) })}`,
					"admin",
				);
				expect(response.status, base).toBe(200);
				const page = pageSchema.parse(await response.json());
				expect(page.items).toHaveLength(1);
				for (const item of page.items) {
					expect(item.actor).toMatchObject({
						kind: "unknown",
						actorId: "unknown",
					});
					ids.push(item.auditId);
				}
				cursor = page.nextCursor;
				expect(ids.length).toBeLessThanOrEqual(2);
			} while (cursor);
			expect(ids.toSorted()).toEqual(originals.map((row) => row.id));
			if (base !== "/api/v2/admin/audit") {
				const detailSchema =
					base === "/api/v3/admin/audit"
						? ScopedPlatformAuditProjectionV1Schema
						: ScopedPlatformAuditProjectionV2Schema;
				for (const row of originals) {
					const response = await fetchAs(`${base}/${row.id}`, "admin");
					expect(response.status, `${base} detail`).toBe(200);
					expect(detailSchema.parse(await response.json()).actor).toMatchObject(
						{
							kind: "unknown",
							actorId: "unknown",
						},
					);
				}
			}
		}
		for (const row of originals) {
			expect(
				(await fetchAs(`/api/v3/admin/audit/${row.id}`, "member-a")).status,
			).toBe(404);
			expect(
				(await fetchAs(`/api/v2/audit/${row.id}`, "member-a")).status,
			).toBe(404);
		}
		expect(
			await sql`select * from platform.audit_events where id = any(${originals.map((row) => row.id)}::text[]) order by id`,
		).toEqual(originals);
	});

	it("refuses unauthenticated, Bearer and malformed requests", async () => {
		const path = "/api/v2/skills/installations";
		expect((await fetchAs(path, null)).status).toBe(401);
		expect(
			(
				await fetchAs(path, "member-a", {
					headers: { authorization: "Bearer platform-token" },
				})
			).status,
		).toBe(401);
		for (const query of [
			"?principalId=member-b",
			"?principalType=organization",
			"?limit=1&limit=2",
			"?limit=0",
			"?limit=101",
			"?limit=abc",
			"?cursor=..%2Fx",
		])
			expect((await fetchAs(`${path}${query}`)).status, query).toBe(400);
		// 未进入 Store 的拒绝由路由写拒绝审计，进入 Store 后的拒绝由事务写入；都不算成功读取。
		const refusals =
			await sql`select details from platform.audit_events where action = 'skill.version.refused'`;
		expect(refusals.length).toBeGreaterThanOrEqual(9);
		expect(
			await sql`select 1 from platform.audit_events where action = 'skill.installations.read'`,
		).toHaveLength(0);
	});
});
