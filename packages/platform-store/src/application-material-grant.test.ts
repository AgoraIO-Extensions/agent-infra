import {
	type ApplicationMaterialGrantRequestV1,
	createApplicationMaterialGrantUseCaseV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresApplicationMaterialGrantStoreV1 } from "./application-material-grant.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresApplicationMaterialGrantStoreV1;
let competingStore: PostgresApplicationMaterialGrantStoreV1;
const actor = {
	userId: "admin-1",
	accountStatus: "active" as const,
	isSystemAdmin: true,
	ldapStableUid: "ldap-admin-1",
	ldapAdministratorConfigured: true,
	authorizationRevision: "auth-1",
};
function request(
	overrides: Partial<ApplicationMaterialGrantRequestV1> = {},
): ApplicationMaterialGrantRequestV1 {
	return {
		requestId: "request-1",
		traceId: "trace-1",
		actor,
		applicationId: "app-1",
		principalType: "user",
		principalId: "admin-1",
		...overrides,
	};
}
function useCase(selectedStore = store) {
	return createApplicationMaterialGrantUseCaseV1({
		store: selectedStore,
		resolveCurrentActor: async () => actor,
		resolveUser: async (id) =>
			id === "unknown" ? null : { accountStatus: "active" },
	});
}
async function snapshot() {
	const grants = await sql`
		select application_id, principal_type, principal_id,
			authorization_revision, revoked_at
		from platform.api_credential_delivery_grants
		order by application_id, principal_type, principal_id`;
	const audits = await sql`
		select action, target_type, target_id, outcome, details
		from platform.audit_events order by occurred_at, id`;
	return { grants: [...grants], audits: [...audits] };
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("material-grant");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 2 });
	store = new PostgresApplicationMaterialGrantStoreV1(database);
	competingStore = new PostgresApplicationMaterialGrantStoreV1(database);
}, 120_000);
beforeEach(async () => {
	await sql`truncate platform.platform_applications, platform.audit_events,
		platform.platform_user_disables cascade`;
	await sql`insert into platform.platform_applications
		(id, name, responsible_user_id, authorization_revision)
		values ('app-1', 'First application', 'manager-1', 'app-rev-1'),
		('app-2', 'Second application', 'manager-2', 'app-rev-2')`;
});
afterAll(async () => {
	await store?.close();
	await competingStore?.close();
	await sql?.end();
	await database?.stop();
});

// Real PostgreSQL with controlled identity ports; not HTTP or credential delivery acceptance.
describe("application material grant transaction", () => {
	it("requires an explicit self grant and returns only metadata through grant/read/revoke", async () => {
		const grants = useCase();
		expect(await grants.read(request())).toBeNull();
		const granted = await grants.grant(request());
		expect(Object.keys(granted.metadata).sort()).toEqual([
			"applicationId",
			"authorizationRevision",
			"createdAt",
			"principalId",
			"principalType",
			"revokedAt",
		]);
		expect(await grants.read(request())).toEqual(granted.metadata);
		const revoked = await grants.revoke(
			request({ expectedRevision: granted.metadata.authorizationRevision }),
		);
		expect(revoked.metadata.revokedAt).not.toBeNull();
		expect(await grants.read(request())).toEqual(revoked.metadata);
		const persisted = await snapshot();
		expect(persisted.grants).toHaveLength(1);
		expect(persisted.audits).toHaveLength(5);
		for (const audit of persisted.audits) {
			expect(audit.details).toEqual({ returnedMaterial: false });
			expect(audit.outcome).toBe("succeeded");
		}
	});

	it("rejects managers and unknown recipients without creating grants or success audits", async () => {
		await expect(
			useCase().grant(
				request({
					actor: { ...actor, userId: "manager-1", isSystemAdmin: false },
				}),
			),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(
			useCase().grant(request({ principalId: "unknown" })),
		).rejects.toMatchObject({ code: "not_found" });
		expect(await snapshot()).toEqual({ grants: [], audits: [] });
	});

	it("keeps same-ID user and application grants separate and rejects cross-application recipients", async () => {
		const grants = useCase();
		await grants.grant(request({ principalId: "app-1" }));
		const applicationRecipient = request({
			principalType: "application",
			principalId: "app-1",
		});
		expect(await grants.read(applicationRecipient)).toBeNull();
		expect(
			await grants.read(
				request({ applicationId: "app-2", principalId: "app-1" }),
			),
		).toBeNull();
		await expect(
			grants.grant({ ...applicationRecipient, applicationId: "app-2" }),
		).rejects.toMatchObject({ code: "not_found" });
		await grants.grant(applicationRecipient);
		expect((await snapshot()).grants.map((row) => row.principal_type)).toEqual([
			"application",
			"user",
		]);
	});

	it.each(["grant", "revoke"] as const)(
		"rolls back %s and its audit when audit persistence fails",
		async (operation) => {
			const grants = useCase();
			const granted =
				operation === "revoke" ? await grants.grant(request()) : null;
			const before = await snapshot();
			await sql`create function platform.fail_material_grant_audit()
				returns trigger language plpgsql as $$ begin
				raise exception 'controlled audit failure'; end $$`;
			await sql`create trigger fail_material_grant_audit
				before insert on platform.audit_events for each row
				execute function platform.fail_material_grant_audit()`;
			try {
				await expect(
					grants[operation](
						request(
							granted
								? { expectedRevision: granted.metadata.authorizationRevision }
								: {},
						),
					),
				).rejects.toThrow("grant audit unavailable");
				expect(await snapshot()).toEqual(before);
			} finally {
				await sql`drop trigger fail_material_grant_audit on platform.audit_events`;
				await sql`drop function platform.fail_material_grant_audit()`;
			}
		},
	);

	it("serializes competing revokes and rolls back the stale revision", async () => {
		const granted = await useCase().grant(request());
		const revoke = request({
			expectedRevision: granted.metadata.authorizationRevision,
		});
		const results = await Promise.allSettled([
			useCase().revoke(revoke),
			useCase(competingStore).revoke({ ...revoke, requestId: "request-2" }),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.find((result) => result.status === "rejected"),
		).toMatchObject({
			reason: { code: "idempotency_conflict" },
		});
		const persisted = await snapshot();
		expect(persisted.grants[0]?.revoked_at).not.toBeNull();
		expect(persisted.audits).toHaveLength(2);
	});

	it("rolls back the grant and success audit after administrator removal during a real lock wait", async () => {
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const blocker = competingStore.execute(async (transaction) => {
			await transaction.lockGrant(request());
			held.resolve();
			await release.promise;
		});
		let administratorConfigured = true;
		const grants = createApplicationMaterialGrantUseCaseV1({
			store,
			resolveUser: async () => ({ accountStatus: "active" }),
			resolveCurrentActor: async () => ({
				...actor,
				ldapAdministratorConfigured: administratorConfigured,
			}),
		});
		let result: Promise<unknown> | undefined;
		try {
			await Promise.race([held.promise, blocker]);
			result = grants.grant(request()).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			await expect
				.poll(async () => {
					const [row] = await sql`select count(*)::int as waiting
					from pg_stat_activity where datname = current_database()
					and wait_event_type = 'Lock' and wait_event = 'advisory'`;
					return row?.waiting;
				})
				.toBe(1);
			administratorConfigured = false;
		} finally {
			release.resolve();
			await Promise.allSettled([blocker, result]);
		}
		await blocker;
		expect(await result).toMatchObject({
			error: { code: "authentication_required" },
		});
		expect(await snapshot()).toEqual({ grants: [], audits: [] });
	});
});
