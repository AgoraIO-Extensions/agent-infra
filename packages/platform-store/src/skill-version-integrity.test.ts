import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
const migrationsFolder = resolve(
	import.meta.dirname,
	"../../../migrations/platform",
);
const createdAt = new Date("2026-10-07T00:00:00Z");
const revokedAt = new Date("2026-10-08T00:00:00Z");
type VersionState = "pending_review" | "published" | "rejected" | "revoked";
let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;
let prefixFolder: string;
let upgradeRowsBefore: unknown;
let upgradeRowsAfter: unknown;
let historyBefore: { hash: string; created_at: string }[];
let historyAfter: { hash: string; created_at: string }[];

async function seed(state: VersionState = "published") {
	await client`insert into platform.skill_hub_skills
		(id, name, owner_id, created_at, updated_at)
		values ('skill-a', 'summary', 'owner-a', ${createdAt}, ${createdAt})`;
	await client`insert into platform.skill_hub_versions ${client({
		id: "version-a",
		skill_id: "skill-a",
		owner_id: "owner-a",
		version: "1.0.0",
		provider: "my_library",
		visibility:
			state === "pending_review" || state === "rejected" ? "MARKET" : "PRIVATE",
		state,
		package_object_version: "object-version-a",
		package_digest: "a".repeat(64),
		manifest_digest: "b".repeat(64),
		signature_digest: "c".repeat(64),
		reviewed_by:
			state === "pending_review"
				? null
				: state === "rejected"
					? "reviewer-a"
					: "owner-a",
		review_reason: state === "rejected" ? "Rejected package" : null,
		revoked_at: state === "revoked" ? revokedAt : null,
		created_at: createdAt,
	})}`;
}

async function rows() {
	return client`select * from platform.skill_hub_versions order by id`;
}
async function history() {
	return client<{ hash: string; created_at: string }[]>`
		select hash, created_at::text from platform_migrations.history order by id`;
}
const rejectionMessages = {
	skill_hub_version_immutable: "Skill Version content is immutable",
	skill_hub_version_transition: "Skill Version transition rejected",
	skill_hub_version_review_immutable: "Skill Version review is immutable",
	skill_hub_version_revocation_immutable:
		"Skill Version revocation is immutable",
} as const;
async function rejects(
	operation: PromiseLike<unknown>,
	constraint: keyof typeof rejectionMessages,
) {
	try {
		await operation;
		expect.fail("Skill Version write must be rejected");
	} catch (error) {
		expect(error).toMatchObject({
			code: "23514",
			constraint_name: constraint,
			message: rejectionMessages[constraint],
		});
		expect((error as { detail?: unknown }).detail).toBeUndefined();
	}
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("skill-version-integrity");
	client = postgres(database.databaseUrl, { max: 1 });
	prefixFolder = await mkdtemp(resolve(tmpdir(), "skill-version-prefix-"));
	await cp(migrationsFolder, prefixFolder, { recursive: true });
	const journalPath = resolve(prefixFolder, "meta/_journal.json");
	const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
		entries: { idx: number }[];
	};
	journal.entries = journal.entries.filter((entry) => entry.idx <= 40);
	await writeFile(journalPath, JSON.stringify(journal));
	await migratePlatformDatabase({
		databaseUrl: database.databaseUrl,
		migrationsFolder: prefixFolder,
	});
	await seed();
	// Reproduce the old checkpoint's mutable package before installing the guard.
	await client`update platform.skill_hub_versions set package_object_version = 'replacement-object'`;
	expect((await rows())[0]?.package_object_version).toBe("replacement-object");
	await client`update platform.skill_hub_versions set package_object_version = 'object-version-a'`;
	upgradeRowsBefore = await rows();
	historyBefore = await history();
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	upgradeRowsAfter = await rows();
	historyAfter = await history();
});
beforeEach(async () => {
	await client`truncate platform.skill_hub_skills, platform.skill_hub_versions cascade`;
});
afterAll(async () => {
	await client?.end();
	await database?.stop();
	if (prefixFolder) await rm(prefixFolder, { recursive: true, force: true });
});

describe("Skill Version PostgreSQL integrity", () => {
	it("upgrades the populated 0040 checkpoint without rewriting versions or migration history", async () => {
		expect(upgradeRowsAfter).toEqual(upgradeRowsBefore);
		expect(historyAfter.slice(0, -2)).toEqual(historyBefore);
		expect(historyAfter).toHaveLength(historyBefore.length + 2);
		await seed();
		await rejects(
			client`update platform.skill_hub_versions set package_object_version = 'replacement-object'`,
			"skill_hub_version_immutable",
		);
	});

	it("installs on a fresh database and repeats migration without changing history", async () => {
		await client`drop schema platform cascade`;
		await client`drop schema platform_migrations cascade`;
		await migratePlatformDatabase({ databaseUrl: database?.databaseUrl ?? "" });
		const before = await history();
		await migratePlatformDatabase({ databaseUrl: database?.databaseUrl ?? "" });
		expect(await history()).toEqual(before);
		await seed();
		await rejects(
			client`update platform.skill_hub_versions set package_object_version = 'replacement'`,
			"skill_hub_version_immutable",
		);
	});

	it.each([
		["id", "version-b"],
		["skill_id", "skill-b"],
		["owner_id", "owner-b"],
		["version", "2.0.0"],
		["provider", "github"],
		["visibility", "MARKET"],
		["package_object_version", "replacement-object"],
		["package_digest", "d".repeat(64)],
		["manifest_digest", "e".repeat(64)],
		["signature_digest", "f".repeat(64)],
		["created_at", "2026-10-08T00:00:00Z"],
	] as const)(
		"rejects changes to the immutable %s and preserves the full row",
		async (field, value) => {
			await seed();
			const before = await rows();
			await rejects(
				client.unsafe(
					`update platform.skill_hub_versions set "${field}" = $1 where id = 'version-a'`,
					[value],
				),
				"skill_hub_version_immutable",
			);
			expect(await rows()).toEqual(before);
		},
	);

	it("fixes submitted content before review and rolls back related writes on replacement", async () => {
		await seed("pending_review");
		const before = await rows();
		await rejects(
			client.begin(async (transaction) => {
				await transaction`update platform.skill_hub_skills set status = 'disabled' where id = 'skill-a'`;
				await transaction`update platform.skill_hub_versions
				set state = 'published', reviewed_by = 'reviewer-a', package_digest = ${"d".repeat(64)}
				where id = 'version-a'`;
			}),
			"skill_hub_version_immutable",
		);
		expect(await rows()).toEqual(before);
		expect(await client`select status from platform.skill_hub_skills`).toEqual([
			{ status: "active" },
		]);
	});

	it.each(["published", "rejected"] as const)(
		"allows review to %s and upgrade hints without changing content",
		async (state) => {
			await seed("pending_review");
			await client`update platform.skill_hub_versions set state = ${state},
			reviewed_by = 'reviewer-a', review_reason = 'Review decision' where id = 'version-a'`;
			await client`update platform.skill_hub_versions set need_upgrade = true where id = 'version-a'`;
			const before = await rows();
			await client`update platform.skill_hub_versions set need_upgrade = true, state = ${state} where id = 'version-a'`;
			expect(await rows()).toEqual(before);
			expect(before[0]).toMatchObject({
				state,
				need_upgrade: true,
				package_object_version: "object-version-a",
			});
			if (state === "published") {
				await client`update platform.skill_hub_versions set state = 'revoked', revoked_at = ${revokedAt} where id = 'version-a'`;
				expect((await rows())[0]).toMatchObject({
					state: "revoked",
					revoked_at: revokedAt,
					reviewed_by: "reviewer-a",
				});
			}
		},
	);

	it.each([
		["published", "pending_review"],
		["published", "rejected"],
		["rejected", "pending_review"],
		["rejected", "published"],
		["revoked", "published"],
		["revoked", "pending_review"],
		["pending_review", "revoked"],
	] as const)("rejects state regression %s -> %s", async (from, to) => {
		await seed(from);
		const before = await rows();
		await rejects(
			client`update platform.skill_hub_versions set state = ${to} where id = 'version-a'`,
			"skill_hub_version_transition",
		);
		expect(await rows()).toEqual(before);
	});

	it.each(["published", "rejected", "revoked"] as const)(
		"retains decided %s review facts",
		async (state) => {
			await seed(state);
			const before = await rows();
			for (const update of [
				{ reviewed_by: "reviewer-b" },
				{ review_reason: "Replacement decision" },
			]) {
				await rejects(
					client`update platform.skill_hub_versions set ${client(update)} where id = 'version-a'`,
					"skill_hub_version_review_immutable",
				);
			}
			expect(await rows()).toEqual(before);
		},
	);

	it("retains revocation time and rejects revocation facts outside revocation", async () => {
		await seed();
		await rejects(
			client`update platform.skill_hub_versions set revoked_at = ${revokedAt} where id = 'version-a'`,
			"skill_hub_version_revocation_immutable",
		);
		await client`update platform.skill_hub_versions set state = 'revoked', revoked_at = ${revokedAt} where id = 'version-a'`;
		const before = await rows();
		await rejects(
			client`update platform.skill_hub_versions set revoked_at = null where id = 'version-a'`,
			"skill_hub_version_revocation_immutable",
		);
		await rejects(
			client`update platform.skill_hub_versions set revoked_at = ${createdAt} where id = 'version-a'`,
			"skill_hub_version_revocation_immutable",
		);
		await client`update platform.skill_hub_versions set revoked_at = ${revokedAt} where id = 'version-a'`;
		expect(await rows()).toEqual(before);
	});

	it.each(["published", "revoked"] as const)(
		"retains %s versions on DELETE without exposing package refs",
		async (state) => {
			await seed(state);
			const before = await rows();
			try {
				await client`delete from platform.skill_hub_versions where id = 'version-a'`;
				expect.fail("Published version must be retained");
			} catch (error) {
				expect(error).toMatchObject({
					code: "23514",
					constraint_name: "skill_hub_version_retained",
					message: "Published Skill Version must be retained",
				});
			}
			expect(await rows()).toEqual(before);
		},
	);

	it.each(["pending_review", "rejected"] as const)(
		"keeps unpublished %s deletion and Skill updates available",
		async (state) => {
			await seed(state);
			await client`update platform.skill_hub_skills set status = 'disabled' where id = 'skill-a'`;
			await client`delete from platform.skill_hub_versions where id = 'version-a'`;
			expect(await rows()).toEqual([]);
			expect(
				await client`select status from platform.skill_hub_skills`,
			).toEqual([{ status: "disabled" }]);
		},
	);
});
