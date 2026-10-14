import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	CompanyOAuthEntry,
	ConnectionOAuthService,
	companyEntryPath,
	companyIdentityCallbackPath,
} from "@agent-infra/connection-core";
import {
	assertIsolatedTestDatabaseUrl,
	migrateConnectionDatabase,
	PostgresBrowserCommandIdempotency,
	PostgresConnectionOAuthRepository,
} from "@agent-infra/connection-store";
import { expect, it, vi } from "vitest";
import { createConnectionApp } from "./app";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl)
	throw new Error("CONNECTION_TEST_DATABASE_URL is required in CI");
const integrationTest = databaseUrl ? it : it.skip;

integrationTest(
	"company admission and LDAP stay separate with PostgreSQL take-once and cookie-free MCP",
	async () => {
		if (!databaseUrl) return;
		await migrateConnectionDatabase(
			databaseUrl,
			resolve(import.meta.dirname, "../../../migrations/connection"),
		);
		const repository = new PostgresConnectionOAuthRepository(databaseUrl);
		const commands = new PostgresBrowserCommandIdempotency(
			databaseUrl,
			Buffer.alloc(32, 37),
		);
		const suffix = randomUUID();
		const issuer = "https://connection.example/";
		const authenticate = vi.fn(async (_username: string, password: string) => {
			if (password !== "synthetic-ldap-password") throw new Error("Denied");
			return {
				displayName: "LDAP business user",
				email: "ldap-user@example.invalid",
				issuer: "urn:test:company-ldap",
				subject: `entry-ldap-${suffix}`,
			};
		});
		const oauth = new ConnectionOAuthService({
			consumer: { id: "consumer-codex", name: "Codex" },
			directory: { authenticate, isActive: async () => true },
			identityRealm: "urn:test:entry-integration",
			identityKey: Buffer.alloc(32, 17),
			repository,
			resource: `${issuer}mcp`,
		});
		const readIdentity = vi.fn(async () => ({
			email: "different-entrance-user@agora.io",
			permissions: ["CONNECTION_ADMIN"],
		}));
		const companyEntry = new CompanyOAuthEntry({
			clientId: "test-entry",
			commands,
			identityKey: Buffer.alloc(32, 17),
			identityRealm: "urn:test:entry-integration",
			publicBaseUrl: issuer,
			readIdentity,
		});
		const app = createConnectionApp({
			accessTokens: oauth,
			directMcpEnabled: true,
			githubProviderEnabled: false,
			oauthServer: {
				issuer,
				resource: `${issuer}mcp`,
				service: oauth,
				browserCommands: commands,
				companyEntry,
			},
		});
		const ldapBody = JSON.stringify({
			username: "ldap-user",
			password: "synthetic-ldap-password",
		});
		const login = (ticket: string, passwordBody = ldapBody) =>
			app.request(`${issuer}api/v1/connection/session`, {
				method: "POST",
				body: passwordBody,
				headers: {
					cookie: ticket,
					origin: issuer.slice(0, -1),
					"content-type": "application/json",
					"idempotency-key": randomUUID(),
				},
			});
		try {
			expect((await login("")).status).toBe(401);
			expect(authenticate).not.toHaveBeenCalled();
			const started = await app.request(companyEntryPath);
			const stateCookie =
				started.headers.getSetCookie()[0]?.split(";")[0] ?? "";
			const state =
				new URL(started.headers.get("location") ?? "").searchParams.get(
					"state",
				) ?? "";
			const body = new URLSearchParams({
				flow: "entry",
				state,
				code: "synthetic-company-code",
			}).toString();
			const callback = () =>
				app.request(`${issuer.slice(0, -1)}${companyIdentityCallbackPath}`, {
					method: "POST",
					body,
					headers: {
						cookie: stateCookie,
						origin: issuer.slice(0, -1),
						"content-type": "application/x-www-form-urlencoded",
					},
				});
			const complete = await callback();
			expect(complete.status).toBe(303);
			expect(
				complete.headers
					.getSetCookie()
					.some((v) => v.startsWith("connection_session=")),
			).toBe(false);
			const entryCookie =
				complete.headers
					.getSetCookie()
					.find((v) => v.startsWith("__Host-connection_company_oauth_entry="))
					?.split(";")[0] ?? "";
			expect(entryCookie).not.toBe("");
			const proofOnly = await app.request("/mcp", {
				method: "POST",
				body: JSON.stringify({ id: 0, jsonrpc: "2.0", method: "initialize" }),
				headers: {
					authorization: `Bearer ${entryCookie.split("=")[1]}`,
					"content-type": "application/json",
				},
			});
			expect(proofOnly.status).toBe(401);
			expect(proofOnly.headers.get("location")).toBeNull();
			expect((await callback()).status).toBe(400);
			expect(readIdentity).toHaveBeenCalledTimes(1);
			expect(
				(
					await app.request("/api/v1/connection/session", {
						headers: { cookie: entryCookie },
					})
				).status,
			).toBe(401);
			expect(
				(
					await login(
						entryCookie,
						JSON.stringify({
							username: "ldap-user",
							password: "wrong-password",
						}),
					)
				).status,
			).toBe(401);
			expect(
				(
					await app.request("/api/v1/connection/openapi.json", {
						headers: { cookie: entryCookie },
					})
				).status,
			).toBe(401);
			const authenticated = await login(entryCookie);
			expect(authenticated.status).toBe(200);
			expect(await authenticated.json()).toMatchObject({
				account: { email: "ldap-user@example.invalid" },
				isAdministrator: false,
			});
			const ldapCookie =
				authenticated.headers
					.getSetCookie()
					.find((v) => v.startsWith("connection_session="))
					?.split(";")[0] ?? "";
			expect(
				(
					await app.request("/api/v1/connection/tokens", {
						headers: { cookie: ldapCookie },
					})
				).status,
			).toBe(401);
			expect(
				(
					await app.request("/api/v1/connection/openapi.json", {
						headers: { cookie: ldapCookie },
					})
				).status,
			).toBe(401);
			expect(
				(
					await app.request("/api/v1/connection/openapi.json", {
						headers: { cookie: `${entryCookie}; ${ldapCookie}` },
					})
				).status,
			).toBe(200);
			const issued = await app.request(`${issuer}api/v1/connection/tokens`, {
				method: "POST",
				body: JSON.stringify({ name: "entry-boundary-test" }),
				headers: {
					cookie: `${entryCookie}; ${ldapCookie}`,
					origin: issuer.slice(0, -1),
					"content-type": "application/json",
					"idempotency-key": randomUUID(),
				},
			});
			expect(issued.status).toBe(201);
			const value = (await issued.json()) as { issued: { token: string } };
			const mcp = await app.request("/mcp", {
				method: "POST",
				body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
				headers: {
					authorization: `Bearer ${value.issued.token}`,
					"content-type": "application/json",
				},
			});
			expect(mcp.status).toBe(200);
			expect(mcp.headers.get("location")).toBeNull();
		} finally {
			await commands.close();
			await repository.close();
		}
	},
	30_000,
);
