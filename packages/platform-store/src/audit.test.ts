import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	type PlatformAuditAdministratorScopeV1,
	PlatformAuditQueryError,
	PostgresPlatformAuditQueryV1,
} from "./audit.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

vi.setConfig({ testTimeout: 30_000 });

const administrator: PlatformAuditAdministratorScopeV1 = {
	schemaVersion: 1,
	kind: "administrator",
	administratorId: "user_admin",
};

describe("Platform audit query errors", () => {
	it("uses fixed messages without persistence details", async () => {
		const adapter = new PostgresPlatformAuditQueryV1({
			databaseUrl:
				"postgres://platform_user:database-secret@127.0.0.1:1/platform",
		});
		const error = await adapter
			.listAudit(administrator, { schemaVersion: 1, limit: 10 })
			.catch((failure: unknown) => failure);
		expect(error).toMatchObject({
			name: "PlatformAuditQueryError",
			code: "unavailable",
			message: "Platform audit persistence is unavailable",
		});
		expect(String(error)).not.toContain("database-secret");
		await adapter.close();
	});

	it("keeps access and request failures stable", () => {
		expect(new PlatformAuditQueryError("access_denied")).toMatchObject({
			code: "access_denied",
			message: "Platform audit is unavailable",
		});
		expect(new PlatformAuditQueryError("invalid_request")).toMatchObject({
			code: "invalid_request",
			message: "Invalid Platform audit request",
		});
	});
});

describe("PostgreSQL Platform audit query", () => {
	let adminClient: ReturnType<typeof postgres>;
	let databaseUrl = "";
	let testDatabase: PostgresTestDatabase | undefined;
	const adapters: PostgresPlatformAuditQueryV1[] = [];

	interface AuditFixture {
		readonly auditId: string;
		readonly occurredAt: Date | string;
		readonly traceId?: string;
		readonly actorType?: string;
		readonly actorId?: string;
		readonly action?: string;
		readonly targetType?: string;
		readonly targetId?: string;
		readonly outcome?: "succeeded" | "rejected" | "failed";
		readonly details?: Record<string, unknown> | null;
	}

	async function clearDatabase(): Promise<void> {
		await adminClient`truncate platform.audit_events`;
	}

	async function seedAudit({
		auditId,
		occurredAt,
		traceId = `trace_${auditId}`,
		actorType = "user",
		actorId = "user_actor",
		action = "agent.application.submitted",
		targetType = "agent_application",
		targetId = `application_${auditId}`,
		outcome = "succeeded",
		details = null,
	}: AuditFixture): Promise<void> {
		await adminClient`
			insert into platform.audit_events
				(id, trace_id, actor_type, actor_id, action, target_type,
				 target_id, outcome, occurred_at, details)
			values (${auditId}, ${traceId}, ${actorType}, ${actorId}, ${action},
				${targetType}, ${targetId}, ${outcome}, ${occurredAt}::timestamptz,
				${details === null ? null : adminClient.json(details as never)})
		`;
	}

	function openAdapter(): PostgresPlatformAuditQueryV1 {
		const adapter = new PostgresPlatformAuditQueryV1({ databaseUrl });
		adapters.push(adapter);
		return adapter;
	}

	beforeAll(async () => {
		testDatabase = await startPostgresTestDatabase("platform-audit");
		databaseUrl = testDatabase.databaseUrl;
		await migratePlatformDatabase({ databaseUrl });
		adminClient = postgres(databaseUrl, { max: 1 });
	});

	afterEach(async () => {
		await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
		await clearDatabase();
	});

	afterAll(async () => {
		await adminClient?.end();
		await testDatabase?.stop();
	});

	it("accepts only an exact server-resolved administrator scope", async () => {
		await seedAudit({
			auditId: "audit_authorized",
			occurredAt: new Date("2026-09-02T01:00:00.000Z"),
		});
		const adapter = openAdapter();
		expect(
			(await adapter.listAudit(administrator, { schemaVersion: 1, limit: 10 }))
				.items,
		).toHaveLength(1);

		for (const scope of [
			undefined,
			{},
			{ schemaVersion: 1, kind: "user", administratorId: "user_admin" },
			{ schemaVersion: 1, kind: "administrator", administratorId: "" },
			{
				schemaVersion: 1,
				kind: "administrator",
				administratorId: "user_admin",
				resourceId: "audit_authorized",
			},
		]) {
			await expect(
				adapter.listAudit(scope as PlatformAuditAdministratorScopeV1, {
					schemaVersion: 1,
					limit: 10,
				}),
			).rejects.toMatchObject({
				name: "PlatformAuditQueryError",
				code: "access_denied",
				message: "Platform audit is unavailable",
			});
		}
	});

	it("traverses equal timestamps once with a stable audit-id cursor", async () => {
		const equalTime = new Date("2026-09-02T02:00:00.000Z");
		await seedAudit({ auditId: "audit_c", occurredAt: equalTime });
		await seedAudit({ auditId: "audit_a", occurredAt: equalTime });
		await seedAudit({ auditId: "audit_b", occurredAt: equalTime });
		await seedAudit({
			auditId: "audit_older",
			occurredAt: new Date("2026-09-02T01:59:59.000Z"),
		});
		const adapter = openAdapter();
		const first = await adapter.listAudit(administrator, {
			schemaVersion: 1,
			limit: 2,
		});
		expect(first.items.map(({ auditId }) => auditId)).toEqual([
			"audit_c",
			"audit_b",
		]);
		expect(first.nextCursor).toBe("audit_b");

		const second = await adapter.listAudit(administrator, {
			schemaVersion: 1,
			limit: 2,
			cursor: first.nextCursor ?? undefined,
		});
		expect(second.items.map(({ auditId }) => auditId)).toEqual([
			"audit_a",
			"audit_older",
		]);
		expect(second.nextCursor).toBeNull();
	});

	it("preserves PostgreSQL microseconds while traversing one millisecond", async () => {
		await seedAudit({
			auditId: "audit_microsecond_900",
			occurredAt: "2026-09-02T02:30:00.000900Z",
		});
		await seedAudit({
			auditId: "audit_microsecond_500",
			occurredAt: "2026-09-02T02:30:00.000500Z",
		});
		await seedAudit({
			auditId: "audit_microsecond_100",
			occurredAt: "2026-09-02T02:30:00.000100Z",
		});
		const adapter = openAdapter();
		const auditIds: string[] = [];
		let cursor: string | undefined;
		for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
			const page = await adapter.listAudit(administrator, {
				schemaVersion: 1,
				limit: 1,
				...(cursor ? { cursor } : {}),
			});
			auditIds.push(...page.items.map(({ auditId }) => auditId));
			cursor = page.nextCursor ?? undefined;
		}
		expect(auditIds).toEqual([
			"audit_microsecond_900",
			"audit_microsecond_500",
			"audit_microsecond_100",
		]);
		expect(cursor).toBeUndefined();
	});

	it("does not pull concurrent later events into an existing traversal", async () => {
		await seedAudit({
			auditId: "audit_3",
			occurredAt: new Date("2026-09-02T03:00:03.000Z"),
		});
		await seedAudit({
			auditId: "audit_2",
			occurredAt: new Date("2026-09-02T03:00:02.000Z"),
		});
		await seedAudit({
			auditId: "audit_1",
			occurredAt: new Date("2026-09-02T03:00:01.000Z"),
		});
		const adapter = openAdapter();
		const first = await adapter.listAudit(administrator, {
			schemaVersion: 1,
			limit: 2,
		});
		await seedAudit({
			auditId: "audit_4_concurrent",
			occurredAt: new Date("2026-09-02T03:00:04.000Z"),
		});
		const second = await adapter.listAudit(administrator, {
			schemaVersion: 1,
			limit: 2,
			cursor: first.nextCursor ?? undefined,
		});
		expect([
			...first.items.map(({ auditId }) => auditId),
			...second.items.map(({ auditId }) => auditId),
		]).toEqual(["audit_3", "audit_2", "audit_1"]);
	});

	it("fails closed on malformed pages and stale cursors", async () => {
		const adapter = openAdapter();
		for (const page of [
			{ schemaVersion: 1, limit: 0 },
			{ schemaVersion: 1, limit: 101 },
			{ schemaVersion: 1, limit: 10, cursor: "" },
			{ schemaVersion: 1, limit: 10, cursor: "audit_missing" },
			{ schemaVersion: 1, limit: 10, afterId: "audit_hidden_tuple" },
		]) {
			await expect(
				adapter.listAudit(
					administrator,
					page as Parameters<typeof adapter.listAudit>[1],
				),
			).rejects.toMatchObject({ code: "invalid_request" });
		}
	});

	it("sanitizes real PostgreSQL query failures", async () => {
		const adapter = openAdapter();
		let renamed = false;
		try {
			await adminClient.unsafe(
				"alter table platform.audit_events rename to audit_events_unavailable_test",
			);
			renamed = true;
			const failure = await adapter
				.listAudit(administrator, { schemaVersion: 1, limit: 10 })
				.catch((error: unknown) => error);
			expect(failure).toMatchObject({
				name: "PlatformAuditQueryError",
				code: "unavailable",
				message: "Platform audit persistence is unavailable",
			});
			expect(String(failure)).not.toMatch(
				/audit_events|does not exist|select\s|postgres|drizzle/i,
			);
			expect(failure).not.toHaveProperty("cause");
		} finally {
			if (renamed) {
				await adminClient.unsafe(
					"alter table platform.audit_events_unavailable_test rename to audit_events",
				);
			}
		}
	});

	it("decodes only current Platform writer shapes and rejects raw details", async () => {
		const adapter = openAdapter();
		const malformed: readonly Omit<AuditFixture, "auditId" | "occurredAt">[] = [
			{ action: "connection.authorization.updated" },
			{ actorType: "system" },
			{ targetType: "agent" },
			{ details: { credential: "credential-plaintext" } },
			{
				action: "agent.configuration.revised",
				targetType: "agent",
				details: {
					changedFields: ["secrets"],
					secretValue: "secret-plaintext",
				},
			},
			{
				action: "agent.configuration.revised",
				targetType: "agent",
				details: { changedFields: ["conversationBody"] },
			},
			{
				action: "agent.configuration.revised",
				targetType: "agent",
				details: { changedFields: ["secrets", "environment"] },
			},
			{
				action: "agent.configuration.revised",
				targetType: "agent",
				details: { changedFields: ["secrets", "secrets"] },
			},
			{
				action: "agent.access.updated",
				targetType: "agent",
				details: { changedFields: ["secrets"] },
			},
		];
		for (const [index, fixture] of malformed.entries()) {
			await clearDatabase();
			await seedAudit({
				auditId: `audit_malformed_${index}`,
				occurredAt: new Date("2026-09-02T04:00:00.000Z"),
				...fixture,
			});
			const failure = await adapter
				.listAudit(administrator, { schemaVersion: 1, limit: 10 })
				.catch((error: unknown) => error);
			expect(failure).toMatchObject({
				name: "PlatformAuditQueryError",
				code: "unavailable",
				message: "Platform audit persistence is unavailable",
			});
			expect(JSON.stringify(failure)).not.toMatch(
				/credential-plaintext|secret-plaintext|conversationBody/,
			);
		}
	});

	it("returns only whitelisted metadata and normalizes rejected outcomes", async () => {
		await seedAudit({
			auditId: "audit_configuration",
			occurredAt: new Date("2026-09-02T05:00:00.000Z"),
			action: "agent.configuration.revised",
			targetType: "agent",
			targetId: "agent_safe",
			details: { changedFields: ["environment", "secrets"] },
		});
		await seedAudit({
			auditId: "audit_rejected",
			occurredAt: new Date("2026-09-02T04:59:59.000Z"),
			action: "agent.application.rejected",
			outcome: "rejected",
		});
		const page = await openAdapter().listAudit(administrator, {
			schemaVersion: 1,
			limit: 10,
		});
		expect(page.items).toEqual([
			{
				schemaVersion: 1,
				auditId: "audit_configuration",
				actor: { kind: "user", actorId: "user_actor" },
				action: "agent.configuration.revised",
				subject: { kind: "agent", subjectId: "agent_safe" },
				result: "succeeded",
				summary: "agent.configuration.revised: environment, secrets",
				occurredAt: new Date("2026-09-02T05:00:00.000Z"),
				traceId: "trace_audit_configuration",
			},
			expect.objectContaining({
				auditId: "audit_rejected",
				result: "failed",
				summary: "agent.application.rejected",
			}),
		]);
		expect(JSON.stringify(page)).not.toMatch(
			/secretValue|credential|conversation|runtime|kubernetes|deployment/,
		);
	});

	it("projects Secret lifecycle audits without exposing key metadata", async () => {
		await seedAudit({
			auditId: "audit_secret_decrypt",
			occurredAt: new Date("2026-09-02T06:00:00.000Z"),
			actorType: "system",
			actorId: "platform-worker",
			action: "secret.decrypt",
			targetType: "secret",
			targetId: "credential_01",
			outcome: "succeeded",
			details: {
				wrappingKeyVersion: "key_01",
				operation: "decrypt",
				result: "succeeded",
			},
		});

		const page = await openAdapter().listAudit(administrator, {
			schemaVersion: 1,
			limit: 10,
		});
		expect(page.items).toEqual([
			{
				schemaVersion: 1,
				auditId: "audit_secret_decrypt",
				actor: { kind: "system", actorId: "platform-worker" },
				action: "secret.decrypt",
				subject: { kind: "secret", subjectId: "credential_01" },
				result: "succeeded",
				summary: "secret.decrypt",
				occurredAt: new Date("2026-09-02T06:00:00.000Z"),
				traceId: "trace_audit_secret_decrypt",
			},
		]);
		expect(JSON.stringify(page)).not.toContain("key_01");
	});
});
