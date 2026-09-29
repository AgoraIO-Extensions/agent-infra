import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type {
	createLdapIdentityDirectory,
	LdapAccount,
} from "@agent-infra/identity";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { loadPlatformApiAssembly, startPlatformApi } from "./index.js";
import { createPostgresLdapBrowserDeployment } from "./ldap-browser-deployment.js";

const origin = "https://localhost:3001";
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
		const sql = postgres(database.databaseUrl, { max: 1 });
		const trustedProxyToken = randomBytes(32).toString("base64url");
		const directory = {
			userIdForUid: async () => account.userId,
			authenticate: async () => account,
			current: async () => account,
			currentByUserId: async () => account,
		} as unknown as ReturnType<typeof createLdapIdentityDirectory>;
		const input = {
			databaseUrl: database.databaseUrl,
			publicOrigin: origin,
			trustedProxyToken,
			directory,
			organizationIds: async () => ["org-a"],
		};
		const first = createPostgresLdapBrowserDeployment(input);
		const second = createPostgresLdapBrowserDeployment(input);
		try {
			const requestAtProxy = (
				host: string,
				forwardedProto: string,
				token?: string,
			) =>
				new Request("http://localhost:3001/auth/login", {
					method: "POST",
					headers: {
						host,
						"x-forwarded-proto": forwardedProto,
						...(token ? { "x-platform-proxy-token": token } : {}),
						origin,
						"content-type": "application/json",
					},
					body: JSON.stringify({ login: "person.a", password: "controlled" }),
				});
			expect(() =>
				createPostgresLdapBrowserDeployment({
					...input,
					trustedProxyToken: "short",
				}),
			).toThrow("LDAP_BROWSER_PROXY_CONFIGURATION_INVALID");
			expect(
				(
					await first.browserAuth.handleRequest(
						requestAtProxy("bad.test", "https", trustedProxyToken),
					)
				)?.status,
			).toBe(400);
			expect(
				(
					await first.browserAuth.handleRequest(
						requestAtProxy("localhost:3001", "http", trustedProxyToken),
					)
				)?.status,
			).toBe(400);
			expect(
				(
					await first.browserAuth.handleRequest(
						requestAtProxy("localhost:3001", "https"),
					)
				)?.status,
			).toBe(400);
			expect(
				(
					await first.browserAuth.handleRequest(
						requestAtProxy("localhost:3001", "https", "wrong-token"),
					)
				)?.status,
			).toBe(400);
			expect(
				(
					await first.browserAuth.handleRequest(
						new Request("https://localhost:3001/auth/login", {
							method: "POST",
							headers: {
								origin,
								"content-type": "application/json",
							},
							body: JSON.stringify({
								login: "person.a",
								password: "controlled",
							}),
						}),
					)
				)?.status,
			).toBe(400);
			const assembly = await loadPlatformApiAssembly(
				new URL(
					"../../../tests/fixtures/platform-api-deployment.mjs",
					import.meta.url,
				).href,
			);
			const server = startPlatformApi({
				dependencies: assembly.dependencies,
				browserAuth: first.browserAuth,
				log: () => {},
				port: 0,
			});
			let cookie: string | undefined;
			try {
				const address = server.address();
				if (!address || typeof address === "string")
					throw new Error("Platform API did not bind a TCP port");
				const login = await new Promise<{
					status: number | undefined;
					setCookie: string | undefined;
				}>((resolve, reject) => {
					const request = httpRequest(
						{
							hostname: "127.0.0.1",
							port: address.port,
							path: "/auth/login",
							method: "POST",
							headers: {
								host: "localhost:3001",
								"x-forwarded-proto": "https",
								"x-platform-proxy-token": trustedProxyToken,
								origin,
								"content-type": "application/json",
							},
						},
						(response) => {
							response.resume();
							response.on("end", () =>
								resolve({
									status: response.statusCode,
									setCookie: response.headers["set-cookie"]?.[0],
								}),
							);
						},
					);
					request.on("error", reject);
					request.end(
						JSON.stringify({ login: "person.a", password: "controlled" }),
					);
				});
				expect(login.status).toBe(204);
				cookie = login.setCookie?.split(";")[0];
			} finally {
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
				await assembly.close();
			}
			expect(cookie).toMatch(/^__Host-platform-session=/u);
			const request = new Request(`${origin}/api/v1/session`, {
				headers: { cookie: cookie ?? "" },
			});
			expect(await second.identity.resolve(request)).toMatchObject({
				userId: account.userId,
			});
			await sql`
				insert into platform.platform_user_disables (user_id, disabled_by)
				values (${account.userId}, ${account.userId})
			`;
			expect(await second.identity.resolve(request)).toBeNull();
			await sql`delete from platform.platform_user_disables where user_id = ${account.userId}`;
			expect(await first.identity.resolve(request)).toBeNull();
		} finally {
			await Promise.all([
				first.browserAuth.close(),
				second.browserAuth.close(),
				sql.end(),
			]);
		}
	});
});
