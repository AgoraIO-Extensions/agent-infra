import type {
	createLdapIdentityDirectory,
	LdapAccount,
} from "@agent-infra/identity";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createPostgresLdapBrowserDeployment } from "./ldap-browser-deployment.js";

const origin = "https://platform.example.test";
const account: LdapAccount = {
	uid: "stable-uid-a",
	userId: "e8c99945-5b39-4bcb-8f99-c29a7788432f",
	email: "person.a@example.test",
	displayName: "Person A",
	accountStatus: "active",
	roles: ["employee"],
	authorizationRevision: "ldap-revision-1",
};
let database: PostgresTestDatabase;

beforeAll(async () => {
	database = await startPostgresTestDatabase("api-browser-sessions");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
}, 120_000);

afterAll(async () => database?.stop());

describe("Platform API PostgreSQL browser deployment", () => {
	it("shares login and UID revocation across API instances", async () => {
		let disabled = false;
		const directory = {
			userIdForUid: async () => account.userId,
			authenticate: async () => account,
			current: async () => account,
			currentByUserId: async () => account,
		} as unknown as ReturnType<typeof createLdapIdentityDirectory>;
		const input = {
			databaseUrl: database.databaseUrl,
			publicOrigin: origin,
			directory,
			isPlatformDisabled: async () => disabled,
			organizationIds: async () => ["org-a"],
		};
		const first = createPostgresLdapBrowserDeployment(input);
		const second = createPostgresLdapBrowserDeployment(input);
		try {
			const login = await first.browserAuth.handleRequest(
				new Request(`${origin}/auth/login`, {
					method: "POST",
					headers: { origin, "content-type": "application/json" },
					body: JSON.stringify({ login: "person.a", password: "controlled" }),
				}),
			);
			expect(login?.status).toBe(204);
			const cookie = login?.headers.get("set-cookie")?.split(";")[0];
			expect(cookie).toMatch(/^__Host-platform-session=/u);
			const request = new Request(`${origin}/api/v1/session`, {
				headers: { cookie: cookie ?? "" },
			});
			expect(await second.identity.resolve(request)).toMatchObject({
				userId: account.userId,
			});
			disabled = true;
			expect(await second.identity.resolve(request)).toBeNull();
			disabled = false;
			expect(await first.identity.resolve(request)).toBeNull();
		} finally {
			await Promise.all([
				first.browserAuth.close(),
				second.browserAuth.close(),
			]);
		}
	});
});
