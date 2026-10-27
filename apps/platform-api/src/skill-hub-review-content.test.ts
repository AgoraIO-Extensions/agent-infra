import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import {
	PilotProtocolErrorV1Schema,
	SkillHubReviewContentV1Schema,
	SkillHubReviewQueuePageV1Schema,
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
	afterEach,
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
import { readSkillHubReviewContentV1 } from "../../web/src/pilot/generated-v2/sdk.gen.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";

// 审核正文（#3046）：系统管理员读取他人待审版本的 SKILL.md；真实供应流程写入固定包对象，
// 正文沿版本详情的同一读取与截断规则回读。
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
	// 发布者与同组织成员都不是系统管理员。
	"owner-a": user("owner-a", "org-a"),
	"member-a": user("member-a", "org-a"),
	"owner-b": user("owner-b", "org-b"),
	// 系统管理员不限组织：org-b 的管理员审核 org-a 的组织共享版本。
	admin: user("admin", "org-b", true),
	"admin-a": user("admin-a", "org-a", true),
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
	requestId: "review-content-request",
	traceId: "review-content-trace",
});
const encoder = new TextEncoder();
const bodyMarker = "Review body marker 7f3c";
const shortBody = `# notes\n${bodyMarker}\n<script>alert(1)</script>\n`;
const shortArchive = packSkillProjectSnapshotV1([
	{ path: "SKILL.md", bytes: encoder.encode(shortBody) },
	{ path: "scripts/run.sh", bytes: encoder.encode("echo run") },
	{ path: "references/guide.md", bytes: encoder.encode("guide") },
	{ path: "assets/logo.txt", bytes: encoder.encode("logo") },
]);
const longArchive = packSkillProjectSnapshotV1([
	{ path: "SKILL.md", bytes: encoder.encode("y".repeat(70_000)) },
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
	...(visibility === "ORGANIZATION" ? { organizationId: "org-a" } : {}),
});
const contentPath = (versionId: string) =>
	`/api/v2/skills/reviews/${versionId}/content`;
const fetchAs = (
	path: string,
	userId: string | null = "admin",
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
const contentOf = async (versionId: string, userId = "admin") => {
	const response = await fetchAs(contentPath(versionId), userId);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	return SkillHubReviewContentV1Schema.parse(await response.json());
};
// 遥测：HTTP 中间件记录的全部事件；日志：进程内全部 console 与标准输出写入。
const telemetry: unknown[] = [];
const logged: string[] = [];

beforeAll(async () => {
	database = await startPostgresTestDatabase("skill-hub-http-review-content");
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
	// owner-a：已发布、待审核、已驳回、已撤销、组织共享待审、超长正文待审、私有与失去目标组织的版本；
	// admin-a 有一个自己的待审版本；另有一个无包描述的旧登记待审版本。
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
		supply("gone-v1", "gone", "MARKET", "1.0.0"),
	);
	await lifecycle.reviewVersion(trusted("admin"), "gone-v1", "approve-gone", {
		decision: "approve",
	});
	await lifecycle.revokeVersion(trusted(), "gone-v1", "revoke-gone");
	await supplier.admitVersion(
		trusted(),
		supply("team-v1", "team", "ORGANIZATION", "1.0.0"),
	);
	await supplier.admitVersion(
		trusted(),
		supply("long-v1", "long", "MARKET", "1.0.0", longArchive),
	);
	await supplier.admitVersion(
		trusted(),
		supply("draft-v1", "draft", "PRIVATE", "1.0.0"),
	);
	await supplier.admitVersion(
		trusted(),
		supply("orphan-v1", "orphan", "ORGANIZATION", "1.0.0"),
	);
	await supplier.admitVersion(
		trusted(),
		supply("flip-v1", "flip", "MEMBER", "1.0.0"),
	);
	await supplier.admitVersion(
		trusted("admin-a"),
		supply("own-v1", "own", "MEMBER", "1.0.0"),
	);
	await lifecycle.registerVersion(trusted(), "register-legacy", {
		schemaVersion: 1,
		name: "legacy",
		skillId: "legacy",
		skillVersionId: "legacy-v1",
		visibility: "MARKET",
		provider: "my_library",
		version: "1.0.0",
		packageObjectVersion: "legacy-object",
		packageDigest: "a".repeat(64),
		manifestDigest: "b".repeat(64),
		signatureDigest: "c".repeat(64),
	});
	// ORGANIZATION 版本失去目标组织后不在审核队列中。
	await sql`update platform.skill_hub_skills set organization_id = null where id = 'orphan'`;
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
		fetch: createPlatformApp(assembly.dependencies, {
			record: (event) => telemetry.push(event),
			status: () => ({
				enabled: true,
				state: "active" as const,
				captureFailures: 0,
				exportFailures: 0,
				lastExportFailureAt: undefined,
				droppedLogs: 0,
				invalidRecords: 0,
			}),
		}).fetch,
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
	telemetry.length = 0;
	logged.length = 0;
	const capture =
		(original: (...values: never[]) => unknown) =>
		(...values: unknown[]) => {
			logged.push(values.map(String).join(" "));
			return original(...(values as never[]));
		};
	for (const method of ["log", "info", "warn", "error", "debug"] as const)
		vi.spyOn(console, method).mockImplementation(
			capture(console[method].bind(console)),
		);
	for (const stream of [process.stdout, process.stderr])
		vi.spyOn(stream, "write").mockImplementation(
			capture(stream.write.bind(stream) as never) as never,
		);
});
afterEach(() => {
	vi.restoreAllMocks();
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

/** 正文、对象位置与审核原因都不能出现在审计、日志与遥测中。 */
async function expectNoContentLeak() {
	const audits =
		await sql`select action, target_id, details::text as details from platform.audit_events`;
	const [object] =
		await sql`select package_object_version from platform.skill_hub_versions where id = 'notes-v2'`;
	for (const [label, text] of [
		["audit", JSON.stringify(audits)],
		["log", logged.join("\n")],
		["telemetry", JSON.stringify(telemetry)],
	] as const) {
		expect(text, label).not.toMatch(
			new RegExp(`${bodyMarker}|alert\\(1\\)|echo run|y{100}`),
		);
		expect(text, label).not.toContain(String(object?.package_object_version));
		expect(text, label).not.toContain("private review text");
	}
}

describe("Skill Hub review content over HTTP with PostgreSQL", () => {
	it("returns another publisher's pending SKILL.md as bounded text with the resource list to a system administrator", async () => {
		const client = createClient({
			baseUrl,
			headers: { cookie: "fixture-user=admin" },
		});
		const read = await readSkillHubReviewContentV1({
			client,
			path: { skillVersionId: "notes-v2" },
		});
		expect(read.response?.status).toBe(200);
		expect(read.response?.headers.get("cache-control")).toBe("no-store");
		expect(SkillHubReviewContentV1Schema.parse(read.data)).toEqual({
			schemaVersion: 1,
			skillVersionId: "notes-v2",
			content: {
				state: "available",
				// 正文原样作为文本返回，不解析 Markdown 或 HTML。
				body: shortBody,
				bodyTruncated: false,
				resources: [
					{ path: "assets/logo.txt", kind: "asset", sizeBytes: 4 },
					{ path: "references/guide.md", kind: "reference", sizeBytes: 5 },
					{ path: "scripts/run.sh", kind: "script", sizeBytes: 8 },
				],
			},
		});
		// 投影不带对象存储版本、发布者、安装状态或审核原因。
		const [version] =
			await sql`select package_object_version from platform.skill_hub_versions where id = 'notes-v2'`;
		const text = JSON.stringify(read.data);
		expect(text).not.toContain(String(version?.package_object_version));
		expect(text).not.toMatch(
			/objectRef|reviewReason|etag|owner-a|installation/,
		);

		// org-b 的系统管理员也能读取 org-a 的组织共享待审版本。
		expect((await contentOf("team-v1")).content).toMatchObject({
			state: "available",
			body: shortBody,
		});
		// 64 KiB 上限与截断标记沿用版本详情。
		const long = await contentOf("long-v1");
		expect(long.content).toMatchObject({ bodyTruncated: true });
		expect(long.content.state === "available" && long.content.body).toBe(
			"y".repeat(65_536),
		);
		// 旧登记版本没有供应记录：内容标记不可用。
		expect((await contentOf("legacy-v1")).content).toEqual({
			state: "unavailable",
		});
		// 系统管理员也能读取其他管理员发布的待审版本。
		expect((await contentOf("own-v1")).content.state).toBe("available");

		// 审计只记版本 ID 与状态，正文不进入审计、日志与遥测。
		const reads =
			await sql`select target_id, outcome, details from platform.audit_events where action = 'skill.version.read' order by occurred_at`;
		expect(reads.map((row) => row.target_id)).toEqual([
			"notes-v2",
			"team-v1",
			"long-v1",
			"legacy-v1",
			"own-v1",
		]);
		for (const row of reads)
			expect(row).toMatchObject({
				outcome: "succeeded",
				details: { state: "pending_review", replayed: false },
			});
		expect(telemetry.length).toBeGreaterThanOrEqual(5);
		await expectNoContentLeak();
	});

	it("keeps SKILL.md out of the review queue projection", async () => {
		const response = await fetchAs("/api/v2/skills/reviews");
		expect(response.status).toBe(200);
		const page = SkillHubReviewQueuePageV1Schema.parse(await response.json());
		expect(page.items.map((item) => item.skillVersionId)).toEqual(
			expect.arrayContaining(["notes-v2", "team-v1", "long-v1", "own-v1"]),
		);
		expect(JSON.stringify(page)).not.toMatch(
			new RegExp(`${bodyMarker}|alert\\(1\\)|y{100}|scripts/run.sh`),
		);
		await expectNoContentLeak();
	});

	it("refuses members across users and organizations, ignoring forged identity headers", async () => {
		const forged = {
			"x-user-id": "admin",
			"x-agent-infra-user": "admin",
			"x-agent-infra-roles": "system_admin",
		};
		const unknown = await fetchAs(contentPath("unknown-version"), "owner-b");
		expect(unknown.status).toBe(403);
		const unknownCode = PilotProtocolErrorV1Schema.parse(
			await unknown.json(),
		).code;
		// 发布者本人、同组织成员与其他组织成员都不是系统管理员：一律拒绝，与版本是否存在无关。
		for (const userId of ["owner-a", "member-a", "owner-b"] as const)
			for (const versionId of ["notes-v2", "team-v1", "notes-v1"]) {
				const response = await fetchAs(contentPath(versionId), userId, {
					headers: forged,
				});
				expect(response.status, `${userId} ${versionId}`).toBe(403);
				const body = PilotProtocolErrorV1Schema.parse(await response.json());
				expect(body.code).toBe(unknownCode);
				expect(JSON.stringify(body)).not.toMatch(/notes|team|Review body/);
			}
		// 伪造的身份头不能冒充系统管理员：没有会话时仍要求认证。
		expect(
			(await fetchAs(contentPath("notes-v2"), null, { headers: forged }))
				.status,
		).toBe(401);
		const refusals =
			await sql`select outcome, details from platform.audit_events where action = 'skill.version.refused'`;
		expect(refusals.length).toBeGreaterThanOrEqual(10);
		for (const refusal of refusals.filter(
			(row) =>
				(row.details as { reason: string }).reason !==
				"authentication_required",
		))
			expect(refusal).toMatchObject({
				outcome: "rejected",
				details: { reason: "forbidden" },
			});
		expect(
			await sql`select 1 from platform.audit_events where action = 'skill.version.read'`,
		).toHaveLength(0);
		await expectNoContentLeak();
	});

	it("keeps handled, own, private, orphaned and unknown versions indistinguishable for administrators", async () => {
		const unknown = await fetchAs(contentPath("unknown-version"));
		expect(unknown.status).toBe(404);
		const unknownCode = PilotProtocolErrorV1Schema.parse(
			await unknown.json(),
		).code;
		for (const [userId, versionId] of [
			// 已批准、已驳回、已撤销。
			["admin", "notes-v1"],
			["admin", "notes-v3"],
			["admin", "gone-v1"],
			// 私有版本不经审核；失去目标组织的 ORGANIZATION 版本不在队列中。
			["admin", "draft-v1"],
			["admin", "orphan-v1"],
			// 审核入口对本人发布的版本拒绝，发布者本人改走版本详情。
			["admin-a", "own-v1"],
		] as const) {
			const response = await fetchAs(contentPath(versionId), userId);
			expect(response.status, `${userId} ${versionId}`).toBe(404);
			const body = PilotProtocolErrorV1Schema.parse(await response.json());
			expect(body.code).toBe(unknownCode);
			expect(JSON.stringify(body)).not.toMatch(
				/notes|gone|draft|orphan|own|Review body/,
			);
		}
		// 读取后版本被审核：同一入口随即不可读。
		expect((await contentOf("flip-v1")).content.state).toBe("available");
		await lifecycle.reviewVersion(trusted("admin"), "flip-v1", "approve-flip", {
			decision: "approve",
		});
		expect((await fetchAs(contentPath("flip-v1"))).status).toBe(404);
		const refusals =
			await sql`select target_id, outcome, details from platform.audit_events where action = 'skill.version.refused'`;
		expect(refusals).toHaveLength(8);
		for (const refusal of refusals)
			expect(refusal).toMatchObject({
				target_id: "unknown",
				outcome: "rejected",
				details: { reason: "not_found" },
			});
		await expectNoContentLeak();
	});

	it("refuses unauthenticated, Bearer and malformed requests", async () => {
		expect((await fetchAs(contentPath("notes-v2"), null)).status).toBe(401);
		expect(
			(
				await fetchAs(contentPath("notes-v2"), "admin", {
					headers: { authorization: "Bearer platform-token" },
				})
			).status,
		).toBe(401);
		for (const path of [
			`${contentPath("notes-v2")}?owner=owner-b`,
			`${contentPath("notes-v2")}?limit=1`,
			"/api/v2/skills/reviews/..%2Fnotes-v2/content",
		])
			expect((await fetchAs(path)).status, path).toBe(400);
		const refusals =
			await sql`select count(*)::int as count from platform.audit_events where action = 'skill.version.refused'`;
		expect(refusals[0]?.count).toBeGreaterThanOrEqual(5);
		expect(
			await sql`select 1 from platform.audit_events where action = 'skill.version.read'`,
		).toHaveLength(0);
	});
});
