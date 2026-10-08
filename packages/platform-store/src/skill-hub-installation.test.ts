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

const actor = (
	userId: string,
	organizationIds: readonly string[] = ["org-a"],
): SkillHubIdentitySnapshotV1 => ({
	actor: {
		schemaVersion: 1,
		userId,
		accountStatus: "active",
		organizationIds,
		isAdministrator: userId === "admin",
	},
	authorizationRevision: "installation-auth-1",
});
const request = (userId = "owner-a") => ({
	userId,
	requestId: `installation-${userId}`,
	traceId: `installation-trace-${userId}`,
});
const registration = (
	skillId: string,
	skillVersionId: string,
	visibility: "PRIVATE" | "MEMBER" | "ORGANIZATION" | "MARKET",
	version: string,
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

beforeAll(async () => {
	database = await startPostgresTestDatabase("skill-hub-installations");
	client = postgres(database.databaseUrl, { max: 1 });
	await migratePlatformDatabase(database);
});
beforeEach(async () => {
	await client`truncate platform.skill_hub_skills, platform.skill_hub_versions, platform.skill_hub_installations, platform.idempotency_records, platform.audit_events, platform.platform_user_disables cascade`;
	identities = new Map([
		["owner-a", actor("owner-a")],
		["owner-b", actor("owner-b", ["org-b"])],
		["member", actor("member")],
		["outsider", actor("outsider", [])],
		["admin", actor("admin", [])],
	]);
});
afterAll(async () => {
	for (const value of stores) await value.close();
	await client?.end();
	await database?.stop();
});

describe("Skill Hub scoped directory and installations", () => {
	it("filters the directory by visibility and installs a MEMBER version idempotently", async () => {
		const adapter = store();
		await adapter.registerVersion(
			request(),
			"private-register",
			registration("private-skill", "private-v1", "PRIVATE", "1.0.0"),
		);
		await adapter.registerVersion(
			request(),
			"member-register",
			registration("member-skill", "member-v1", "MEMBER", "1.0.0"),
		);
		await adapter.reviewVersion(
			request("admin"),
			"member-v1",
			"member-review",
			{
				decision: "approve",
			},
		);
		const visible = await adapter.listVisibleVersions(request("member"));
		expect(visible.map((item) => item.skillVersionId)).toEqual(["member-v1"]);
		const first = await adapter.installVersion(
			request("member"),
			"install-member",
			{
				principalType: "user",
				principalId: "member",
				skillVersionId: "member-v1",
			},
		);
		expect(first).toMatchObject({
			replayed: false,
			installation: { state: "installed", principalId: "member" },
		});
		const replay = await adapter.installVersion(
			request("member"),
			"install-member",
			{
				principalType: "user",
				principalId: "member",
				skillVersionId: "member-v1",
			},
		);
		expect(replay).toEqual({ ...first, replayed: true });
	});

	it("enforces private and organization ownership and rejects pending versions", async () => {
		const adapter = store();
		await adapter.registerVersion(
			request(),
			"private-register",
			registration("private-skill", "private-v1", "PRIVATE", "1.0.0"),
		);
		await expect(
			adapter.installVersion(request("outsider"), "private-install", {
				principalType: "user",
				principalId: "outsider",
				skillVersionId: "private-v1",
			}),
		).rejects.toMatchObject({ code: "not_found" });
		await adapter.registerVersion(
			request(),
			"org-register",
			registration("org-skill", "org-v1", "ORGANIZATION", "1.0.0"),
		);
		await expect(
			adapter.installVersion(request("owner-a"), "org-install", {
				principalType: "organization",
				principalId: "org-a",
				skillVersionId: "org-v1",
			}),
		).rejects.toMatchObject({ code: "version_unavailable" });
		await expect(
			adapter.installVersion(request("outsider"), "org-install-2", {
				principalType: "organization",
				principalId: "org-a",
				skillVersionId: "org-v1",
			}),
		).rejects.toMatchObject({ code: "version_unavailable" });
	});

	it("keeps organization visibility isolated and revalidates replay authorization", async () => {
		const adapter = store();
		await adapter.registerVersion(
			request(),
			"org-register",
			registration("org-skill", "org-v1", "ORGANIZATION", "1.0.0"),
		);
		await adapter.reviewVersion(request("admin"), "org-v1", "org-review", {
			decision: "approve",
		});
		expect(
			(await adapter.listVisibleVersions(request("owner-b"))).map(
				(item) => item.skillVersionId,
			),
		).toEqual([]);
		await expect(
			adapter.installVersion(request("owner-b"), "org-cross-install", {
				principalType: "organization",
				principalId: "org-b",
				skillVersionId: "org-v1",
			}),
		).rejects.toMatchObject({ code: "not_found" });
		const first = await adapter.installVersion(
			request("owner-a"),
			"org-replay",
			{
				principalType: "organization",
				principalId: "org-a",
				skillVersionId: "org-v1",
			},
		);
		identities.set("owner-a", actor("owner-a", []));
		await expect(
			adapter.installVersion(request("owner-a"), "org-replay", {
				principalType: "organization",
				principalId: "org-a",
				skillVersionId: "org-v1",
			}),
		).rejects.toMatchObject({ code: "not_found" });
		expect(first.installation.state).toBe("installed");
	});

	it("supports organization install, explicit uninstall, and a new version upgrade hint", async () => {
		const adapter = store();
		for (const [id, version] of [
			["org-v1", "1.0.0"],
			["org-v2", "2.0.0"],
		] as const) {
			await adapter.registerVersion(
				request(),
				`register-${id}`,
				registration("org-skill", id, "ORGANIZATION", version),
			);
			await adapter.reviewVersion(request("admin"), id, `review-${id}`, {
				decision: "approve",
			});
		}
		const visibleBeforeInstall = await adapter.listVisibleVersions(
			request("owner-a"),
		);
		expect(visibleBeforeInstall.map((item) => item.skillVersionId)).toEqual([
			"org-v1",
			"org-v2",
		]);
		const first = await adapter.installVersion(
			request("owner-a"),
			"install-org-v1",
			{
				principalType: "organization",
				principalId: "org-a",
				skillVersionId: "org-v1",
			},
		);
		await adapter.listVisibleVersions(request("owner-a"));
		const hintAfterPublication = await client`
			select need_upgrade from platform.skill_hub_installations
			where id=${first.installation.installationId}`;
		expect(hintAfterPublication[0]?.need_upgrade).toBe(true);
		const second = await adapter.installVersion(
			request("owner-a"),
			"install-org-v2",
			{
				principalType: "organization",
				principalId: "org-a",
				skillVersionId: "org-v2",
			},
		);
		expect(second.installation.state).toBe("installed");
		const old =
			await client`select need_upgrade from platform.skill_hub_installations where id=${first.installation.installationId}`;
		expect(old[0]?.need_upgrade).toBe(true);
		const rollback = await adapter.installVersion(
			request("owner-a"),
			"rollback-org-v1",
			{
				principalType: "organization",
				principalId: "org-a",
				skillVersionId: "org-v1",
			},
		);
		expect(rollback.installation).toMatchObject({
			installationId: first.installation.installationId,
			needUpgrade: false,
		});
		const removed = await adapter.uninstallInstallation(
			request("owner-a"),
			second.installation.installationId,
			"uninstall-org-v2",
		);
		expect(removed.installation.state).toBe("uninstalled");
	});
});
