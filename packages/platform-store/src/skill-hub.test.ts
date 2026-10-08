import { ScopedPlatformAuditProjectionV1Schema } from "@agent-infra/contracts/pilot";
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
import { decodePlatformAuditRowV1 } from "./audit.js";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { PostgresSkillHubLifecycleV1 } from "./skill-hub.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;
const stores: PostgresSkillHubLifecycleV1[] = [];
const identity = (
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
	authorizationRevision: "identity-1",
});
let identities: Map<string, SkillHubIdentitySnapshotV1>;
const request = (userId = "owner-a") => ({
	userId,
	requestId: "request-a",
	traceId: "trace-a",
});
const registration = (
	visibility: "PRIVATE" | "MEMBER" | "ORGANIZATION" | "MARKET" = "PRIVATE",
) => ({
	schemaVersion: 1,
	name: "summary",
	skillId: "skill-a",
	skillVersionId: "version-a",
	visibility,
	provider: "my_library",
	version: "1.0.0",
	packageObjectVersion: "object-a",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	...(visibility === "ORGANIZATION" ? { organizationId: "org-a" } : {}),
});
function store(
	resolveIdentity: (userId: string) => Promise<unknown> = async (userId) =>
		identities.get(userId) ?? null,
) {
	const result = new PostgresSkillHubLifecycleV1({
		databaseUrl: database?.databaseUrl ?? "",
		resolveIdentity,
	});
	stores.push(result);
	return result;
}
async function counts() {
	const [row] = await client`select
		(select count(*)::integer from platform.skill_hub_skills) as skills,
		(select count(*)::integer from platform.skill_hub_versions) as versions,
		(select count(*)::integer from platform.idempotency_records where scope_type = 'skill_version') as idempotency,
		(select count(*)::integer from platform.audit_events where outcome = 'succeeded') as success_audits`;
	return row;
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("skill-hub-lifecycle");
	client = postgres(database.databaseUrl, { max: 1 });
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
});
beforeEach(async () => {
	await client`truncate platform.skill_hub_skills, platform.skill_hub_versions, platform.idempotency_records, platform.audit_events, platform.platform_user_disables cascade`;
	identities = new Map([
		["owner-a", identity("owner-a")],
		["owner-b", identity("owner-b")],
		["admin", identity("admin", true)],
	]);
});
afterAll(async () => {
	for (const adapter of stores) await adapter.close();
	await client?.end();
	await database?.stop();
});

describe("Skill Hub PostgreSQL lifecycle", () => {
	it("registers PRIVATE metadata for the current owner and replays current state after revocation", async () => {
		const adapter = store();
		const first = await adapter.registerVersion(
			request(),
			"register-a",
			registration(),
		);
		expect(first).toMatchObject({
			replayed: false,
			version: {
				ownerId: "owner-a",
				state: "published",
				packageDigest: "a".repeat(64),
			},
		});
		await adapter.revokeVersion(request(), "version-a", "revoke-a");
		const replay = await adapter.registerVersion(
			request(),
			"register-a",
			registration(),
		);
		expect(replay).toMatchObject({
			replayed: true,
			version: {
				skillVersionId: first.version.skillVersionId,
				state: "revoked",
			},
		});
		expect(await counts()).toEqual({
			skills: 1,
			versions: 1,
			idempotency: 2,
			success_audits: 3,
		});
		const revoked = replay.version.revokedAt;
		expect(
			(await adapter.revokeVersion(request(), "version-a", "revoke-a")).version
				.revokedAt,
		).toBe(revoked);
	});

	it.each(["MEMBER", "ORGANIZATION", "MARKET"] as const)(
		"keeps %s metadata pending and persists independent admin approval",
		async (visibility) => {
			const adapter = store();
			expect(
				(
					await adapter.registerVersion(
						request(),
						"register-a",
						registration(visibility),
					)
				).version.state,
			).toBe("pending_review");
			const approved = await adapter.reviewVersion(
				request("admin"),
				"version-a",
				"review-a",
				{ decision: "approve" },
			);
			expect(approved.version).toMatchObject({
				state: "published",
				reviewedBy: "admin",
				visibility,
			});
			await adapter.revokeVersion(request("admin"), "version-a", "revoke-a");
			expect(
				(
					await adapter.reviewVersion(
						request("admin"),
						"version-a",
						"review-a",
						{ decision: "approve" },
					)
				).version.state,
			).toBe("revoked");
		},
	);

	it("persists rejected state but excludes the reason and object references from audit", async () => {
		const adapter = store();
		await adapter.registerVersion(
			request(),
			"register-a",
			registration("MARKET"),
		);
		const rejected = await adapter.reviewVersion(
			request("admin"),
			"version-a",
			"review-a",
			{ decision: "reject", reason: "private-review-text" },
		);
		expect(rejected.version).toMatchObject({
			state: "rejected",
			reviewReason: "private-review-text",
		});
		const audits =
			await client`select id as "auditId", trace_id as "traceId", actor_type as "actorType", actor_id as "actorId",
			action, target_type as "targetType", target_id as "targetId", outcome, occurred_at as "occurredAt", details
			from platform.audit_events order by occurred_at`;
		expect(
			audits.map(
				(row) =>
					decodePlatformAuditRowV1(
						row as Parameters<typeof decodePlatformAuditRowV1>[0],
					).subject.subjectId,
			),
		).toEqual(["version-a", "version-a"]);
		for (const row of audits) {
			const projection = decodePlatformAuditRowV1(
				row as Parameters<typeof decodePlatformAuditRowV1>[0],
			);
			expect(
				ScopedPlatformAuditProjectionV1Schema.safeParse({
					...projection,
					occurredAt: projection.occurredAt.toISOString(),
					taskApi: null,
					requestId: "request-a",
					agentId: null,
					conversationId: null,
					executionId: null,
					authorizationRecordId: null,
					originalPrincipal: null,
					executor: null,
					operation: null,
				}).success,
			).toBe(true);
		}
		const encoded = JSON.stringify(audits);
		for (const value of [
			"private-review-text",
			"object-a",
			"a".repeat(64),
			"b".repeat(64),
			"c".repeat(64),
		])
			expect(encoded).not.toContain(value);
	});

	it("does not accept caller ownership or privileges as registration fields", async () => {
		const adapter = store();
		for (const field of [
			"ownerId",
			"isAdministrator",
			"path",
			"url",
			"verified",
			"grant",
		]) {
			await expect(
				adapter.registerVersion(request(), `invalid-${field}`, {
					...registration(),
					[field]: "foreign",
				}),
			).rejects.toMatchObject({ code: "invalid_input" });
		}
		expect(await counts()).toEqual({
			skills: 0,
			versions: 0,
			idempotency: 0,
			success_audits: 0,
		});
	});

	it("protects creator ownership even from a second administrator registration", async () => {
		const adapter = store();
		await adapter.registerVersion(request(), "register-a", registration());
		await expect(
			adapter.registerVersion(request("admin"), "register-b", {
				...registration(),
				skillVersionId: "version-b",
				version: "2.0.0",
			}),
		).rejects.toMatchObject({ code: "not_found" });
		expect(await counts()).toMatchObject({
			skills: 1,
			versions: 1,
			idempotency: 1,
		});
	});

	it("returns the same absence error for foreign and missing metadata without leaking targets in refusal audits", async () => {
		const adapter = store();
		await adapter.registerVersion(request(), "register-a", registration());
		for (const id of ["version-a", "missing"]) {
			await expect(
				adapter.readVersion(request("owner-b"), id),
			).rejects.toMatchObject({
				code: "not_found",
				message: "Skill Hub operation rejected",
			});
		}
		const refused =
			await client`select target_id, details from platform.audit_events where action = 'skill.version.refused'`;
		expect(refused).toEqual([
			{ target_id: "unknown", details: { reason: "not_found" } },
			{ target_id: "unknown", details: { reason: "not_found" } },
		]);
		expect((await adapter.readVersion(request(), "version-a")).ownerId).toBe(
			"owner-a",
		);
		expect(
			(await adapter.readVersion(request("admin"), "version-a")).ownerId,
		).toBe("owner-a");
	});

	it("rejects non-admin review uniformly and prevents admin owner self-review", async () => {
		const adapter = store();
		await adapter.registerVersion(
			request(),
			"register-a",
			registration("MARKET"),
		);
		for (const id of ["version-a", "missing"])
			await expect(
				adapter.reviewVersion(request("owner-b"), id, "review-a", {
					decision: "approve",
				}),
			).rejects.toMatchObject({ code: "forbidden" });
		identities.set("owner-a", identity("owner-a", true));
		await expect(
			adapter.reviewVersion(request(), "version-a", "review-a", {
				decision: "approve",
			}),
		).rejects.toMatchObject({ code: "owner_cannot_review" });
		expect((await adapter.readVersion(request(), "version-a")).state).toBe(
			"pending_review",
		);
	});

	it("rejects conflicting keys, new-key duplicate versions and same-name different aggregates", async () => {
		const adapter = store();
		await adapter.registerVersion(request(), "register-a", registration());
		await expect(
			adapter.registerVersion(request(), "register-a", {
				...registration(),
				packageDigest: "d".repeat(64),
			}),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		await expect(
			adapter.registerVersion(request(), "register-b", registration()),
		).rejects.toMatchObject({ code: "version_conflict" });
		await expect(
			adapter.registerVersion(request(), "register-c", {
				...registration(),
				skillId: "skill-b",
				skillVersionId: "version-b",
				version: "2.0.0",
			}),
		).rejects.toMatchObject({ code: "version_conflict" });
		expect(await counts()).toMatchObject({
			skills: 1,
			versions: 1,
			idempotency: 1,
		});
	});

	it("isolates actor and command scopes when reusing an idempotency key", async () => {
		const adapter = store();
		await adapter.registerVersion(request(), "same-key", registration());
		await adapter.registerVersion(request("owner-b"), "same-key", {
			...registration(),
			skillId: "skill-b",
			skillVersionId: "version-b",
		});
		await adapter.revokeVersion(request(), "version-a", "same-key");
		expect(await counts()).toMatchObject({
			skills: 2,
			versions: 2,
			idempotency: 3,
		});
	});

	it("serializes real concurrent retries across independent pools", async () => {
		const first = store();
		const second = store();
		const results = await Promise.all([
			first.registerVersion(request(), "register-a", registration()),
			second.registerVersion(request(), "register-a", registration()),
		]);
		expect(results.map((result) => result.replayed).sort()).toEqual([
			false,
			true,
		]);
		expect(await counts()).toEqual({
			skills: 1,
			versions: 1,
			idempotency: 1,
			success_audits: 2,
		});
	});

	it("does not let concurrent review commands overwrite the winning decision", async () => {
		const first = store();
		const second = store();
		await first.registerVersion(
			request(),
			"register-a",
			registration("MARKET"),
		);
		const results = await Promise.allSettled([
			first.reviewVersion(request("admin"), "version-a", "review-a", {
				decision: "approve",
			}),
			second.reviewVersion(request("admin"), "version-a", "review-b", {
				decision: "reject",
				reason: "Not approved",
			}),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.find((result) => result.status === "rejected"),
		).toMatchObject({ reason: { code: "invalid_transition" } });
		expect(await counts()).toMatchObject({ versions: 1, idempotency: 2 });
	});

	it("fails a replay if an unpublished version id was deleted and reused", async () => {
		const adapter = store();
		await adapter.registerVersion(
			request(),
			"register-a",
			registration("MARKET"),
		);
		await adapter.reviewVersion(request("admin"), "version-a", "review-a", {
			decision: "reject",
			reason: "Not approved",
		});
		await client`delete from platform.skill_hub_versions where id = 'version-a'`;
		await adapter.registerVersion(request(), "register-b", {
			...registration("MARKET"),
			packageDigest: "d".repeat(64),
		});
		await expect(
			adapter.registerVersion(request(), "register-a", registration("MARKET")),
		).rejects.toMatchObject({ code: "unavailable" });
	});

	it.each([
		"LDAP disabled",
		"platform disabled",
		"missing",
		"wrong user",
		"dependency failure",
	])("fails closed on %s identity", async (mode) => {
		if (mode === "LDAP disabled")
			identities.set("owner-a", {
				...identity("owner-a"),
				actor: { ...identity("owner-a").actor, accountStatus: "disabled" },
			});
		if (mode === "platform disabled")
			await client`insert into platform.platform_user_disables (user_id) values ('owner-a')`;
		const adapter = store(async (userId) => {
			if (mode === "missing") return null;
			if (mode === "wrong user") return identity("foreign");
			if (mode === "dependency failure")
				throw new Error("private-identity-response");
			return identities.get(userId);
		});
		await expect(
			adapter.registerVersion(request(), "register-a", registration()),
		).rejects.toMatchObject({
			code:
				mode === "wrong user" || mode === "dependency failure"
					? "unavailable"
					: "forbidden",
			message: "Skill Hub operation rejected",
		});
		expect(await counts()).toEqual({
			skills: 0,
			versions: 0,
			idempotency: 0,
			success_audits: 0,
		});
	});

	it.each(["revision", "role", "disabled"])(
		"rolls back metadata, idempotency and successful audit when final %s changes",
		async (mode) => {
			let calls = 0;
			const adapter = store(async (userId) => {
				calls++;
				const current = identity(userId);
				if (calls === 2) {
					if (mode === "revision")
						return { ...current, authorizationRevision: "identity-2" };
					if (mode === "role")
						return {
							...current,
							actor: { ...current.actor, isAdministrator: true },
						};
					return {
						...current,
						actor: { ...current.actor, accountStatus: "disabled" },
					};
				}
				return current;
			});
			await expect(
				adapter.registerVersion(request(), "register-a", registration()),
			).rejects.toMatchObject({
				code: mode === "disabled" ? "forbidden" : "unavailable",
			});
			expect(calls).toBe(2);
			expect(await counts()).toEqual({
				skills: 0,
				versions: 0,
				idempotency: 0,
				success_audits: 0,
			});
		},
	);

	it.each([false, true])(
		"rolls back every business record on audit failure (deferred=%s)",
		async (deferred) => {
			await client.unsafe(
				"create function platform.skill_hub_audit_failure() returns trigger language plpgsql as $$ begin raise exception 'injected audit failure'; end $$",
			);
			await client.unsafe(
				`create ${deferred ? "constraint " : ""}trigger skill_hub_audit_failure ${deferred ? "after" : "before"} insert on platform.audit_events ${deferred ? "deferrable initially deferred" : ""} for each row execute function platform.skill_hub_audit_failure()`,
			);
			try {
				await expect(
					store().registerVersion(request(), "register-a", registration()),
				).rejects.toMatchObject({ code: "unavailable" });
				expect(await counts()).toEqual({
					skills: 0,
					versions: 0,
					idempotency: 0,
					success_audits: 0,
				});
			} finally {
				await client`drop trigger skill_hub_audit_failure on platform.audit_events`;
				await client`drop function platform.skill_hub_audit_failure()`;
			}
		},
	);
});
