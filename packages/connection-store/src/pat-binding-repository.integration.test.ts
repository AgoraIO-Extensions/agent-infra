import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ConnectionOAuthService } from "@agent-infra/connection-core";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionOAuthRepository } from "./oauth-repository";
import { PostgresConnectionPatBindingRepository } from "./pat-binding-repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl) {
	throw new Error("CONNECTION_TEST_DATABASE_URL is required in CI");
}
const integrationTest = databaseUrl ? it : it.skip;

describe("PostgreSQL PAT binding", () => {
	integrationTest(
		"binds, claims, and isolates one PAT per Principal and token instance",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const oauthRepository = new PostgresConnectionOAuthRepository(
				databaseUrl,
			);
			const bindingRepository = new PostgresConnectionPatBindingRepository(
				databaseUrl,
			);
			const sql = postgres(databaseUrl, { max: 1 });
			const service = new ConnectionOAuthService({
				consumer: { id: "consumer-codex", name: "Codex" },
				directory: {
					authenticate: async (username: string) => ({
						displayName: username,
						email: `${username}@example.invalid`,
						issuer: "urn:test:company-ldap",
						subject: username,
					}),
					isActive: async () => true,
				},
				identityEnvironment: "https://connection.example/",
				identityKey: Buffer.alloc(32, 31),
				patBinding: {
					repository: bindingRepository,
				},
				patConsumers: [{ id: "consumer-rehoboam-ai", name: "RehoboamAI" }],
				repository: oauthRepository,
				resource: "https://connection.example/mcp",
			});
			const registration = await service.registerPatBindingConsumer({
				callbackUrl: "https://rehoboam.example/api/connection/callback",
				consumerId: "consumer-rehoboam-ai",
				consumerName: "RehoboamAI",
			});
			const secret = registration.secret;

			const bind = async (username: string, agent: string) => {
				const login = await service.loginBrowserSession({
					password: "integration-password",
					username,
				});
				const created = await service.createPersonalAccessTokenBinding({
					consumerId: "consumer-rehoboam-ai",
					name: `${username} / ${agent} / ${randomUUID()}`,
					principalHint: `${username}@example.invalid`,
					secret,
				});
				const state = new URL(created.authorizationUrl).pathname
					.split("/")
					.at(-1);
				expect(state).toMatch(/^conn_pat_binding_[A-Za-z0-9_-]{43}$/);
				const preview = await service.getPersonalAccessTokenBinding(
					state ?? "",
				);
				expect(preview.bindingId).toBe(created.bindingId);
				const confirmed = await service.confirmPersonalAccessTokenBinding({
					sessionToken: login.sessionToken,
					state: state ?? "",
				});
				expect(confirmed.callbackUrl).toBe(
					`https://rehoboam.example/api/connection/callback?binding_id=${created.bindingId}`,
				);
				const claimed = await service.claimPersonalAccessTokenBinding({
					bindingId: created.bindingId,
					consumerId: "consumer-rehoboam-ai",
					secret,
				});
				return {
					bindingId: created.bindingId,
					claimed,
					identity: await service.verifyAccessToken(`Bearer ${claimed.token}`),
				};
			};

			try {
				const aliceLogin = await service.loginBrowserSession({
					password: "integration-password",
					username: "alice-link-owner",
				});
				const bobLogin = await service.loginBrowserSession({
					password: "integration-password",
					username: "bob-link-recipient",
				});
				const guarded = await service.createPersonalAccessTokenBinding({
					consumerId: "consumer-rehoboam-ai",
					name: `guarded / ${randomUUID()}`,
					principalHint: "alice-link-owner@example.invalid",
					secret,
				});
				const guardedState = new URL(guarded.authorizationUrl).pathname
					.split("/")
					.at(-1);
				await expect(
					service.confirmPersonalAccessTokenBinding({
						sessionToken: bobLogin.sessionToken,
						state: guardedState ?? "",
					}),
				).rejects.toMatchObject({ error: "access_denied" });
				await service.confirmPersonalAccessTokenBinding({
					sessionToken: aliceLogin.sessionToken,
					state: guardedState ?? "",
				});
				const guardedClaim = await service.claimPersonalAccessTokenBinding({
					bindingId: guarded.bindingId,
					consumerId: "consumer-rehoboam-ai",
					secret,
				});
				expect(
					(await service.verifyAccessToken(`Bearer ${guardedClaim.token}`))
						.principalId,
				).toBe(aliceLogin.account.principalId);

				const aliceAgentA = await bind("alice", "agent-a");
				const aliceAgentB = await bind("alice", "agent-b");
				const bobAgentA = await bind("bob", "agent-a");

				expect(aliceAgentA.claimed.token).not.toBe(aliceAgentB.claimed.token);
				expect(aliceAgentA.identity.principalId).toBe(
					aliceAgentB.identity.principalId,
				);
				expect(aliceAgentA.identity.instanceId).not.toBe(
					aliceAgentB.identity.instanceId,
				);
				expect(bobAgentA.identity.principalId).not.toBe(
					aliceAgentA.identity.principalId,
				);
				expect(bobAgentA.identity.consumerId).toBe("consumer-rehoboam-ai");

				const [stored] = await sql<
					{ protected_token: string; token_hash: string }[]
				>`
					SELECT binding.protected_token, token.token_hash
					FROM connection_pat_binding_sessions binding
					JOIN connection_personal_access_tokens token
						ON token.id = binding.token_id
					WHERE token.id = ${aliceAgentA.claimed.tokenId}
				`;
				expect(stored?.protected_token).not.toContain(
					aliceAgentA.claimed.token,
				);
				expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/);
				expect(stored?.token_hash).not.toBe(aliceAgentA.claimed.token);
				const [profile] = await sql<{ secret_hash: string }[]>`
					SELECT secret_hash FROM connection_pat_consumer_profiles
					WHERE consumer_id = 'consumer-rehoboam-ai'
				`;
				expect(profile?.secret_hash).toMatch(/^[a-f0-9]{64}$/);
				expect(profile?.secret_hash).not.toBe(secret);

				await expect(
					service.claimPersonalAccessTokenBinding({
						bindingId: aliceAgentA.bindingId,
						consumerId: "consumer-rehoboam-ai",
						secret,
					}),
				).rejects.toMatchObject({ error: "invalid_grant" });
				await expect(
					service.createPersonalAccessTokenBinding({
						consumerId: "consumer-rehoboam-ai",
						name: "wrong secret",
						principalHint: "alice@example.invalid",
						secret: "wrong",
					}),
				).rejects.toMatchObject({ error: "invalid_client" });
				await service.disablePatBindingConsumer("consumer-rehoboam-ai");
				await expect(
					service.createPersonalAccessTokenBinding({
						consumerId: "consumer-rehoboam-ai",
						name: "disabled consumer",
						principalHint: "alice@example.invalid",
						secret,
					}),
				).rejects.toMatchObject({ error: "invalid_client" });
			} finally {
				await sql.end();
				await bindingRepository.close();
				await oauthRepository.close();
			}
		},
		30_000,
	);
});
