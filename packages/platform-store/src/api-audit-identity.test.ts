import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TaskUserDirectoryV1 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveApiAuditCredentialIdentityV1 } from "./api-audit-identity.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("api-audit-identity");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 4 });
}, 120_000);
afterAll(async () => {
	await sql?.end();
	await database?.stop();
});

const user = (id: string, revision = "current-1") => ({
	schemaVersion: 1,
	userId: id,
	accountStatus: "active",
	organizationIds: [],
	authorizationRevision: revision,
});
async function seed(
	kind: "user" | "application",
	id = randomUUID(),
	scopes = ["agent:use"],
) {
	const material = `papi_${randomBytes(32).toString("base64url")}`;
	const hash = createHash("sha256").update(material).digest("hex");
	const credentialId = randomUUID();
	if (kind === "application")
		await sql`insert into platform.platform_applications
		(id,name,responsible_user_id,status,authorization_revision)
		values (${id},'Controlled application','unrelated-person','active','app-1')`;
	await sql`insert into platform.platform_api_credentials
		(id,principal_type,principal_id,credential_hash,scopes)
		values (${credentialId},${kind},${id},${hash},${sql.json(scopes)})`;
	return { material, hash, credentialId, id };
}

// Resolver conformance with controlled rows, not application issuer or audit HTTP acceptance.
describe("same-transaction generic audit identity", () => {
	it("uses the exact credential and retains user/application separation without an Agent filter", async () => {
		const a = await seed("user");
		await seed("user", a.id);
		await seed("application", a.id);
		await sql.begin(async (transaction) => {
			const resolution = await resolveApiAuditCredentialIdentityV1(
				transaction,
				a.material,
				{
					resolveUser: async (id) => user(id),
				},
			);
			expect(resolution.identity.credential.credentialId).toBe(a.credentialId);
			expect(resolution.identity.principal).toEqual({ kind: "user", id: a.id });
			await resolution.revalidate();
			expect(JSON.stringify(resolution.identity)).not.toContain(a.material);
			expect(JSON.stringify(resolution.identity)).not.toContain(a.hash);
		});
	});

	it("does not resolve an application's responsible natural person", async () => {
		const a = await seed("application");
		const resolveUser = vi.fn().mockRejectedValue(new Error("must not run"));
		await sql.begin(async (transaction) => {
			const resolution = await resolveApiAuditCredentialIdentityV1(
				transaction,
				a.material,
				{ resolveUser },
			);
			expect(resolution.identity.principal).toEqual({
				kind: "application",
				id: a.id,
			});
			await resolution.revalidate();
		});
		expect(resolveUser).not.toHaveBeenCalled();
	});

	it("rejects duplicate hashes instead of picking an arbitrary row", async () => {
		const a = await seed("user");
		await sql`insert into platform.platform_api_credentials
			(id,principal_type,principal_id,credential_hash,scopes)
			values (${randomUUID()},'user','foreign',${a.hash},'["agent:use"]'::jsonb)`;
		await expect(
			sql.begin((transaction) =>
				resolveApiAuditCredentialIdentityV1(transaction, a.material, undefined),
			),
		).rejects.toMatchObject({ code: "unavailable" });
	});

	it("never replaces a revoked used credential with another valid one", async () => {
		const a = await seed("user");
		await seed("user", a.id);
		await sql`update platform.platform_api_credentials set revoked_at=clock_timestamp() where id=${a.credentialId}`;
		await expect(
			sql.begin((transaction) =>
				resolveApiAuditCredentialIdentityV1(transaction, a.material, {
					resolveUser: async (id) => user(id),
				}),
			),
		).rejects.toMatchObject({ code: "authentication_required" });
	});

	it("revalidates after the query audit and rolls back on changed directory facts", async () => {
		const a = await seed("user");
		const auditId = randomUUID();
		let revision = "first";
		const directory: TaskUserDirectoryV1 = {
			resolveUser: async (id) => user(id, revision),
		};
		await expect(
			sql.begin(async (transaction) => {
				const resolution = await resolveApiAuditCredentialIdentityV1(
					transaction,
					a.material,
					directory,
				);
				await transaction`insert into platform.audit_events
				(id,trace_id,actor_type,actor_id,action,target_type,target_id,outcome)
				values (${auditId},'controlled-trace','user',${a.id},'audit.query.completed','unknown','audit-query','succeeded')`;
				revision = "changed";
				await resolution.revalidate();
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(
			await sql`select id from platform.audit_events where id=${auditId}`,
		).toHaveLength(0);
	});

	it("checks expiry using a fresh database clock at the final return", async () => {
		const a = await seed("user");
		await expect(
			sql.begin(async (transaction) => {
				const resolution = await resolveApiAuditCredentialIdentityV1(
					transaction,
					a.material,
					{
						resolveUser: async (id) => user(id),
					},
				);
				await transaction`update platform.platform_api_credentials set expires_at=clock_timestamp() where id=${a.credentialId}`;
				await resolution.revalidate();
			}),
		).rejects.toMatchObject({ code: "authentication_required" });
	});

	it("fails closed on missing directory dependencies and platform disable", async () => {
		const a = await seed("user");
		await expect(
			sql.begin((transaction) =>
				resolveApiAuditCredentialIdentityV1(transaction, a.material, undefined),
			),
		).rejects.toMatchObject({ code: "unavailable" });
		await sql`insert into platform.platform_user_disables (user_id) values (${a.id})`;
		await expect(
			sql.begin((transaction) =>
				resolveApiAuditCredentialIdentityV1(transaction, a.material, {
					resolveUser: async (id) => user(id),
				}),
			),
		).rejects.toMatchObject({ code: "forbidden" });
	});
});
