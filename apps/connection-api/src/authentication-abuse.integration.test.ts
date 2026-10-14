import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ConnectionOAuthService } from "@agent-infra/connection-core";
import {
	assertIsolatedTestDatabaseUrl,
	migrateConnectionDatabase,
	PostgresBrowserCommandIdempotency,
	PostgresConnectionOAuthRepository,
} from "@agent-infra/connection-store";
import { expect, it, vi } from "vitest";
import { createConnectionOAuthApp } from "./oauth-routes";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl)
	throw new Error("CONNECTION_TEST_DATABASE_URL is required in CI");
const integrationTest = databaseUrl ? it : it.skip;

integrationTest(
	"HTTP login throttles normalized accounts despite new idempotency keys and forged forwarding headers; successful logins release their own reservation",
	async () => {
		if (!databaseUrl) return;
		await migrateConnectionDatabase(
			databaseUrl,
			resolve(import.meta.dirname, "../../../migrations/connection"),
		);
		const repository = new PostgresConnectionOAuthRepository(databaseUrl);
		const commands = new PostgresBrowserCommandIdempotency(
			databaseUrl,
			Buffer.alloc(32, 43),
		);
		const suffix = randomUUID();
		const issuer = "https://connection.example";
		const authenticate = vi.fn(async (username: string, password: string) => {
			if (password !== "synthetic-correct")
				throw new Error("Directory authentication failed");
			return {
				displayName: username,
				email: `${username}@example.invalid`,
				issuer: "urn:test:ldap",
				subject: username,
			};
		});
		const service = new ConnectionOAuthService({
			consumer: { id: `auth-budget-http-${suffix}`, name: "HTTP budget" },
			directory: { authenticate, isActive: async () => true },
			identityRealm: `urn:test:budget-http:${suffix}`,
			identityKey: Buffer.alloc(32, 44),
			repository,
			resource: `${issuer}/mcp`,
		});
		const app = createConnectionOAuthApp({
			issuer,
			resource: `${issuer}/mcp`,
			service,
			browserCommands: commands,
			dynamicClientRegistration: { clientName: "Codex" },
		});
		const login = (username: string, password: string) =>
			app.request(`${issuer}/api/v1/connection/session`, {
				method: "POST",
				headers: {
					origin: issuer,
					"content-type": "application/json",
					"idempotency-key": randomUUID(),
					"x-forwarded-for": `untrusted-${randomUUID()}`,
				},
				body: JSON.stringify({ username, password }),
			});
		try {
			const denied = await Promise.all(
				Array.from({ length: 12 }, (_, i) =>
					login(
						i % 2 ? ` Alice-${suffix.toUpperCase()} ` : `alice-${suffix}`,
						"synthetic-wrong",
					),
				),
			);
			expect(denied.filter((r) => r.status === 401)).toHaveLength(10);
			expect(denied.filter((r) => r.status === 429)).toHaveLength(2);
			expect(authenticate).toHaveBeenCalledTimes(10);
			for (const response of denied.filter((r) => r.status === 429)) {
				expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
				expect(response.headers.get("location")).toBeNull();
				expect(await response.json()).toMatchObject({
					error: {
						code: "RATE_LIMITED",
						messageKey: "connection.error.authentication_rate_limited",
					},
				});
			}
			for (let i = 0; i < 12; i++)
				expect((await login(`bob-${suffix}`, "synthetic-correct")).status).toBe(
					200,
				);
			expect(
				(await app.request("/api/v1/connection/openapi.json")).status,
			).toBe(401);
			const registrations = await Promise.all(
				Array.from({ length: 33 }, () =>
					app.request("/oauth/register", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							application_type: "native",
							client_name: "Codex",
							grant_types: ["authorization_code", "refresh_token"],
							redirect_uris: ["http://127.0.0.1:58245/callback/budget-test"],
							response_types: ["code"],
							scope: "mcp",
							token_endpoint_auth_method: "none",
						}),
					}),
				),
			);
			expect(registrations.filter((r) => r.status === 201)).toHaveLength(30);
			expect(registrations.filter((r) => r.status === 429)).toHaveLength(3);
			for (const response of registrations.filter((r) => r.status === 429)) {
				expect(response.headers.get("location")).toBeNull();
				expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
				expect(await response.json()).toMatchObject({
					error: "temporarily_unavailable",
				});
			}
		} finally {
			await repository.close();
			await commands.close();
		}
	},
);
