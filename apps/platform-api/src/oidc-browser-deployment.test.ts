import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type {
	EmployeeAccount,
	EmployeeIdentityDirectory,
} from "@agent-infra/identity";
import {
	migratePlatformDatabase,
	PostgresLdapSessionStoreV1 as PostgresBrowserSessionStoreV1,
	PostgresOidcIdentityStore,
} from "@agent-infra/platform-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { loadPlatformApiAssembly, startPlatformApi } from "./index.js";
import { createPostgresOidcBrowserDeployment } from "./oidc-browser-deployment.js";

const origin = "https://localhost:3001";
const account: EmployeeAccount = {
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
	it("checks the trusted OIDC proxy and shares session revocation across API instances", async () => {
		let disabled = false;
		const trustedProxyToken = randomBytes(32).toString("base64url");
		const directory = {
			userIdForUid: async () => account.userId,

			current: async () => account,
			currentByUserId: async () => account,
		} as unknown as EmployeeIdentityDirectory;
		const input = {
			databaseUrl: database.databaseUrl,
			publicOrigin: origin,
			trustedProxyToken,
			directory,
			isPlatformDisabled: async () => disabled,
			organizationIds: async () => ["org-a"],
		};
		const oidc = {
			issuer: "https://issuer.example.test",
			clientId: "fixture",
			clientSecret: "fixture",
			verifiedAccount: async () => account,
			store: new PostgresOidcIdentityStore(database.databaseUrl),
		};
		const sessions = new PostgresBrowserSessionStoreV1(database.databaseUrl);
		const first = createPostgresOidcBrowserDeployment({ ...input, oidc });
		const second = createPostgresOidcBrowserDeployment({
			...input,
			oidc: {
				...oidc,
				store: new PostgresOidcIdentityStore(database.databaseUrl),
			},
		});
		try {
			const requestAtProxy = (
				host: string,
				forwardedProto: string,
				token?: string,
			) =>
				new Request("http://localhost:3001/auth/oidc/login", {
					method: "HEAD",
					headers: {
						host,
						"x-forwarded-proto": forwardedProto,
						...(token ? { "x-platform-proxy-token": token } : {}),
						origin,
						"content-type": "application/json",
					},
				});
			expect(() =>
				createPostgresOidcBrowserDeployment({
					...input,
					oidc,
					trustedProxyToken: "short",
				}),
			).toThrow("BROWSER_SESSION_PROXY_CONFIGURATION_INVALID");
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
						new Request("https://localhost:3001/auth/oidc/login", {
							method: "HEAD",
							headers: {
								origin,
								"content-type": "application/json",
							},
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
			const rawCookie = randomBytes(32).toString("base64url");
			const cookie = `__Host-platform-session=${rawCookie}`;
			try {
				const address = server.address();
				if (!address || typeof address === "string")
					throw new Error("Platform API did not bind a TCP port");
				const probeStatus = (token: string) =>
					new Promise<number | undefined>((resolve, reject) => {
						const request = httpRequest(
							{
								hostname: "127.0.0.1",
								port: address.port,
								path: "/auth/oidc/login",
								method: "HEAD",
								headers: {
									host: "localhost:3001",
									"x-forwarded-proto": "https",
									"x-platform-proxy-token": token,
								},
							},
							(response) => {
								response.resume();
								response.on("end", () => resolve(response.statusCode));
							},
						);
						request.on("error", reject);
						request.end();
					});
				expect(await probeStatus(trustedProxyToken)).toBe(405);
				expect(await probeStatus("wrong-token")).toBe(400);
				const expiry = Date.now() + 60000;
				await sessions.create(
					createHash("sha256").update(rawCookie).digest("hex"),
					account.uid,
					expiry,
					expiry,
				);
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
			disabled = true;
			expect(await second.identity.resolve(request)).toBeNull();
			disabled = false;
			expect(await first.identity.resolve(request)).toBeNull();
		} finally {
			await Promise.all([
				first.browserAuth.close(),
				second.browserAuth.close(),
				sessions.close(),
			]);
		}
	});
});
