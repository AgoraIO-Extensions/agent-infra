import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	CompanyIdentityProbe,
	ConnectionOAuthService,
	companyIdentityCallbackPath as callback,
	companyIdentityProbePath as start,
} from "@agent-infra/connection-core";
import {
	assertIsolatedTestDatabaseUrl,
	migrateConnectionDatabase,
	PostgresBrowserCommandIdempotency,
	PostgresConnectionOAuthRepository,
} from "@agent-infra/connection-store";
import { describe, expect, it, vi } from "vitest";
import { createConnectionApp } from "./app";
import { createIdentityProbeApp } from "./identity-probe-routes";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl)
	throw new Error("CONNECTION_TEST_DATABASE_URL is required in CI");
const integrationTest = databaseUrl ? it : it.skip;
const origin = "https://connection.example";

describe("company identity probe with durable commands", () => {
	it("publishes a fail-closed callback before client configuration without reflecting query values", async () => {
		const app = createIdentityProbeApp(undefined, origin);
		const response = await app.request(
			`${callback}?code=synthetic-secret&state=synthetic-state`,
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).not.toContain("synthetic-secret");
	});
	integrationTest(
		"binds callback to the admin session, consumes once and never establishes OAuth identity",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const repository = new PostgresConnectionOAuthRepository(databaseUrl);
			const commands = new PostgresBrowserCommandIdempotency(
				databaseUrl,
				Buffer.alloc(32, 52),
			);
			const suffix = randomUUID();
			const oauth = new ConnectionOAuthService({
				consumer: { id: "probe-test", name: "Probe test" },
				identityKey: Buffer.alloc(32, 53),
				identityRealm: "urn:test:probe",
				resource: `${origin}/mcp`,
				repository,
				directory: {
					authenticate: async (username) => ({
						issuer: "urn:test:ldap",
						subject: username,
						displayName: "Test",
						email: "test@example.invalid",
					}),
					isActive: async () => true,
				},
			});
			const alice = await oauth.loginBrowserSession({
				username: `alice-${suffix}`,
				password: "test",
			});
			const bob = await oauth.loginBrowserSession({
				username: `bob-${suffix}`,
				password: "test",
			});
			let allowed = true;
			const readIdentity = vi.fn(
				async (): Promise<unknown> => ({
					id: 123,
					uid: `alice-${suffix}`,
					email: "test@example.invalid",
					access_token: "must-not-return",
					arbitrarySecretField: "must-not-return",
				}),
			);
			const probe = new CompanyIdentityProbe({
				clientId: "test-client",
				identityKey: Buffer.alloc(32, 53),
				identityRealm: "urn:test:probe",
				publicBaseUrl: origin,
				oauth,
				commands,
				isAdministrator: async () => allowed,
				readIdentity,
			});
			const app = createConnectionApp({
				accessTokens: oauth,
				directMcpEnabled: true,
				oauthServer: {
					identityProbe: probe,
					service: oauth,
					issuer: origin,
					resource: `${origin}/mcp`,
				},
			});
			const startProbe = async () => {
				const page = await app.request(start, {
					headers: { cookie: `connection_session=${alice.sessionToken}` },
				});
				expect(page.headers.get("content-security-policy")).toContain(
					"form-action 'self' https://oauth.agoralab.co;",
				);
				const response = await app.request(start, {
					method: "POST",
					headers: {
						origin,
						cookie: `connection_session=${alice.sessionToken}`,
					},
				});
				expect(response.status).toBe(303);
				const url = new URL(response.headers.get("location") ?? "");
				expect(url.origin).toBe("https://oauth.agoralab.co");
				expect(url.searchParams.get("redirect_uri")).toBe(
					`${origin}${callback}`,
				);
				expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
				expect(response.headers.get("set-cookie")).toContain("HttpOnly");
				return url.searchParams.get("state") ?? "";
			};
			const finish = (
				state: string,
				session = alice.sessionToken,
				cookieState = state,
			) =>
				app.request(callback, {
					method: "POST",
					headers: {
						origin,
						"content-type": "application/x-www-form-urlencoded",
						cookie: `connection_session=${session}; connection_identity_probe_state=${cookieState}`,
					},
					body: new URLSearchParams({ state, code: "test-code" }).toString(),
				});
			try {
				expect((await app.request(start)).status).toBe(401);
				expect(
					(
						await app.request(start, {
							method: "POST",
							headers: {
								origin: "https://attacker.example",
								cookie: `connection_session=${alice.sessionToken}`,
							},
						})
					).status,
				).toBe(400);
				allowed = false;
				expect(
					(
						await app.request(start, {
							headers: { cookie: `connection_session=${alice.sessionToken}` },
						})
					).status,
				).toBe(400);
				allowed = true;
				const state = await startProbe();
				expect(
					(
						await app.request(
							`${callback}?state=${encodeURIComponent(state)}&code=test-code`,
						)
					).status,
				).toBe(400);
				const bridge = await app.request(
					`${callback}?state=${encodeURIComponent(state)}&code=test-code`,
					{ headers: { cookie: `connection_identity_probe_state=${state}` } },
				);
				expect(bridge.status).toBe(200);
				expect(bridge.headers.get("content-security-policy")).toContain(
					"default-src 'none'",
				);
				expect(bridge.headers.get("referrer-policy")).toBe("no-referrer");
				expect(await bridge.text()).toContain("完成身份探测");
				expect(readIdentity).not.toHaveBeenCalled();
				expect((await finish(state, bob.sessionToken)).status).toBe(400);
				expect(
					(await finish(state, alice.sessionToken, "wrong-cookie")).status,
				).toBe(400);
				const tampered = `${state.slice(0, 10)}x${state.slice(11)}`;
				expect((await finish(tampered)).status).toBe(400);
				const results = await Promise.all([finish(state), finish(state)]);
				expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
				const success = results.find((r) => r.status === 200);
				const text = await success?.text();
				expect(text).toContain("matchesLdapSubject");
				expect(text).toContain("true");
				expect(text).not.toContain(suffix);
				expect(text).not.toContain("test@example.invalid");
				expect(text).not.toContain("must-not-return");
				expect(text).not.toContain("arbitrarySecretField");
				expect(success?.headers.get("set-cookie")).not.toContain(
					"connection_session=",
				);
				expect(readIdentity).toHaveBeenCalledTimes(1);
				expect((await finish(state)).status).toBe(400);
				const expiring = await startProbe();
				vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
				expect((await finish(expiring)).status).toBe(400);
				vi.restoreAllMocks();
				const revoked = await startProbe();
				allowed = false;
				expect((await finish(revoked)).status).toBe(400);
				allowed = true;
				const revokeDuringQuery = await startProbe();
				readIdentity.mockImplementationOnce(async () => {
					allowed = false;
					return { id: 123 };
				});
				expect((await finish(revokeDuringQuery)).status).toBe(400);
				allowed = true;
				expect((await finish(revokeDuringQuery)).status).toBe(400);
				const uncertain = await startProbe();
				readIdentity.mockRejectedValueOnce(
					new Error("sensitive-upstream-response"),
				);
				const failure = await finish(uncertain);
				expect(failure.status).toBe(400);
				expect(await failure.text()).not.toContain(
					"sensitive-upstream-response",
				);
				expect((await finish(uncertain)).status).toBe(400);
				expect(readIdentity).toHaveBeenCalledTimes(3);
				const loggedOut = await startProbe();
				await oauth.logoutBrowserSession(alice.sessionToken);
				expect((await finish(loggedOut)).status).toBe(401);
				expect(
					(
						await app.request("/mcp", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								jsonrpc: "2.0",
								id: 1,
								method: "initialize",
								params: {
									protocolVersion: "2025-03-26",
									capabilities: {},
									clientInfo: { name: "test", version: "1" },
								},
							}),
						})
					).status,
				).toBe(401);
			} finally {
				vi.restoreAllMocks();
				await commands.close();
				await repository.close();
			}
		},
	);
});
