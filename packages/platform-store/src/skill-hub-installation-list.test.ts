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

// 「我的安装」（#2953）：只列会话用户本人的有效安装，版本不可见时不带名称。
const actor = (
	userId: string,
	organizationIds: readonly string[] = ["org-a"],
	isAdministrator = false,
): SkillHubIdentitySnapshotV1 => ({
	actor: {
		schemaVersion: 1,
		userId,
		accountStatus: "active",
		organizationIds,
		isAdministrator,
	},
	authorizationRevision: "installation-list-auth-1",
});
const request = (userId = "member") => ({
	userId,
	requestId: `installation-list-${userId}`,
	traceId: `installation-list-trace-${userId}`,
});
const registration = (
	skillId: string,
	skillVersionId: string,
	visibility: "PRIVATE" | "MEMBER" | "ORGANIZATION" | "MARKET",
	version = "1.0.0",
) => ({
	schemaVersion: 1,
	name: skillId,
	skillId,
	skillVersionId,
	visibility,
	provider: "my_library",
	version,
	packageObjectVersion: `object-${skillVersionId}`,
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	...(visibility === "ORGANIZATION" ? { organizationId: "org-a" } : {}),
});

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;
let identities: Map<string, SkillHubIdentitySnapshotV1>;
const stores: PostgresSkillHubLifecycleV1[] = [];
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
function store() {
	const value = new PostgresSkillHubLifecycleV1({
		databaseUrl: database?.databaseUrl ?? "",
		resolveIdentity: async (userId) => identities.get(userId) ?? null,
	});
	stores.push(value);
	return value;
}
async function admit(skillVersionId: string) {
	const now = new Date();
	await client`insert into platform.idempotency_records
		(id, scope_type, scope_id, actor_id, command_type, idempotency_key,
		 request_digest, status, result, created_at, updated_at)
		values (${`admission-${skillVersionId}`}, 'skill_package', ${skillVersionId},
		 'owner-a', 'skill.package.publish.v1', ${`admission-${skillVersionId}`},
		 ${"d".repeat(64)}, 'completed', ${client.json({ operationId: `admission-${skillVersionId}`, skillVersionId })}, ${now}, ${now})`;
}
const install = (
	adapter: PostgresSkillHubLifecycleV1,
	userId: string,
	skillVersionId: string,
	principalType: "user" | "organization" = "user",
	principalId = userId,
) =>
	adapter.installVersion(
		request(userId),
		`install-${userId}-${principalType}-${skillVersionId}`,
		{ principalType, principalId, skillVersionId },
	);

beforeAll(async () => {
	database = await startPostgresTestDatabase("skill-hub-installation-list");
	client = postgres(database.databaseUrl, { max: 1 });
	await migratePlatformDatabase(database);
});
beforeEach(async () => {
	await client`truncate platform.skill_hub_skills, platform.skill_hub_versions, platform.skill_hub_installations, platform.idempotency_records, platform.audit_events, platform.platform_user_disables cascade`;
	identities = new Map([
		["owner-a", actor("owner-a")],
		["member", actor("member")],
		["other", actor("other")],
		["admin", actor("admin", [], true)],
	]);
	const owner = store();
	// owner-a 发布三个共享版本：全体成员、组织共享、内部市场，均经管理员批准并有供应记录。
	for (const [skillId, visibility] of [
		["notes", "MEMBER"],
		["incident", "ORGANIZATION"],
		["digest", "MARKET"],
	] as const) {
		await owner.registerVersion(
			request("owner-a"),
			`register-${skillId}`,
			registration(skillId, `${skillId}-v1`, visibility),
		);
		await owner.reviewVersion(
			request("admin"),
			`${skillId}-v1`,
			`approve-${skillId}`,
			{ decision: "approve" },
		);
		await admit(`${skillId}-v1`);
	}
});
afterAll(async () => {
	for (const value of stores) await value.close();
	await client?.end();
	await database?.stop();
});

describe("Skill Hub installation list (#2953)", () => {
	it("pages only the caller's own installed versions and drops removed ones", async () => {
		const adapter = store();
		const ids = new Map<string, string>();
		for (const skillVersionId of ["notes-v1", "incident-v1", "digest-v1"])
			ids.set(
				skillVersionId,
				(await install(adapter, "member", skillVersionId)).installation
					.installationId,
			);
		// 他人和组织主体的安装不属于本人的列表。
		await install(adapter, "other", "notes-v1");
		await install(adapter, "member", "notes-v1", "organization", "org-a");

		const first = await adapter.listInstallations(request(), { limit: 2 });
		expect(first.entries).toHaveLength(2);
		expect(first.nextCursor).toBe(
			first.entries[1]?.installation.installationId,
		);
		const second = await adapter.listInstallations(request(), {
			cursor: first.nextCursor ?? undefined,
			limit: 2,
		});
		expect(second.nextCursor).toBeNull();
		const all = [...first.entries, ...second.entries];
		expect(
			all.map((entry) => entry.installation.installationId).toSorted(),
		).toEqual([...ids.values()].toSorted());
		for (const entry of all) {
			expect(entry.installation).toMatchObject({
				principalType: "user",
				principalId: "member",
				state: "installed",
			});
			expect(entry.version?.skillVersionId).toBe(
				entry.installation.skillVersionId,
			);
		}

		const removed = ids.get("digest-v1") ?? "";
		await adapter.uninstallInstallation(request(), removed, "remove-digest");
		const after = await adapter.listInstallations(request(), {});
		expect(
			after.entries.map((entry) => entry.installation.installationId),
		).not.toContain(removed);
		expect(after.entries).toHaveLength(2);
		const audits =
			await client`select action, outcome, details from platform.audit_events where action = 'skill.installations.read' order by occurred_at`;
		expect(audits.map((row) => row.details)).toEqual([
			{ count: 2 },
			{ count: 1 },
			{ count: 2 },
		]);
	});

	it("hides the version of an installation the caller can no longer view", async () => {
		const adapter = store();
		await install(adapter, "member", "incident-v1");
		await install(adapter, "member", "digest-v1");
		await install(adapter, "member", "notes-v1");
		// 失去组织成员身份后，组织共享版本只剩安装事实，不带名称。
		identities.set("member", actor("member", []));
		// 他人版本撤销后，安装者不能再读取它的版本信息。
		await adapter.revokeVersion(
			request("owner-a"),
			"digest-v1",
			"revoke-digest",
		);
		const page = await adapter.listInstallations(request(), {});
		const byVersion = new Map(
			page.entries.map((entry) => [entry.installation.skillVersionId, entry]),
		);
		expect(byVersion.get("incident-v1")?.version).toBeNull();
		expect(byVersion.get("digest-v1")?.version).toBeNull();
		expect(byVersion.get("notes-v1")?.version).toMatchObject({
			name: "notes",
			state: "published",
		});
		// 父项目停用后同样不可见。
		await adapter.updateProject(request("owner-a"), "notes", "disable-notes", {
			schemaVersion: 1,
			status: "disabled",
		});
		const disabled = await adapter.listInstallations(request(), {});
		expect(
			disabled.entries.find(
				(entry) => entry.installation.skillVersionId === "notes-v1",
			)?.version,
		).toBeNull();
	});

	it("keeps the publisher's own revoked version readable in the list", async () => {
		const adapter = store();
		await install(adapter, "owner-a", "notes-v1");
		await adapter.revokeVersion(request("owner-a"), "notes-v1", "revoke-notes");
		const [entry] = (await adapter.listInstallations(request("owner-a"), {}))
			.entries;
		expect(entry?.version).toMatchObject({ name: "notes", state: "revoked" });
	});

	it("refuses invalid queries and unknown callers", async () => {
		const adapter = store();
		for (const query of [{ limit: 0 }, { limit: 101 }, { cursor: "../a" }])
			await expect(
				adapter.listInstallations(request(), query),
			).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			adapter.listInstallations(request("unknown"), {}),
		).rejects.toMatchObject({ code: "forbidden" });
		const refusals =
			await client`select details from platform.audit_events where action = 'skill.version.refused'`;
		expect(refusals.map((row) => row.details)).toEqual(
			expect.arrayContaining([
				{ reason: "invalid_input" },
				{ reason: "forbidden" },
			]),
		);
		expect(
			await client`select 1 from platform.audit_events where action = 'skill.installations.read'`,
		).toHaveLength(0);
	});
});
