import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ConnectionOAuthService } from "@agent-infra/connection-core";
import {
	assertIsolatedTestDatabaseUrl,
	migrateConnectionDatabase,
	PostgresConnectionOAuthRepository,
} from "@agent-infra/connection-store";
import { describe, expect, it } from "vitest";

import { createConnectionApp } from "./app";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl) {
	throw new Error("CONNECTION_TEST_DATABASE_URL is required in CI");
}
const integrationTest = databaseUrl ? it : it.skip;

describe("Connection OAuth HTTP flow", () => {
	integrationTest(
		"issues, uses, and revokes a portable PAT through public HTTP routes",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const repository = new PostgresConnectionOAuthRepository(databaseUrl);
			const oauth = new ConnectionOAuthService({
				consumer: { id: "consumer-codex", name: "Codex" },
				directory: {
					authenticate: async (_username: string, password: string) => {
						if (password !== "integration-password") throw new Error("denied");
						return {
							displayName: "PAT HTTP User",
							email: "pat-http@example.invalid",
							issuer: "urn:test:company-ldap",
							subject: "pat-http-stable-uid",
						};
					},
					isActive: async () => true,
				},
				identityEnvironment: "test",
				identityKey: Buffer.alloc(32, 23),
				repository,
				resource: "https://connection.example/mcp",
			});
			const app = createConnectionApp({
				accessTokens: oauth,
				directMcpEnabled: true,
				githubProviderEnabled: false,
				oauthServer: {
					dynamicClientRegistration: { clientName: "Codex" },
					issuer: "https://connection.example/",
					resource: "https://connection.example/mcp",
					service: oauth,
				},
			});

			try {
				const loginPage = await app.request("/connection/login");
				expect(loginPage.status).toBe(200);
				expect(await loginPage.text()).toContain("Sign in to Connection");
				expect((await app.request("/connection/tokens")).status).toBe(302);

				const crossOrigin = await app.request("/connection/login", {
					body: new URLSearchParams({
						password: "integration-password",
						username: "integration-user",
					}),
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						origin: "https://attacker.example",
					},
					method: "POST",
				});
				expect(crossOrigin.status).toBe(400);

				const denied = await app.request("/connection/login", {
					body: new URLSearchParams({
						password: "wrong-password",
						username: "integration-user",
					}),
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						origin: "https://connection.example",
					},
					method: "POST",
				});
				expect(denied.status).toBe(401);

				const login = await app.request("/connection/login", {
					body: new URLSearchParams({
						password: "integration-password",
						username: "integration-user",
					}),
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						origin: "https://connection.example",
					},
					method: "POST",
				});
				expect(login.status).toBe(303);
				const setCookie = login.headers.get("set-cookie") ?? "";
				expect(setCookie).toContain("HttpOnly");
				expect(setCookie).toContain("Secure");
				expect(setCookie).toContain("SameSite=Strict");
				const cookie = setCookie.split(";", 1)[0] ?? "";
				const consolePage = await app.request("/connection/tokens", {
					headers: { cookie },
				});
				expect(consolePage.status).toBe(200);
				const consoleBody = await consolePage.text();
				expect(consoleBody).toContain("Connection navigation");
				expect(consoleBody).toContain("Access tokens");
				expect(consoleBody).not.toContain('name="password"');

				const issued = await app.request("/connection/tokens", {
					body: new URLSearchParams({
						name: "HTTP integration token",
					}),
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						cookie,
						origin: "https://connection.example",
					},
					method: "POST",
				});
				expect(issued.status).toBe(201);
				expect(issued.headers.get("cache-control")).toBe("no-store");
				const issuedBody = await issued.text();
				const token =
					/<code class="token-value">(conn_pat_[A-Za-z0-9_-]+)<\/code>/.exec(
						issuedBody,
					)?.[1];
				const tokenId = /\/connection\/tokens\/(pat-[0-9a-f-]+)\/revoke/.exec(
					issuedBody,
				)?.[1];
				expect(token).toMatch(/^conn_pat_[A-Za-z0-9_-]{43}$/);
				expect(tokenId).toMatch(/^pat-[0-9a-f-]{36}$/);

				const initialize = await app.request("/mcp", {
					body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					method: "POST",
				});
				expect(initialize.status).toBe(200);

				const revoked = await app.request(
					`/connection/tokens/${tokenId}/revoke`,
					{
						headers: {
							cookie,
							origin: "https://connection.example",
						},
						method: "POST",
					},
				);
				expect(revoked.status).toBe(303);
				expect(
					(
						await app.request("/mcp", {
							body: JSON.stringify({
								id: 2,
								jsonrpc: "2.0",
								method: "initialize",
							}),
							headers: {
								authorization: `Bearer ${token}`,
								"content-type": "application/json",
							},
							method: "POST",
						})
					).status,
				).toBe(401);

				const logout = await app.request("/connection/logout", {
					headers: { cookie, origin: "https://connection.example" },
					method: "POST",
				});
				expect(logout.status).toBe(303);
				expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
			} finally {
				await repository.close();
			}
		},
		30_000,
	);

	integrationTest(
		"completes metadata, DCR, PKCE login, token exchange, and MCP initialize",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const repository = new PostgresConnectionOAuthRepository(databaseUrl);
			let authenticationCalls = 0;
			const oauth = new ConnectionOAuthService({
				consumer: { id: "consumer-codex", name: "Codex" },
				directory: {
					authenticate: async () => {
						authenticationCalls += 1;
						return {
							displayName: "HTTP Integration User",
							email: "http-integration@example.invalid",
							issuer: "urn:test:company-ldap",
							subject: "http-integration-stable-uid",
						};
					},
					isActive: async () => true,
				},
				identityEnvironment: "test",
				identityKey: Buffer.alloc(32, 11),
				repository,
				resource: "https://connection.example/mcp",
			});
			const app = createConnectionApp({
				accessTokens: oauth,
				directMcpEnabled: true,
				githubProviderEnabled: false,
				oauthServer: {
					dynamicClientRegistration: { clientName: "Codex" },
					issuer: "https://connection.example/",
					resource: "https://connection.example/mcp",
					service: oauth,
				},
			});

			try {
				const metadata = await app.request(
					"/.well-known/oauth-authorization-server",
				);
				expect(metadata.status).toBe(200);
				expect(await metadata.json()).toMatchObject({
					code_challenge_methods_supported: ["S256"],
					registration_endpoint: "https://connection.example/oauth/register",
					token_endpoint: "https://connection.example/oauth/token",
				});
				const resourceMetadata = await app.request(
					"/.well-known/oauth-protected-resource/mcp",
				);
				expect(await resourceMetadata.json()).toEqual({
					authorization_servers: ["https://connection.example/"],
					resource: "https://connection.example/mcp",
					scopes_supported: ["mcp"],
				});

				const redirectUri = "http://127.0.0.1:58245/callback/integration-nonce";
				const rejectedRegistration = await app.request("/oauth/register", {
					body: JSON.stringify({
						application_type: "native",
						client_name: "Unapproved client",
						grant_types: ["authorization_code", "refresh_token"],
						redirect_uris: [redirectUri],
						response_types: ["code"],
						scope: "mcp",
						token_endpoint_auth_method: "none",
					}),
					headers: { "content-type": "application/json" },
					method: "POST",
				});
				expect(rejectedRegistration.status).toBe(400);
				const registered = await app.request("/oauth/register", {
					body: JSON.stringify({
						application_type: "native",
						client_name: "Codex",
						grant_types: ["authorization_code", "refresh_token"],
						redirect_uris: [redirectUri],
						response_types: ["code"],
						scope: "mcp",
						token_endpoint_auth_method: "none",
					}),
					headers: { "content-type": "application/json" },
					method: "POST",
				});
				expect(registered.status).toBe(201);
				const client = (await registered.json()) as { client_id: string };
				const verifier = "B".repeat(43);
				const challenge = createHash("sha256")
					.update(verifier, "ascii")
					.digest("base64url");
				const state = randomUUID();
				const authorizationUrl = new URL(
					"https://connection.example/oauth/authorize",
				);
				authorizationUrl.search = new URLSearchParams({
					client_id: client.client_id,
					code_challenge: challenge,
					code_challenge_method: "S256",
					redirect_uri: redirectUri,
					resource: "https://connection.example/mcp",
					response_type: "code",
					scope: "mcp",
					state,
				}).toString();
				const authorization = await app.request(
					authorizationUrl.pathname + authorizationUrl.search,
				);
				expect(authorization.status).toBe(200);
				expect(authorization.headers.get("cache-control")).toBe("no-store");
				expect(authorization.headers.get("content-security-policy")).toContain(
					"form-action 'self' http://127.0.0.1:*",
				);
				const page = await authorization.text();
				const requestId = /name="request_id" value="([A-Za-z0-9_-]+)"/.exec(
					page,
				)?.[1];
				expect(requestId).toBeTruthy();

				for (const origin of [undefined, "https://attacker.invalid"]) {
					const headers: Record<string, string> = {
						"content-type": "application/x-www-form-urlencoded",
					};
					if (origin) headers.origin = origin;
					const rejected = await app.request("/oauth/login", {
						body: new URLSearchParams({
							password: "integration-password",
							request_id: requestId ?? "",
							username: "integration-user",
						}),
						headers,
						method: "POST",
					});
					expect(rejected.status).toBe(400);
				}
				expect(authenticationCalls).toBe(0);

				const invalidLogin = await app.request("/oauth/login", {
					body: new URLSearchParams({
						password: "must-not-be-checked",
						request_id: "A".repeat(43),
						username: "integration-user",
					}),
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						origin: "https://connection.example",
					},
					method: "POST",
				});
				expect(invalidLogin.status).toBe(400);
				const invalidLoginBody = await invalidLogin.text();
				expect(invalidLoginBody).toContain(
					"Authorization request expired or is no longer valid. Start a new sign-in from your client.",
				);
				expect(invalidLoginBody).not.toContain('name="password"');
				expect(
					invalidLogin.headers.get("content-security-policy"),
				).not.toContain("http://127.0.0.1:*");
				expect(authenticationCalls).toBe(0);

				const login = await app.request("/oauth/login", {
					body: new URLSearchParams({
						password: "integration-password",
						request_id: requestId ?? "",
						username: "integration-user",
					}),
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						origin: "https://connection.example",
					},
					method: "POST",
				});
				expect(login.status).toBe(302);
				expect(authenticationCalls).toBe(1);
				const callback = new URL(login.headers.get("location") ?? "");
				expect(callback.searchParams.get("state")).toBe(state);

				const token = await app.request("/oauth/token", {
					body: new URLSearchParams({
						client_id: client.client_id,
						code: callback.searchParams.get("code") ?? "",
						code_verifier: verifier,
						grant_type: "authorization_code",
						redirect_uri: redirectUri,
						resource: "https://connection.example/mcp",
					}),
					headers: { "content-type": "application/x-www-form-urlencoded" },
					method: "POST",
				});
				expect(token.status).toBe(200);
				const tokens = (await token.json()) as {
					access_token: string;
					refresh_token: string;
				};
				expect(JSON.stringify(tokens)).not.toContain("integration-password");
				const reusedRegistration = await app.request(
					authorizationUrl.pathname + authorizationUrl.search,
				);
				expect(reusedRegistration.status).toBe(401);
				const refreshed = await app.request("/oauth/token", {
					body: new URLSearchParams({
						client_id: client.client_id,
						grant_type: "refresh_token",
						refresh_token: tokens.refresh_token,
						resource: "https://connection.example/mcp",
					}),
					headers: { "content-type": "application/x-www-form-urlencoded" },
					method: "POST",
				});
				expect(refreshed.status).toBe(200);

				const initialize = await app.request("/mcp", {
					body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
					headers: {
						authorization: `Bearer ${tokens.access_token}`,
						"content-type": "application/json",
					},
					method: "POST",
				});
				expect(initialize.status).toBe(200);
				const tools = await app.request("/mcp", {
					body: JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
					headers: {
						authorization: `Bearer ${tokens.access_token}`,
						"content-type": "application/json",
					},
					method: "POST",
				});
				expect(await tools.json()).toEqual({
					id: 2,
					jsonrpc: "2.0",
					result: {
						tools: expect.arrayContaining([
							expect.objectContaining({ name: "list_apps" }),
							expect.objectContaining({ name: "list_connections" }),
							expect.objectContaining({ name: "search_actions" }),
							expect.objectContaining({ name: "get_action_guide" }),
							expect.objectContaining({ name: "execute_action" }),
						]),
					},
				});
			} finally {
				await repository.close();
			}
		},
		30_000,
	);
});
