import { createHash } from "node:crypto";
import { once } from "node:events";
import { ApplicationApiCredentialResponseV1Schema } from "@agent-infra/contracts/pilot";
import type {
	createLdapIdentityDirectory,
	LdapAccount,
} from "@agent-infra/identity";
import {
	createApplicationApiCredentialIssuerV1,
	createApplicationMaterialGrantUseCaseV1,
} from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresApplicationApiCredentialIssuerStoreV1,
	PostgresApplicationMaterialGrantStoreV1,
} from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import {
	createApplicationCredentialProcessDeliveryV1,
	registerApplicationApiCredentialRoutes,
} from "./http/application-api-credential-routes.js";
import { registerApplicationMaterialGrantRoutes } from "./http/application-material-grant-routes.js";
import { resolveCurrentMaterialGrantActor } from "./http/identity.js";
import { createLdapBrowserAdapter } from "./ldap-browser.js";

// Actual TCP HTTP, current LDAP adapter and PG; controlled identity/session ports and recipient process.
// App/assembly receiving and Task consumption remain separate acceptance requirements.
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresApplicationApiCredentialIssuerStoreV1;
let grantStore: PostgresApplicationMaterialGrantStoreV1;
let server: ReturnType<typeof serve>;
let baseUrl: string;
const materials: string[] = [];
const accounts: LdapAccount[] = ["manager", "admin", "recipient"].map(
	(userId) => ({
		uid: `ldap-${userId}`,
		userId,
		displayName: userId,
		email: `${userId}@example.test`,
		accountStatus: "active",
		roles: userId === "admin" ? ["employee", "system_admin"] : ["employee"],
		authorizationRevision: "identity-v1",
	}),
);
const token = (user: string) => (user === "admin" ? "b" : "a").repeat(43);
const origin = "https://platform.example.test";
beforeAll(async () => {
	database = await startPostgresTestDatabase("issuer-http-1277");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { max: 2 });
	await sql`insert into platform.platform_applications (id,name,responsible_user_id,authorization_revision) values ('app-1','App','manager','app-v1')`;
	store = new PostgresApplicationApiCredentialIssuerStoreV1(database);
	grantStore = new PostgresApplicationMaterialGrantStoreV1(database);
	const adapter = createLdapBrowserAdapter({
		publicOrigin: origin,
		directory: {
			userIdForUid: async (uid: string) =>
				accounts.find((a) => a.uid === uid)?.userId,
			current: async (uid: string) =>
				accounts.find((a) => a.uid === uid) ?? null,
			currentByUserId: async (id: string) =>
				accounts.find((a) => a.userId === id) ?? null,
		} as unknown as ReturnType<typeof createLdapIdentityDirectory>,
		sessions: {
			find: async (digest) => {
				for (const user of ["admin", "manager"]) {
					if (createHash("sha256").update(token(user)).digest("hex") === digest)
						return { uid: `ldap-${user}` };
				}
				return null;
			},
			create: async () => {},
			revoke: async () => {},
			revokeUid: async () => {},
		},
		isPlatformDisabled: async () => false,
		organizationIds: async () => [],
	}).identityAdapter;
	const app = new Hono();
	registerApplicationMaterialGrantRoutes(app, {
		identity: adapter,
		grants: createApplicationMaterialGrantUseCaseV1({
			store: grantStore,
			resolveCurrentActor: (id) =>
				resolveCurrentMaterialGrantActor(adapter, id, "current-grant"),
			resolveUser: async (id) => adapter.resolveUser?.(id) ?? null,
		}),
	});
	registerApplicationApiCredentialRoutes(app, {
		identity: adapter,
		issuer: createApplicationApiCredentialIssuerV1({
			store,
			userDirectory: {
				resolveUser: (id) => adapter.resolveUser?.(id) ?? Promise.resolve(null),
			},
			delivery: createApplicationCredentialProcessDeliveryV1({
				principalType: "user",
				principalId: "recipient",
				accept: (_attempt, material) => {
					materials.push(material);
					return true;
				},
			}),
		}),
	});
	server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing listener");
	baseUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);
afterAll(async () => {
	if (server)
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	await store?.close();
	await grantStore?.close();
	await sql?.end();
	await database?.stop();
});
function post(
	path: string,
	body: unknown,
	user = "manager",
	key = "issue-http",
) {
	return fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: {
			Cookie: `__Host-platform-session=${token(user)}`,
			Origin: origin,
			"Content-Type": "application/json",
			"Idempotency-Key": key,
		},
		body: JSON.stringify(body),
	});
}
it("uses formal grant and issuer HTTP, delivers to the bound process only once, and never returns material to manager", async () => {
	const command = {
		operation: "issue",
		recipient: { principalType: "user", principalId: "recipient" },
		scopes: ["agent:use"],
		expiresAt: null,
	};
	const path = "/api/v2/applications/app-1/credentials";
	expect((await post(path, command)).status).toBe(403);
	expect(
		(
			await post(
				"/api/v2/applications/app-1/material-grant",
				command.recipient,
				"admin",
			)
		).status,
	).toBe(201);
	expect((await post(path, command, "admin")).status).toBe(404);
	expect(
		(
			await post(path, {
				...command,
				recipient: { principalType: "user", principalId: "manager" },
			})
		).status,
	).toBe(403);
	const first = await post(path, command);
	expect(first.status).toBe(201);
	expect(first.headers.get("Cache-Control")).toBe("no-store");
	const result = ApplicationApiCredentialResponseV1Schema.parse(
		await first.json(),
	);
	expect(result.delivery.status).toBe("accepted");
	expect(materials.length).toBe(1);
	expect(JSON.stringify(result).includes(materials[0] ?? "missing")).toBe(
		false,
	);
	const [row] =
		await sql`select principal_type, principal_id, credential_hash from platform.platform_api_credentials`;
	expect(row?.principal_type).toBe("application");
	expect(row?.principal_id).toBe("app-1");
	expect(
		row?.credential_hash ===
			createHash("sha256")
				.update(materials[0] ?? "missing")
				.digest("hex"),
	).toBe(true);
	expect((await post(path, command)).status).toBe(200);
	expect(materials.length).toBe(1);
	expect(
		(await post(path, { ...command, scopes: ["agent:read"] })).status,
	).toBe(409);
	expect(
		(
			await post(path, {
				...command,
				deliveryUrl: "https://caller.example.test",
			})
		).status,
	).toBe(400);
	const audits = JSON.stringify(
		await sql`select details from platform.audit_events`,
	);
	expect(audits.includes(materials[0] ?? "missing")).toBe(false);
});
