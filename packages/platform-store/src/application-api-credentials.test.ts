import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type ApplicationCredentialAttemptV1,
	type ApplicationCredentialDeliveryPortV1,
	createApplicationApiCredentialIssuerV1,
	createApplicationMaterialGrantUseCaseV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresApplicationApiCredentialIssuerStoreV1 } from "./application-api-credentials.js";
import { PostgresApplicationMaterialGrantStoreV1 } from "./application-material-grant.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresApplicationApiCredentialIssuerStoreV1;
let grantsStore: PostgresApplicationMaterialGrantStoreV1;
const actor = {
	userId: "admin",
	accountStatus: "active" as const,
	isSystemAdmin: true,
	ldapStableUid: "ldap-admin",
	ldapAdministratorConfigured: true,
	authorizationRevision: "admin-v1",
};
const directory = {
	resolveUser: async (userId: string) => ({
		schemaVersion: 1 as const,
		userId,
		accountStatus: "active" as const,
		organizationIds: [],
		authorizationRevision: "user-v1",
	}),
};
const request = {
	applicationId: "app-1",
	userId: "manager",
	requestId: "request-1",
	traceId: "trace-1",
	idempotencyKey: "issue-1",
};
const command = {
	operation: "issue",
	recipient: { principalType: "user", principalId: "recipient" },
	scopes: ["agent:use"],
	expiresAt: null,
};
function grants() {
	return createApplicationMaterialGrantUseCaseV1({
		store: grantsStore,
		resolveCurrentActor: async () => actor,
		resolveUser: async () => ({ accountStatus: "active" }),
	});
}
function grantRequest() {
	return {
		requestId: "grant-request",
		traceId: "grant-trace",
		actor,
		applicationId: "app-1",
		principalType: "user" as const,
		principalId: "recipient",
	};
}
function sink() {
	const pending = new Map<string, string>();
	const accepted: string[] = [];
	const port: ApplicationCredentialDeliveryPortV1 = {
		async prepare(attempt, material) {
			pending.set(attempt.attemptId, material);
		},
		async commit(attempt, signal) {
			signal.throwIfAborted();
			if (Date.now() >= Date.parse(attempt.expiresAt))
				throw new Error("expired");
			const material = pending.get(attempt.attemptId);
			if (!material) throw new Error("missing");
			pending.delete(attempt.attemptId);
			accepted.push(material);
			return "accepted";
		},
		abort(attempt) {
			pending.delete(attempt.attemptId);
		},
	};
	return { port, accepted, pending };
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("application-issuer-1277");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { max: 4 });
	store = new PostgresApplicationApiCredentialIssuerStoreV1(database);
	grantsStore = new PostgresApplicationMaterialGrantStoreV1(database);
}, 120_000);
beforeEach(async () => {
	await sql`truncate platform.platform_applications, platform.platform_api_credentials, platform.idempotency_records, platform.audit_events, platform.platform_user_disables cascade`;
	await sql`insert into platform.platform_applications (id,name,responsible_user_id,authorization_revision) values ('app-1','Application','manager','app-v1')`;
});
afterAll(async () => {
	await store?.close();
	await grantsStore?.close();
	await sql?.end();
	await database?.stop();
});

describe("application issuer with real PostgreSQL and a controlled recipient", () => {
	it("delivers once, replays only metadata, and rotates the known old credential", async () => {
		await grants().grant(grantRequest());
		const delivery = sink();
		const issuer = createApplicationApiCredentialIssuerV1({
			store,
			userDirectory: directory,
			delivery: delivery.port,
		});
		const first = await issuer.execute(request, command);
		expect(first.delivery.status).toBe("accepted");
		expect(delivery.accepted).toHaveLength(1);
		const [row] = await sql`select * from platform.platform_api_credentials`;
		expect(row?.principal_type).toBe("application");
		expect(row?.principal_id).toBe("app-1");
		expect(
			row?.credential_hash ===
				createHash("sha256")
					.update(delivery.accepted[0] ?? "")
					.digest("hex"),
		).toBe(true);
		const replay = await issuer.execute(request, command);
		expect(replay.replayed).toBe(true);
		expect(delivery.accepted).toHaveLength(1);
		await expect(
			issuer.execute(request, { ...command, scopes: ["agent:read"] }),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
		const rotated = await issuer.execute(
			{ ...request, idempotencyKey: "rotate-1" },
			{
				...command,
				operation: "rotate",
				credentialId: first.metadata.credentialId,
			},
		);
		expect(rotated.metadata.credentialId).not.toBe(first.metadata.credentialId);
		expect(delivery.accepted).toHaveLength(2);
		const [rotationAudit] =
			await sql`select details from platform.audit_events where action='application.credential.rotated'`;
		expect(rotationAudit?.details.previousCredentialId).toBe(
			first.metadata.credentialId,
		);
		expect(rotationAudit?.details.credentialId).toBe(
			rotated.metadata.credentialId,
		);
		expect(
			await sql`select id from platform.platform_api_credentials where revoked_at is null`,
		).toHaveLength(1);
		expect(
			(await issuer.execute(request, command)).metadata.revokedAt,
		).not.toBeNull();
		const persisted = JSON.stringify(
			await sql`select result from platform.idempotency_records`,
		);
		const audits = JSON.stringify(
			await sql`select details from platform.audit_events`,
		);
		for (const material of delivery.accepted) {
			expect(persisted.includes(material)).toBe(false);
			expect(audits.includes(material)).toBe(false);
			expect(JSON.stringify(first).includes(material)).toBe(false);
		}
	});
	it.each([
		["issue", 2],
		["issue", 3],
		["issue", 4],
		["rotate", 2],
		["rotate", 3],
		["rotate", 4],
	] as const)(
		"fences %s when the active recipient revision changes at check %i",
		async (operation, changeAt) => {
			await grants().grant(grantRequest());
			const previous =
				operation === "rotate"
					? await createApplicationApiCredentialIssuerV1({
							store,
							userDirectory: directory,
							delivery: sink().port,
						}).execute(request, command)
					: undefined;
			const beforeCredentials =
				await sql`select * from platform.platform_api_credentials order by id`;
			const beforeReceipts =
				await sql`select * from platform.idempotency_records order by idempotency_key`;
			const beforeAudits =
				await sql`select * from platform.audit_events order by id`;
			let reads = 0;
			const delivery = sink();
			const issuer = createApplicationApiCredentialIssuerV1({
				store,
				userDirectory: {
					resolveUser: async (userId) => ({
						...(await directory.resolveUser(userId)),
						authorizationRevision:
							userId === "recipient" && ++reads >= changeAt
								? "user-v2"
								: "user-v1",
					}),
				},
				delivery: delivery.port,
			});
			const raceRequest = { ...request, idempotencyKey: "revision-race" };
			const raceCommand = previous
				? {
						...command,
						operation: "rotate",
						credentialId: previous.metadata.credentialId,
					}
				: command;
			await expect(
				issuer.execute(raceRequest, raceCommand),
			).rejects.toMatchObject({ code: "forbidden" });
			expect(delivery.accepted.length).toBe(0);
			expect(delivery.pending.size).toBe(0);
			if (changeAt === 2) {
				expect(
					isDeepStrictEqual(
						await sql`select * from platform.platform_api_credentials order by id`,
						beforeCredentials,
					),
				).toBe(true);
				expect(
					await sql`select * from platform.idempotency_records order by idempotency_key`,
				).toEqual(beforeReceipts);
				expect(
					await sql`select * from platform.audit_events order by id`,
				).toEqual(beforeAudits);
			} else {
				const replay = await issuer.execute(raceRequest, raceCommand);
				expect(replay.replayed).toBe(true);
				expect(replay.delivery.status).toBe("unknown");
				expect(delivery.accepted.length).toBe(0);
				expect(
					await sql`select id from platform.platform_api_credentials where revoked_at is null`,
				).toHaveLength(1);
				if (previous) {
					const [old] =
						await sql`select revoked_at from platform.platform_api_credentials where id = ${previous.metadata.credentialId}`;
					expect(old?.revoked_at).not.toBeNull();
				}
				const [audit] =
					await sql`select outcome from platform.audit_events where action = 'application.credential.delivery' and details->>'credentialId' = ${replay.metadata.credentialId}`;
				expect(audit?.outcome).toBe("failed");
			}
		},
	);
	it("rejects manager without grant, admin without management, and cross-type recipient", async () => {
		const delivery = sink();
		const issuer = createApplicationApiCredentialIssuerV1({
			store,
			userDirectory: directory,
			delivery: delivery.port,
		});
		await expect(issuer.execute(request, command)).rejects.toMatchObject({
			code: "forbidden",
		});
		await grants().grant(grantRequest());
		await expect(
			issuer.execute({ ...request, userId: "admin" }, command),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			issuer.execute(request, {
				...command,
				recipient: { principalType: "application", principalId: "recipient" },
			}),
		).rejects.toMatchObject({ code: "not_found" });
		expect(delivery.accepted).toHaveLength(0);
		expect(
			await sql`select id from platform.platform_api_credentials`,
		).toHaveLength(0);
	});
	it("serializes concurrent identical requests without orphan credentials or duplicate delivery", async () => {
		await grants().grant(grantRequest());
		const delivery = sink();
		const issuer = createApplicationApiCredentialIssuerV1({
			store,
			userDirectory: directory,
			delivery: delivery.port,
		});
		const results = await Promise.all(
			Array.from({ length: 4 }, () => issuer.execute(request, command)),
		);
		expect(new Set(results.map((r) => r.metadata.credentialId)).size).toBe(1);
		expect(delivery.accepted).toHaveLength(1);
		expect(
			await sql`select id from platform.platform_api_credentials`,
		).toHaveLength(1);
	});
	it("rolls back initial audit failure before preparing any material", async () => {
		await grants().grant(grantRequest());
		await sql`create function platform.fail_issuer_audit() returns trigger language plpgsql as $$ begin raise exception 'controlled'; end $$`;
		await sql`create trigger fail_issuer_audit before insert on platform.audit_events for each row execute function platform.fail_issuer_audit()`;
		const delivery = sink();
		try {
			await expect(
				createApplicationApiCredentialIssuerV1({
					store,
					userDirectory: directory,
					delivery: delivery.port,
				}).execute(request, command),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(
				await sql`select id from platform.platform_api_credentials`,
			).toHaveLength(0);
			expect(
				await sql`select id from platform.idempotency_records`,
			).toHaveLength(0);
			expect(delivery.pending.size).toBe(0);
		} finally {
			await sql`drop trigger fail_issuer_audit on platform.audit_events`;
			await sql`drop function platform.fail_issuer_audit()`;
		}
	});
	it("rechecks grant after prepare and never commits after revocation", async () => {
		const granted = await grants().grant(grantRequest());
		const delivery = sink();
		const prepare = delivery.port.prepare;
		delivery.port.prepare = async (
			attempt: ApplicationCredentialAttemptV1,
			material: string,
		) => {
			await prepare(attempt, material, new AbortController().signal);
			await grants().revoke({
				...grantRequest(),
				expectedRevision: granted.metadata.authorizationRevision,
			});
		};
		await expect(
			createApplicationApiCredentialIssuerV1({
				store,
				userDirectory: directory,
				delivery: delivery.port,
			}).execute(request, command),
		).rejects.toMatchObject({ code: "forbidden" });
		expect(delivery.accepted).toHaveLength(0);
		expect(delivery.pending.size).toBe(0);
		const [row] =
			await sql`select result->'result'->'delivery'->>'status' as status from platform.idempotency_records`;
		expect(row?.status).toBe("unknown");
	});
	it("does not resend an unknown delivery and requires explicit rotation", async () => {
		await grants().grant(grantRequest());
		const delivery = sink();
		delivery.port.commit = async () => {
			throw new Error("controlled response loss");
		};
		const issuer = createApplicationApiCredentialIssuerV1({
			store,
			userDirectory: directory,
			delivery: delivery.port,
		});
		await expect(issuer.execute(request, command)).rejects.toMatchObject({
			code: "unavailable",
		});
		const replay = await issuer.execute(request, command);
		expect(replay.replayed).toBe(true);
		expect(replay.delivery.status).toBe("unknown");
		expect(delivery.accepted).toHaveLength(0);
		expect(
			await sql`select id from platform.platform_api_credentials`,
		).toHaveLength(1);
	});
	it("bounds a hung delivery, releases revoke locks, and fences a late acceptance", async () => {
		const granted = await grants().grant(grantRequest());
		const delivery = sink();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		const commit = delivery.port.commit;
		delivery.port.commit = async (attempt, signal) => {
			entered.resolve();
			try {
				await release.promise;
				signal.throwIfAborted();
				return await commit(attempt, signal);
			} finally {
				finished.resolve();
			}
		};
		const issuer = createApplicationApiCredentialIssuerV1({
			store,
			userDirectory: directory,
			delivery: delivery.port,
		});
		const issuing = issuer
			.execute(request, {
				...command,
				expiresAt: new Date(Date.now() + 1200).toISOString(),
			})
			.then(
				() => "unexpected-success",
				(error: unknown) => (error as { code: string }).code,
			);
		await entered.promise;
		const revoking = grants().revoke({
			...grantRequest(),
			expectedRevision: granted.metadata.authorizationRevision,
		});
		try {
			expect(await issuing).toBe("unavailable");
			expect((await revoking).metadata.revokedAt).not.toBeNull();
		} finally {
			release.resolve();
		}
		await finished.promise;
		expect(delivery.accepted.length).toBe(0);
		expect(delivery.pending.size).toBe(0);
	}, 5000);
	it("rejects revocation in the persisted in-flight window", async () => {
		const granted = await grants().grant(grantRequest());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let transactions = 0;
		const delivery = sink();
		const issuer = createApplicationApiCredentialIssuerV1({
			store: {
				async execute(work) {
					if (++transactions === 3) {
						entered.resolve();
						await release.promise;
					}
					return store.execute(work);
				},
			},
			userDirectory: directory,
			delivery: delivery.port,
		});
		const issuing = issuer.execute(request, command);
		await entered.promise;
		try {
			await expect(
				grants().revoke({
					...grantRequest(),
					expectedRevision: granted.metadata.authorizationRevision,
				}),
			).rejects.toMatchObject({ code: "idempotency_conflict" });
		} finally {
			release.resolve();
		}
		expect((await issuing).delivery.status).toBe("accepted");
	});
	it.each(["delivery_pending", "delivery_in_flight"])(
		"normalizes expired %s recovery state without resending",
		async (status) => {
			await grants().grant(grantRequest());
			const delivery = sink();
			const issuer = createApplicationApiCredentialIssuerV1({
				store,
				userDirectory: directory,
				delivery: delivery.port,
			});
			const issued = await issuer.execute(request, command);
			// Fault injection of a postcommit recovery receipt; credential was issued by production Core/Store.
			await sql`update platform.idempotency_records set result = jsonb_set(jsonb_set(result, '{result,delivery,status}', to_jsonb(${status}::text)), '{expiresAt}', '"2000-01-01T00:00:00Z"'::jsonb)`;
			const replay = await issuer.execute(request, command);
			expect(replay.delivery.status).toBe("unknown");
			expect(delivery.accepted.length).toBe(1);
			const [row] =
				await sql`select result->'result'->'delivery'->>'status' as status from platform.idempotency_records`;
			expect(row?.status).toBe("unknown");
			await issuer.execute(
				{ ...request, idempotencyKey: "rotate-recovery" },
				{
					...command,
					operation: "rotate",
					credentialId: issued.metadata.credentialId,
				},
			);
			expect(
				await sql`select id from platform.platform_api_credentials where revoked_at is null`,
			).toHaveLength(1);
		},
	);
	it.each(["manager", "recipient", "application"])(
		"refuses current disabled %s without issuing",
		async (target) => {
			await grants().grant(grantRequest());
			if (target === "application")
				await sql`update platform.platform_applications set status='disabled' where id='app-1'`;
			else
				await sql`insert into platform.platform_user_disables (user_id) values (${target})`;
			const delivery = sink();
			await expect(
				createApplicationApiCredentialIssuerV1({
					store,
					userDirectory: directory,
					delivery: delivery.port,
				}).execute(request, command),
			).rejects.toMatchObject({
				code: target === "application" ? "not_found" : "forbidden",
			});
			expect(delivery.accepted.length).toBe(0);
			expect(
				await sql`select id from platform.platform_api_credentials`,
			).toHaveLength(0);
		},
	);
	it("fails closed with no consumer and rejects expired issuance", async () => {
		await grants().grant(grantRequest());
		await expect(
			createApplicationApiCredentialIssuerV1({
				store,
				userDirectory: directory,
				delivery: undefined,
			}).execute(request, command),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			createApplicationApiCredentialIssuerV1({
				store,
				userDirectory: directory,
				delivery: sink().port,
			}).execute(request, { ...command, expiresAt: "2000-01-01T00:00:00Z" }),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(
			await sql`select id from platform.platform_api_credentials`,
		).toHaveLength(0);
	});
});
