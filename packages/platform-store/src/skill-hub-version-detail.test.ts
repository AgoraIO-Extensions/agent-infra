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

// 版本详情与本人版本目录（#2904）：本人回读各状态版本，他人不可区分地看不到。
const actor = (
	userId: string,
	administrator = false,
): SkillHubIdentitySnapshotV1 => ({
	actor: {
		schemaVersion: 1,
		userId,
		accountStatus: "active",
		organizationIds: ["org-a"],
		isAdministrator: administrator,
	},
	authorizationRevision: "detail-auth-1",
});
const request = (userId = "owner-a") => ({
	userId,
	requestId: `detail-${userId}`,
	traceId: `detail-trace-${userId}`,
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
async function admit(skillVersionId: string, payload?: unknown) {
	const now = new Date();
	const operationId = `admission-${skillVersionId}`;
	await client`insert into platform.idempotency_records
		(id, scope_type, scope_id, actor_id, command_type, idempotency_key,
		 request_digest, status, result, created_at, updated_at)
		values (${operationId}, 'skill_package', ${skillVersionId},
		 'owner-a', 'skill.package.publish.v1', ${operationId},
		 ${"d".repeat(64)}, 'completed', ${client.json({ operationId, skillVersionId })}, ${now}, ${now})`;
	if (payload !== undefined)
		await client`insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, status, trace_id, request_id)
			values (${operationId}, 'skill_package', ${skillVersionId},
			 'skill.package.publish.v1', ${client.json(payload as never)}, 'succeeded', 'trace', 'request')`;
}
async function seed() {
	const owner = store();
	// owner-a：已发布、待审核、已驳回、已撤销各一；owner-b：一个私有版本与一个待审版本。
	await owner.registerVersion(
		request(),
		"r-published",
		registration("notes", "notes-v1", "PRIVATE", "1.0.0"),
	);
	await owner.registerVersion(
		request(),
		"r-pending",
		registration("notes", "notes-v2", "MARKET", "2.0.0"),
	);
	await owner.registerVersion(
		request(),
		"r-rejected",
		registration("notes", "notes-v3", "MEMBER", "3.0.0"),
	);
	await owner.reviewVersion(request("admin"), "notes-v3", "reject-v3", {
		decision: "reject",
		reason: "private review text",
	});
	await owner.registerVersion(
		request(),
		"r-revoked",
		registration("summary", "summary-v1", "MARKET"),
	);
	await owner.reviewVersion(request("admin"), "summary-v1", "approve-s1", {
		decision: "approve",
	});
	await owner.revokeVersion(request(), "summary-v1", "revoke-s1");
	await owner.registerVersion(
		request("owner-b"),
		"r-b-private",
		registration("other", "other-v1", "PRIVATE"),
	);
	await owner.registerVersion(
		request("owner-b"),
		"r-b-pending",
		registration("other", "other-v2", "MARKET", "2.0.0"),
	);
	return owner;
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("skill-hub-version-detail");
	client = postgres(database.databaseUrl, { max: 1 });
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
});
beforeEach(async () => {
	await client`truncate platform.skill_hub_skills, platform.skill_hub_versions, platform.skill_hub_installations, platform.idempotency_records, platform.outbox_items, platform.audit_events, platform.platform_user_disables cascade`;
	identities = new Map([
		["owner-a", actor("owner-a")],
		["owner-b", actor("owner-b")],
		["admin", actor("admin", true)],
	]);
});
afterAll(async () => {
	for (const adapter of stores) await adapter.close();
	await client?.end();
	await database?.stop();
});

describe("Skill Hub version detail and owned versions", () => {
	it("lets the publisher read back own versions in every state and pages them", async () => {
		const adapter = await seed();
		const first = await adapter.listOwnedVersions(request(), { limit: 2 });
		expect(
			first.versions.map((item) => [item.skillVersionId, item.state]),
		).toEqual([
			["notes-v1", "published"],
			["notes-v2", "pending_review"],
		]);
		expect(first.nextCursor).toBe("notes-v2");
		const second = await adapter.listOwnedVersions(request(), {
			cursor: first.nextCursor,
			limit: 2,
		});
		expect(
			second.versions.map((item) => [item.skillVersionId, item.state]),
		).toEqual([
			["notes-v3", "rejected"],
			["summary-v1", "revoked"],
		]);
		expect(second.nextCursor).toBeNull();
		for (const [versionId, state] of [
			["notes-v2", "pending_review"],
			["notes-v3", "rejected"],
			["summary-v1", "revoked"],
		] as const)
			expect(
				(await adapter.readVersionDetail(request(), versionId)).version.state,
			).toBe(state);
		const [audit] =
			await client`select details from platform.audit_events where action = 'skill.owned_versions.read' order by occurred_at limit 1`;
		expect(audit?.details).toEqual({ count: 2 });
	});

	it("keeps other users, administrators and disabled projects away from invisible versions", async () => {
		const adapter = await seed();
		// 他人只看到自己的版本；管理员不经本人目录看到别人的版本。
		expect(
			(await adapter.listOwnedVersions(request("owner-b"), {})).versions.map(
				(item) => item.skillVersionId,
			),
		).toEqual(["other-v1", "other-v2"]);
		expect(
			(await adapter.listOwnedVersions(request("admin"), {})).versions,
		).toEqual([]);
		for (const [userId, versionId] of [
			["owner-b", "notes-v1"],
			["owner-b", "notes-v2"],
			["owner-b", "notes-v3"],
			["owner-b", "summary-v1"],
			["admin", "notes-v2"],
			["admin", "notes-v3"],
			["admin", "summary-v1"],
			["owner-a", "other-v1"],
			["owner-a", "other-v2"],
			["owner-a", "unknown-version"],
		] as const)
			await expect(
				adapter.readVersionDetail(request(userId), versionId),
			).rejects.toMatchObject({ code: "not_found" });
		// 已发布的 MEMBER/MARKET 版本照常按发布范围可见。
		await adapter.reviewVersion(request("admin"), "other-v2", "approve-o2", {
			decision: "approve",
		});
		expect(
			(await adapter.readVersionDetail(request(), "other-v2")).version.state,
		).toBe("published");
		await client`update platform.skill_hub_skills set status = 'disabled' where id = 'notes'`;
		await expect(
			adapter.readVersionDetail(request(), "notes-v2"),
		).rejects.toMatchObject({ code: "not_found" });
		expect(
			(await adapter.listOwnedVersions(request(), {})).versions.map(
				(item) => item.skillVersionId,
			),
		).toEqual(["summary-v1"]);
		await expect(
			adapter.listOwnedVersions(request(), { cursor: "../x" }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			adapter.listOwnedVersions(request(), { limit: 101 }),
		).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("returns only the requester's own installation and no package without a matching admission", async () => {
		const adapter = await seed();
		await adapter.reviewVersion(request("admin"), "other-v2", "approve-o2", {
			decision: "approve",
		});
		await admit("other-v2");
		const otherInstall = await adapter.installVersion(
			request("owner-b"),
			"install-b",
			{
				principalType: "user",
				principalId: "owner-b",
				skillVersionId: "other-v2",
			},
		);
		await adapter.installVersion(request("admin"), "install-org", {
			principalType: "organization",
			principalId: "org-a",
			skillVersionId: "other-v2",
		});
		// 他人与组织的安装都不算 owner-a 的「我的库」。
		const before = await adapter.readVersionDetail(request(), "other-v2");
		expect(before.installation).toBeNull();
		expect(before.packageObject).toBeNull();
		const mine = await adapter.installVersion(request(), "install-a", {
			principalType: "user",
			principalId: "owner-a",
			skillVersionId: "other-v2",
		});
		expect(
			(await adapter.readVersionDetail(request(), "other-v2")).installation,
		).toMatchObject({
			installationId: mine.installation.installationId,
			state: "installed",
		});
		await adapter.uninstallInstallation(
			request(),
			mine.installation.installationId,
			"uninstall-a",
		);
		expect(
			(await adapter.readVersionDetail(request(), "other-v2")).installation,
		).toMatchObject({ state: "uninstalled" });
		expect(
			(await adapter.readVersionDetail(request("owner-b"), "other-v2"))
				.installation,
		).toMatchObject({
			installationId: otherInstall.installation.installationId,
			state: "installed",
		});
		// 供应记录的 outbox 内容无法核对时，不返回任何包描述。
		await admit("notes-v1", { schemaVersion: 1, objects: {} });
		expect(
			(await adapter.readVersionDetail(request(), "notes-v1")).packageObject,
		).toBeNull();
		const audits =
			await client`select details from platform.audit_events where action = 'skill.version.read'`;
		expect(JSON.stringify(audits)).not.toContain("private review text");
	});
});
