import type { SkillHubIdentitySnapshotV1 } from "@agent-infra/platform-core";
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
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { PostgresSkillHubLifecycleV1 } from "./skill-hub.ts";

// 网页编辑的 Skill 项目内容（#2906）：只有 Owner 能读写，按修订号 CAS 整体替换。
const actor = (
	userId: string,
	isAdministrator = false,
): SkillHubIdentitySnapshotV1 => ({
	actor: {
		schemaVersion: 1,
		userId,
		accountStatus: "active",
		organizationIds: ["org-a"],
		isAdministrator,
	},
	authorizationRevision: "content-auth-1",
});
const request = (userId = "owner-a") => ({
	userId,
	requestId: `content-${userId}`,
	traceId: `content-trace-${userId}`,
});
const marker = "Private skill body marker";
const files = (body = `# notes\n${marker}\n`) => [
	{ path: "SKILL.md", encoding: "utf8", content: body },
	{ path: "scripts/run.sh", encoding: "utf8", content: "echo run\n" },
	{ path: "assets/logo.png", encoding: "base64", content: "iVBORw0KGgo=" },
];
const update = (baseRevision: number, body?: string) => ({
	schemaVersion: 1,
	baseRevision,
	files: files(body),
});

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;
let identities: Map<string, SkillHubIdentitySnapshotV1>;
let store: PostgresSkillHubLifecycleV1;
let projectId: string;
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

beforeAll(async () => {
	database = await startPostgresTestDatabase("skill-hub-project-content");
	client = postgres(database.databaseUrl, { max: 1 });
	await migratePlatformDatabase(database);
	store = new PostgresSkillHubLifecycleV1({
		databaseUrl: database.databaseUrl,
		resolveIdentity: async (userId) => identities.get(userId) ?? null,
	});
});
beforeEach(async () => {
	await client`truncate platform.skill_hub_project_contents, platform.skill_hub_skills, platform.skill_hub_versions, platform.idempotency_records, platform.audit_events, platform.platform_user_disables cascade`;
	identities = new Map([
		["owner-a", actor("owner-a")],
		["owner-b", actor("owner-b")],
		["admin", actor("admin", true)],
	]);
	projectId = (
		await store.createProject(request(), "create-notes", {
			schemaVersion: 1,
			name: "notes",
		})
	).project.projectId;
});
afterAll(async () => {
	await store?.close();
	await client?.end();
	await database?.stop();
});

describe("Skill Hub project content (#2906)", () => {
	it("saves the whole content by revision, reads it back and replays the same key", async () => {
		const empty = await store.readProjectContent(request(), projectId);
		expect(empty).toMatchObject({
			revision: 0,
			content: null,
			updatedAt: null,
		});
		const first = await store.saveProjectContent(
			request(),
			projectId,
			"save-1",
			update(0),
		);
		expect(first).toMatchObject({
			replayed: false,
			projectId,
			revision: 1,
			fileCount: 3,
		});
		const read = await store.readProjectContent(request(), projectId);
		expect(read.revision).toBe(1);
		expect(read.content?.contentDigest).toBe(first.contentDigest);
		expect(read.content?.files.map((file) => file.path)).toEqual([
			"SKILL.md",
			"assets/logo.png",
			"scripts/run.sh",
		]);
		expect(
			new TextDecoder().decode(
				read.content?.files.find((file) => file.path === "SKILL.md")?.bytes,
			),
		).toContain(marker);
		// 响应丢失后同一键重试返回原结果，不再递增修订。
		expect(
			await store.saveProjectContent(request(), projectId, "save-1", update(0)),
		).toEqual({ ...first, replayed: true });
		// 同一键换内容是幂等冲突；用旧修订保存是修订冲突。
		await expect(
			store.saveProjectContent(request(), projectId, "save-1", update(0, "x")),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		await expect(
			store.saveProjectContent(request(), projectId, "save-2", update(0, "x")),
		).rejects.toMatchObject({ code: "version_conflict" });
		const second = await store.saveProjectContent(
			request(),
			projectId,
			"save-3",
			update(1, "# notes v2\n"),
		);
		expect(second.revision).toBe(2);
		expect(second.contentDigest).not.toBe(first.contentDigest);
		expect(
			(await store.readProjectPublicationSource(request(), projectId)).revision,
		).toBe(2);
		// 正文不进入审计或幂等结果。
		const audits =
			await client`select action, details::text as details from platform.audit_events where target_id = ${projectId}`;
		expect(audits.map((row) => row.action)).toEqual(
			expect.arrayContaining([
				"skill.project.content.read",
				"skill.project.content.save",
			]),
		);
		const records =
			await client`select result::text as result from platform.idempotency_records where scope_type = 'skill_project_content'`;
		expect(JSON.stringify([...audits, ...records])).not.toMatch(
			new RegExp(`${marker}|echo run|iVBORw0KGgo`),
		);
	});

	it("keeps other users and administrators out of the owner's project content", async () => {
		await store.saveProjectContent(request(), projectId, "save-1", update(0));
		for (const userId of ["owner-b", "admin"]) {
			await expect(
				store.readProjectContent(request(userId), projectId),
			).rejects.toMatchObject({ code: "not_found" });
			await expect(
				store.readProjectPublicationSource(request(userId), projectId),
			).rejects.toMatchObject({ code: "not_found" });
			await expect(
				store.saveProjectContent(
					request(userId),
					projectId,
					`save-${userId}`,
					update(1, "# replaced\n"),
				),
			).rejects.toMatchObject({ code: "not_found" });
		}
		await expect(
			store.readProjectContent(request(), "unknown-project"),
		).rejects.toMatchObject({ code: "not_found" });
		expect(
			(await store.readProjectContent(request(), projectId)).revision,
		).toBe(1);
	});

	it("refuses writes to a disabled project and invalid content", async () => {
		for (const input of [
			{ ...update(0), files: [] },
			{ ...update(0), files: [files()[1]] },
			{
				...update(0),
				files: [
					...files(),
					{ path: "notes.md", encoding: "utf8", content: "x" },
				],
			},
			{ ...update(0), extra: true },
		])
			await expect(
				store.saveProjectContent(request(), projectId, "save-invalid", input),
			).rejects.toMatchObject({ code: "invalid_input" });
		await store.updateProject(request(), projectId, "disable", {
			schemaVersion: 1,
			status: "disabled",
		});
		await expect(
			store.saveProjectContent(
				request(),
				projectId,
				"save-disabled",
				update(0),
			),
		).rejects.toMatchObject({ code: "forbidden" });
		// 停用后 Owner 仍可读取原内容，发布由用例按停用拒绝。
		expect(
			(await store.readProjectPublicationSource(request(), projectId)).project
				.status,
		).toBe("disabled");
	});

	it("fails closed when stored content no longer matches its digest", async () => {
		await store.saveProjectContent(request(), projectId, "save-1", update(0));
		await client`update platform.skill_hub_project_contents set content_digest = ${"f".repeat(64)} where project_id = ${projectId}`;
		await expect(
			store.readProjectContent(request(), projectId),
		).rejects.toMatchObject({ code: "unavailable" });
	});
});
