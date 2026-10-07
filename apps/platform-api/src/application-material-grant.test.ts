import { once } from "node:events";
import { ApplicationMaterialGrantResponseV1Schema } from "@agent-infra/contracts/pilot";
import type {
	createLdapIdentityDirectory,
	LdapAccount,
} from "@agent-infra/identity";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	it,
	vi,
} from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import { createLdapBrowserAdapter } from "./ldap-browser.js";

// Real HTTP/assembly/Core/PostgreSQL; LDAP and session authority are controlled ports.
// This exercises governance, never an issuer or credential-material delivery.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
const origin = "https://platform.example.test";
const admin: LdapAccount = {
	uid: "stable-admin",
	userId: "admin-1",
	email: "admin@example.test",
	displayName: "Admin",
	accountStatus: "active",
	roles: ["employee", "system_admin"],
	authorizationRevision: "ldap-1",
};
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let account: LdapAccount | null;
let disabled: boolean;
const currentByUserId = vi.fn(
	async (_id: string): Promise<LdapAccount | null> => account,
);

beforeAll(async () => {
	database = await startPostgresTestDatabase("material-grant-http");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { max: 2 });
});
beforeEach(async () => {
	account = admin;
	disabled = false;
	currentByUserId.mockReset().mockImplementation(async () => account);
	await sql`truncate platform.platform_applications, platform.audit_events, platform.platform_user_disables cascade`;
	await sql`insert into platform.platform_applications (id, name, responsible_user_id, authorization_revision) values ('app-1','First','manager-1','revision-1'), ('app-2','Second','manager-2','revision-2')`;
	const browser = createLdapBrowserAdapter({
		publicOrigin: origin,
		directory: {
			userIdForUid: async () => admin.userId,
			current: async () => account,
			currentByUserId,
		} as unknown as ReturnType<typeof createLdapIdentityDirectory>,
		sessions: {
			find: async () => ({
				uid: admin.uid,
				expiresAt: Number.MAX_SAFE_INTEGER,
				absoluteExpiresAt: Number.MAX_SAFE_INTEGER,
			}),
			create: async () => {},
			renew: async () => true,
			revoke: async () => {},
			revokeUid: async () => {},
		},
		isPlatformDisabled: async () => disabled,
		organizationIds: async () => [],
	});
	const unused = async (): Promise<never> => {
		throw new Error("Unrelated adapter called");
	};
	assembly = assemblePlatformApi({
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
		},
		databaseUrl: database.databaseUrl,
		identity: browser.identityAdapter,
		admissions: {
			authorizationAdmission: { authorize: unused },
			imageAdmission: { admitImage: unused },
			modelAdmission: { admitModels: unused },
			secretAdmission: { admitSecrets: unused },
			channelAdmission: { admitChannels: unused },
		},
		allocateApplicationIds: unused,
		prepareApplicationSecrets: unused,
		prepareConfigurationSecrets: unused,
		presentAgent: unused,
	});
	server = serve({
		fetch: createPlatformApp(assembly.dependencies).fetch,
		hostname: "127.0.0.1",
		port: 0,
	});
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing listener");
	baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
	if (server)
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	await assembly?.close();
});
afterAll(async () => {
	await sql?.end();
	await database?.stop();
});
function call(
	method = "POST",
	body: unknown = { principalType: "user", principalId: admin.userId },
	application = "app-1",
	type = "user",
	recipient = admin.userId,
) {
	return fetch(
		`${baseUrl}/api/v2/applications/${application}/material-grant${method === "POST" ? "" : `/${type}/${recipient}`}`,
		{
			method,
			headers: {
				Cookie: `__Host-platform-session=${"a".repeat(43)}`,
				Origin: origin,
				"Content-Type": "application/json",
			},
			...(method === "GET" ? {} : { body: JSON.stringify(body) }),
		},
	);
}
async function expectNoGrant() {
	expect(
		(
			await sql`select count(*)::int as count from platform.api_credential_delivery_grants`
		)[0]?.count,
	).toBe(0);
	expect(
		(
			await sql`select count(*)::int as count from platform.audit_events where outcome='succeeded'`
		)[0]?.count,
	).toBe(0);
}
it("requires an explicit admin self grant and preserves metadata-only read/revoke", async () => {
	expect((await call("GET")).status).toBe(404);
	expect(
		(
			await sql`select count(*)::int as count from platform.api_credential_delivery_grants`
		)[0]?.count,
	).toBe(0);
	const granted = await call();
	expect(granted.status).toBe(201);
	const result = ApplicationMaterialGrantResponseV1Schema.parse(
		await granted.json(),
	);
	expect(Object.keys(result.metadata).sort()).toEqual([
		"applicationId",
		"authorizationRevision",
		"createdAt",
		"principalId",
		"principalType",
		"revokedAt",
	]);
	expect((await call("GET")).status).toBe(200);
	expect((await call("GET", undefined, "app-2")).status).toBe(404);
	expect(
		(await call("GET", undefined, "app-1", "application", admin.userId)).status,
	).toBe(404);
	const revoked = await call("PATCH", {
		status: "revoked",
		expectedRevision: result.metadata.authorizationRevision,
	});
	expect(revoked.status).toBe(200);
	expect(
		ApplicationMaterialGrantResponseV1Schema.parse(await revoked.json())
			.metadata.revokedAt,
	).not.toBeNull();
	const rows =
		await sql`select revoked_at from platform.api_credential_delivery_grants`;
	expect(rows).toHaveLength(1);
	expect(rows[0]?.revoked_at).not.toBeNull();
	const audits = await sql`select details from platform.audit_events`;
	expect(audits.length).toBeGreaterThan(0);
	for (const row of audits)
		expect(row.details).toEqual({ returnedMaterial: false });
});
it.each(["manager", "disabled", "directory", "removed", "mismatch"])(
	"fails closed for %s",
	async (mode) => {
		if (mode === "manager") account = { ...admin, roles: ["employee"] };
		if (mode === "disabled") disabled = true;
		if (mode === "directory")
			currentByUserId.mockRejectedValue(
				new Error("private directory sentinel"),
			);
		if (mode === "removed") currentByUserId.mockResolvedValue(null);
		if (mode === "mismatch")
			currentByUserId.mockResolvedValue({ ...admin, userId: "other" });
		for (const method of ["POST", "GET", "PATCH"]) {
			const response = await call(
				method,
				method === "PATCH"
					? { status: "revoked", expectedRevision: "revision" }
					: undefined,
			);
			expect(response.status).toBe(
				mode === "directory" || mode === "mismatch"
					? 503
					: mode === "manager"
						? 403
						: 401,
			);
			expect(await response.text()).not.toContain("private directory sentinel");
		}
		await expectNoGrant();
	},
);
it.each(["actor", "ldapStableUid", "isSystemAdmin", "material"])(
	"rejects forged %s request fields",
	async (field) => {
		expect(
			(
				await call("POST", {
					principalType: "user",
					principalId: admin.userId,
					[field]: "forged",
				})
			).status,
		).toBe(400);
		await expectNoGrant();
	},
);
it("rejects cross-application recipients", async () => {
	expect(
		(await call("POST", { principalType: "application", principalId: "app-2" }))
			.status,
	).toBe(404);
	await expectNoGrant();
});
it.each(["role", "uid", "revision", "disabled"])(
	"rolls back a current administrator %s change after the write",
	async (change) => {
		// Route, pre-lock Core check, recipient lookup, then final transactional recheck.
		currentByUserId
			.mockResolvedValueOnce(admin)
			.mockResolvedValueOnce(admin)
			.mockResolvedValueOnce(admin)
			.mockResolvedValue({
				...admin,
				...(change === "role"
					? { roles: ["employee"] as const }
					: change === "uid"
						? { uid: "another-uid" }
						: change === "revision"
							? { authorizationRevision: "changed" }
							: { accountStatus: "disabled" as const }),
			});
		expect((await call()).status).toBe(401);
		expect(currentByUserId).toHaveBeenCalledTimes(4);
		await expectNoGrant();
	},
);
