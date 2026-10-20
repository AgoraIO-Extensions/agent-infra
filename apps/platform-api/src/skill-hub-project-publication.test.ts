import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SkillHubProjectContentSaveResponseV1Schema,
	SkillHubProjectContentV1Schema,
	SkillHubPublicationResponseV1Schema,
	SkillHubReviewQueuePageV1Schema,
	SkillHubVersionDetailV1Schema,
	SkillHubVersionMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	FakeObjectStorageV1,
	SkillPackageAdmissionErrorV1,
} from "@agent-infra/object-storage";
import {
	parseSkillPackagePublicationStateV1,
	type SkillPackagePublicationObjectV1,
} from "@agent-infra/platform-core";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
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
	publishSkillHubProjectVersionV1,
	readSkillHubProjectContentV1,
	saveSkillHubProjectContentV1,
} from "../../web/src/pilot/generated-v2/sdk.gen.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";

// 网页编辑并发布 Skill 项目（#2906）：服务端打包、扫描、签名并固定对象版本，浏览器只提交内容。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
let database: PostgresTestDatabase | undefined;
let sql: ReturnType<typeof postgres>;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let scratch: string;
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
let users: Record<string, IdentityContext>;
const resetUsers = () => {
	users = {
		"owner-a": user("owner-a", ["org-a"]),
		"owner-b": user("owner-b", ["org-b"]),
		// 与 owner-a 同组织的普通成员：组织共享不授予编辑或发布他人项目的权限。
		"member-a": user("member-a", ["org-a"]),
		admin: user("admin", ["org-a"], true),
	};
};
resetUsers();
const currentUser = (request: Request) =>
	users[
		request.headers.get("cookie")?.match(/fixture-user=([\w-]+)/)?.[1] ?? ""
	] ?? null;
const identity = {
	resolve: vi.fn(
		async (request: Request): Promise<unknown | null> => currentUser(request),
	),
	hydrateUsers: async () => [],
} satisfies IdentityAdapter;
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
const infected = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE";
const scanner = {
	scan: async (selected: {
		packageDigest: string;
		manifestDigest: string;
		fileCount: number;
		totalBytes: number;
		policyRevision: string;
		openPackage: () => Promise<ReadableStream<Uint8Array>>;
	}) => {
		// 受控扫描器读取实际包字节，发现测试特征时拒绝。
		const bytes = Buffer.from(
			await new Response(await selected.openPackage()).arrayBuffer(),
		);
		if (bytes.includes(Buffer.from(infected)))
			throw new SkillPackageAdmissionErrorV1("scan_rejected");
		return {
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
		};
	},
};
// 部署的外部来源校验器不参与网页项目发布；被调用即测试失败。
const deploymentSourceVerifier = {
	verify: vi.fn(async (): Promise<never> => {
		throw new Error("deployment verifier must not prove project sources");
	}),
};
const bodyMarker = "Web edited skill body marker";
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
const json = (method: string, key: string, body: unknown) => ({
	method,
	headers: { "Idempotency-Key": key },
	body: JSON.stringify(body),
});
let projectCounter = 0;
async function createProject(organizationId?: string, userId = "owner-a") {
	projectCounter += 1;
	const response = await fetchAs(
		"/api/v2/skills/projects",
		userId,
		json("POST", `create-${projectCounter}`, {
			schemaVersion: 1,
			name: `notes-${projectCounter}`,
			...(organizationId ? { organizationId } : {}),
		}),
	);
	expect(response.status).toBe(201);
	return ((await response.json()) as { projectId: string }).projectId;
}
const files = (body = `# notes\n${bodyMarker}\n`, marker = "") => [
	{ path: "SKILL.md", encoding: "utf8", content: body },
	{
		path: "scripts/run.sh",
		encoding: "utf8",
		// 若脚本被执行会留下标记文件；平台只打包，不执行。
		content: `#!/bin/sh\ntouch '${marker || "/nonexistent/marker"}'\n`,
	},
	{ path: "references/guide.md", encoding: "utf8", content: "guide\n" },
	{ path: "assets/logo.png", encoding: "base64", content: "iVBORw0KGgo=" },
];
async function save(
	projectId: string,
	baseRevision: number,
	content = files(),
	key = `save-${projectId}-${baseRevision}`,
	userId = "owner-a",
) {
	return fetchAs(
		`/api/v2/skills/projects/${projectId}/content`,
		userId,
		json("PUT", key, { schemaVersion: 1, baseRevision, files: content }),
	);
}
async function publish(
	projectId: string,
	contentRevision: number,
	version: string,
	visibility = "PRIVATE",
	key = `publish-${projectId}-${version}`,
	userId = "owner-a",
) {
	return fetchAs(
		`/api/v2/skills/projects/${projectId}/versions`,
		userId,
		json("POST", key, {
			schemaVersion: 1,
			contentRevision,
			version,
			visibility,
		}),
	);
}
async function read(object: SkillPackagePublicationObjectV1) {
	return Buffer.from(
		await new Response(
			await storage.download({
				objectRef: object.objectRef,
				version: object.version,
				etag: object.etag,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			}),
		).arrayBuffer(),
	);
}

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "skill-project-publication-"));
	database = await startPostgresTestDatabase("skill-hub-http-project-publish");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 1 });
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
			sourceVerifier: deploymentSourceVerifier,
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
	resetUsers();
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
	await sql?.end();
	await database?.stop();
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("Skill Hub web project editing and publication over HTTP (#2906)", () => {
	it("edits project content, publishes a fixed version with full admission evidence and reads the digests back", async () => {
		const projectId = await createProject();
		const client = createClient({
			baseUrl,
			headers: { cookie: "fixture-user=owner-a" },
		});
		const empty = await readSkillHubProjectContentV1({
			client,
			path: { projectId },
		});
		expect(SkillHubProjectContentV1Schema.parse(empty.data)).toMatchObject({
			revision: 0,
			files: [],
			contentDigest: null,
		});
		const marker = join(scratch, "script-executed");
		const content = files(undefined, marker);
		const saved = await saveSkillHubProjectContentV1({
			client,
			path: { projectId },
			headers: { "Idempotency-Key": "save-first" },
			body: {
				schemaVersion: 1,
				baseRevision: 0,
				files: content as never,
			},
		});
		expect(saved.response?.status).toBe(200);
		const first = SkillHubProjectContentSaveResponseV1Schema.parse(saved.data);
		expect(first).toMatchObject({ revision: 1, fileCount: 4, replayed: false });
		const readBack = SkillHubProjectContentV1Schema.parse(
			(await readSkillHubProjectContentV1({ client, path: { projectId } }))
				.data,
		);
		expect(readBack.revision).toBe(1);
		expect(readBack.contentDigest).toBe(first.contentDigest);
		expect(
			readBack.files.map(({ path, encoding, content }) => ({
				path,
				encoding,
				content,
			})),
		).toEqual([...content].sort((a, b) => (a.path < b.path ? -1 : 1)));

		const published = await publishSkillHubProjectVersionV1({
			client,
			path: { projectId },
			headers: { "Idempotency-Key": "publish-first" },
			body: {
				schemaVersion: 1,
				contentRevision: 1,
				version: "1.0.0",
				visibility: "PRIVATE",
			},
		});
		expect(published.response?.status).toBe(201);
		const result = SkillHubPublicationResponseV1Schema.parse(published.data);
		expect(result.version).toMatchObject({
			skillId: projectId,
			provider: "my_library",
			version: "1.0.0",
			visibility: "PRIVATE",
			state: "published",
		});
		expect(JSON.stringify(published.data)).not.toMatch(
			/packageObjectVersion|ownerId|objectRef|etag/,
		);
		// 平台只打包、扫描与签名，不执行包内脚本；部署的外部来源校验器没有被调用。
		expect(existsSync(marker)).toBe(false);
		expect(deploymentSourceVerifier.verify).not.toHaveBeenCalled();

		// 摘要可回读：版本元数据与详情给出同一组摘要，正文与资源来自同一固定包。
		const versionId = result.version.skillVersionId;
		const metadata = await fetchAs(`/api/v2/skills/versions/${versionId}`);
		expect(metadata.status).toBe(200);
		expect(
			SkillHubVersionMetadataV1Schema.parse(await metadata.json()),
		).toMatchObject({
			packageDigest: result.version.packageDigest,
			manifestDigest: result.version.manifestDigest,
			signatureDigest: result.version.signatureDigest,
		});
		const detail = SkillHubVersionDetailV1Schema.parse(
			await (
				await fetchAs(`/api/v2/skills/versions/${versionId}/detail`)
			).json(),
		);
		expect(detail.content).toMatchObject({
			state: "available",
			body: `# notes\n${bodyMarker}\n`,
			resources: [
				{ path: "assets/logo.png", kind: "asset", sizeBytes: 8 },
				{ path: "references/guide.md", kind: "reference", sizeBytes: 6 },
				expect.objectContaining({ path: "scripts/run.sh", kind: "script" }),
			],
		});

		// 原发布操作保存完整七阶段固定对象；来源证明由平台项目供应生成，签名可用当前公钥核对。
		const [operation] =
			await sql`select payload from platform.outbox_items where scope_type = 'skill_package' and scope_id = ${versionId} and status = 'succeeded'`;
		const state = parseSkillPackagePublicationStateV1(operation?.payload);
		expect(Object.keys(state.objects).toSorted()).toEqual(
			[
				"bundle",
				"manifest",
				"scan",
				"signature",
				"signature-record",
				"source-proof",
				"zip",
			].toSorted(),
		);
		expect(state.selection).toMatchObject({
			provider: "my_library",
			sourceVersion: `project:${projectId}:r1`,
			sourceDigest: result.version.packageDigest,
			archiveDigest: result.version.packageDigest,
			approvalRef: null,
			trustRevision: "trust-1",
			policyRevision: "policy-1",
		});
		expect(state.intents["source-proof"]?.evidence).toEqual({
			schemaVersion: 1,
			provider: "my_library",
			publisherId: "owner-a",
			sourceVersion: `project:${projectId}:r1`,
			sourceDigest: result.version.packageDigest,
			approvalRef: null,
			trustRevision: "trust-1",
		});
		const { zip, signature } = state.objects;
		const record = state.objects["signature-record"];
		if (!zip || !signature || !record) throw new Error("missing evidence");
		expect(zip.sha256).toBe(result.version.packageDigest);
		expect(signature.sha256).toBe(result.version.signatureDigest);
		expect(
			verify(
				null,
				Buffer.concat([
					Buffer.from("agent-infra:skill-package-admission:v1\n"),
					await read(record),
				]),
				keys.publicKey,
				await read(signature),
			),
		).toBe(true);

		// 响应丢失后同一键重试返回原版本，不重新扫描或换包。
		const replay = await publish(
			projectId,
			1,
			"1.0.0",
			"PRIVATE",
			"publish-first",
		);
		expect(replay.status).toBe(200);
		const replayed = SkillHubPublicationResponseV1Schema.parse(
			await replay.json(),
		);
		expect(replayed).toEqual({ ...result, replayed: true });

		// 正文与脚本不进入审计。
		const audits =
			await sql`select action, details::text as details from platform.audit_events`;
		expect(audits.map((row) => row.action)).toEqual(
			expect.arrayContaining([
				"skill.project.content.save",
				"skill.version.register",
			]),
		);
		expect(JSON.stringify(audits)).not.toMatch(
			new RegExp(`${bodyMarker}|script-executed|iVBORw0KGgo`),
		);
	});

	it("never changes a committed version and requires a new version for changed content", async () => {
		const projectId = await createProject();
		expect((await save(projectId, 0)).status).toBe(200);
		const first = SkillHubPublicationResponseV1Schema.parse(
			await (await publish(projectId, 1, "1.0.0")).json(),
		);
		expect((await save(projectId, 1, files("# notes v2\n"))).status).toBe(200);
		const operations = async () =>
			(
				await sql`select count(*)::int as count from platform.outbox_items where scope_type = 'skill_package'`
			)[0]?.count;
		const before = await operations();
		// 同一版本号用新内容发布：直接冲突，不进入供应，原版本的包与摘要不变。
		const same = await publish(
			projectId,
			2,
			"1.0.0",
			"PRIVATE",
			"publish-again",
		);
		expect(same.status).toBe(409);
		expect(await operations()).toBe(before);
		// 原幂等键在内容修订变化后不能续接新内容；旧修订也不能再发布。
		expect(
			(
				await publish(
					projectId,
					1,
					"1.0.0",
					"PRIVATE",
					`publish-${projectId}-1.0.0`,
				)
			).status,
		).toBe(409);
		expect((await publish(projectId, 1, "1.1.0")).status).toBe(409);
		const [stored] =
			await sql`select package_digest, manifest_digest, signature_digest, package_object_version from platform.skill_hub_versions where id = ${first.version.skillVersionId}`;
		expect(stored).toMatchObject({
			package_digest: first.version.packageDigest,
			manifest_digest: first.version.manifestDigest,
			signature_digest: first.version.signatureDigest,
		});
		// 新版本号发布新的固定包；旧版本详情仍返回原正文。
		const second = SkillHubPublicationResponseV1Schema.parse(
			await (await publish(projectId, 2, "1.1.0")).json(),
		);
		expect(second.version.skillVersionId).not.toBe(
			first.version.skillVersionId,
		);
		expect(second.version.packageDigest).not.toBe(first.version.packageDigest);
		const body = async (versionId: string) => {
			const detail = SkillHubVersionDetailV1Schema.parse(
				await (
					await fetchAs(`/api/v2/skills/versions/${versionId}/detail`)
				).json(),
			);
			return detail.content.state === "available" ? detail.content.body : null;
		};
		expect(await body(first.version.skillVersionId)).toBe(
			`# notes\n${bodyMarker}\n`,
		);
		expect(await body(second.version.skillVersionId)).toBe("# notes v2\n");
	});

	it("sends shared scopes to review and resolves the organization on the server", async () => {
		const member = await createProject();
		expect((await save(member, 0)).status).toBe(200);
		const memberResult = SkillHubPublicationResponseV1Schema.parse(
			await (await publish(member, 1, "1.0.0", "MEMBER")).json(),
		);
		expect(memberResult.version.state).toBe("pending_review");
		const organizational = await createProject("org-a");
		expect((await save(organizational, 0)).status).toBe(200);
		const orgResult = SkillHubPublicationResponseV1Schema.parse(
			await (await publish(organizational, 1, "1.0.0", "ORGANIZATION")).json(),
		);
		expect(orgResult.version).toMatchObject({
			visibility: "ORGANIZATION",
			state: "pending_review",
		});
		const queue = SkillHubReviewQueuePageV1Schema.parse(
			await (await fetchAs("/api/v2/skills/reviews", "admin")).json(),
		);
		expect(
			queue.items.find(
				(item) => item.skillVersionId === orgResult.version.skillVersionId,
			),
		).toMatchObject({ organizationId: "org-a", ownerId: "owner-a" });
		// 项目没有所属组织时不能选组织共享。
		expect((await publish(member, 1, "2.0.0", "ORGANIZATION")).status).toBe(
			400,
		);
		// 失去项目所属组织的成员身份后，组织共享发布在进入供应前就被拒绝，不打包、不上传、不登记版本。
		const operations = async () =>
			(
				await sql`select count(*)::int as count from platform.outbox_items where scope_type = 'skill_package'`
			)[0]?.count;
		const before = await operations();
		users["owner-a"] = user("owner-a", []);
		expect(
			(await publish(organizational, 1, "2.0.0", "ORGANIZATION")).status,
		).toBe(403);
		expect(await operations()).toBe(before);
		const versions =
			await sql`select count(*)::int as count from platform.skill_hub_versions where skill_id = ${organizational}`;
		expect(versions[0]?.count).toBe(1);
	});

	it("rejects oversized, malformed and infected content before any version is exposed", async () => {
		const projectId = await createProject();
		const big = "x".repeat(262_144);
		for (const content of [
			Array.from({ length: 101 }, (_, index) => ({
				path: index === 0 ? "SKILL.md" : `references/${index}.md`,
				encoding: "utf8",
				content: "x",
			})),
			[{ path: "SKILL.md", encoding: "utf8", content: `${big}x` }],
			[
				{ path: "SKILL.md", encoding: "utf8", content: big },
				{ path: "references/a.md", encoding: "utf8", content: big },
				{ path: "references/b.md", encoding: "utf8", content: "x" },
			],
			[...files(), { path: "notes/readme.md", encoding: "utf8", content: "x" }],
			[{ path: "references/guide.md", encoding: "utf8", content: "x" }],
			[
				...files(),
				{ path: "scripts/../SKILL.md", encoding: "utf8", content: "x" },
			],
			[{ path: "SKILL.md", encoding: "base64", content: "not base64" }],
		])
			expect((await save(projectId, 0, content, "save-invalid")).status).toBe(
				400,
			);
		// 超过 1 MiB 的请求体在解析前被拒绝。
		const oversized = await fetchAs(
			`/api/v2/skills/projects/${projectId}/content`,
			"owner-a",
			json("PUT", "save-oversized", {
				schemaVersion: 1,
				baseRevision: 0,
				files: [
					{
						path: "SKILL.md",
						encoding: "utf8",
						content: "x".repeat(1_100_000),
					},
				],
			}),
		);
		expect(oversized.status).toBe(400);
		expect(
			SkillHubProjectContentV1Schema.parse(
				await (
					await fetchAs(`/api/v2/skills/projects/${projectId}/content`)
				).json(),
			).revision,
		).toBe(0);
		// 发布请求不能夹带包事实。
		expect((await save(projectId, 0)).status).toBe(200);
		const forged = await fetchAs(
			`/api/v2/skills/projects/${projectId}/versions`,
			"owner-a",
			json("POST", "publish-forged", {
				schemaVersion: 1,
				contentRevision: 1,
				version: "1.0.0",
				visibility: "PRIVATE",
				packageDigest: "a".repeat(64),
			}),
		);
		expect(forged.status).toBe(400);
		// 扫描拒绝的内容不登记版本，修改后可以用同一版本号发布。
		expect(
			(await save(projectId, 1, files(`# notes\n${infected}\n`))).status,
		).toBe(200);
		expect((await publish(projectId, 2, "1.0.0")).status).toBe(400);
		const versions =
			await sql`select count(*)::int as count from platform.skill_hub_versions where skill_id = ${projectId}`;
		expect(versions[0]?.count).toBe(0);
		expect((await save(projectId, 2)).status).toBe(200);
		expect(
			(await publish(projectId, 3, "1.0.0", "PRIVATE", "publish-clean")).status,
		).toBe(201);
	});

	it("refuses other users, administrators, disabled projects and malformed requests", async () => {
		// 组织项目：跨组织用户、同组织成员与管理员都不能读取、修改或发布 Owner 的项目内容。
		const projectId = await createProject("org-a");
		expect((await save(projectId, 0)).status).toBe(200);
		for (const userId of ["owner-b", "member-a", "admin"]) {
			const headers = {
				"x-user-id": "owner-a",
				"x-agent-infra-user": "owner-a",
			};
			expect(
				(
					await fetchAs(
						`/api/v2/skills/projects/${projectId}/content`,
						userId,
						{
							headers,
						},
					)
				).status,
			).toBe(404);
			expect(
				(await save(projectId, 1, files("# taken\n"), `save-${userId}`, userId))
					.status,
			).toBe(404);
			expect(
				(
					await publish(
						projectId,
						1,
						"9.0.0",
						"PRIVATE",
						`publish-${userId}`,
						userId,
					)
				).status,
			).toBe(404);
		}
		const after = SkillHubProjectContentV1Schema.parse(
			await (
				await fetchAs(`/api/v2/skills/projects/${projectId}/content`)
			).json(),
		);
		expect(after.revision).toBe(1);
		const versions =
			await sql`select count(*)::int as count from platform.skill_hub_versions where skill_id = ${projectId}`;
		expect(versions[0]?.count).toBe(0);
		const path = `/api/v2/skills/projects/${projectId}/content`;
		expect((await fetchAs(path, null)).status).toBe(401);
		expect(
			(
				await fetchAs(path, "owner-a", {
					headers: { authorization: "Bearer platform-token" },
				})
			).status,
		).toBe(401);
		expect((await fetchAs(`${path}?owner=owner-b`)).status).toBe(400);
		expect(
			(
				await fetchAs(path, "owner-a", {
					method: "PUT",
					body: JSON.stringify({
						schemaVersion: 1,
						baseRevision: 1,
						files: files(),
					}),
				})
			).status,
		).toBe(400);
		expect(
			(await fetchAs("/api/v2/skills/projects/..%2Fx/content")).status,
		).toBe(400);
		// 停用项目不能保存或发布。
		const disabled = await fetchAs(
			`/api/v2/skills/projects/${projectId}`,
			"owner-a",
			json("PATCH", "disable", { schemaVersion: 1, status: "disabled" }),
		);
		expect(disabled.status).toBe(200);
		expect((await save(projectId, 1, files("# disabled\n"))).status).toBe(403);
		expect((await publish(projectId, 1, "1.0.0")).status).toBe(403);
		const refusals =
			await sql`select count(*)::int as count from platform.audit_events where action = 'skill.version.refused'`;
		expect(refusals[0]?.count).toBeGreaterThanOrEqual(10);
	});
});
