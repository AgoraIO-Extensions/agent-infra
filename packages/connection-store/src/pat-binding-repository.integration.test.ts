import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ConnectionOAuthService } from "@agent-infra/connection-core";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

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
		"binds confirmation proof to session, account, binding, purpose and deadline with single consumption",
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
			const suffix = randomUUID();
			const options = {
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
				identityRealm: `urn:test:csrf:${suffix}`,
				identityKey: Buffer.alloc(32, 31),
				patBinding: { repository: bindingRepository },
				repository: oauthRepository,
				resource: "https://connection.example/mcp",
			};
			const service = new ConnectionOAuthService(options);
			try {
				const client = await service.registerPatBindingConsumer({
					consumerId: `csrf-client-${suffix}`,
					consumerName: "CSRF client",
					callbackUrl: "https://client.example/callback",
				});
				const alice = await service.loginBrowserSession({
					username: `alice-${suffix}`,
					password: "fake",
				});
				const aliceOtherSession = await service.loginBrowserSession({
					username: `alice-${suffix}`,
					password: "fake",
				});
				const bob = await service.loginBrowserSession({
					username: `bob-${suffix}`,
					password: "fake",
				});
				const create = async () => {
					const pending = await service.createPersonalAccessTokenBinding({
						consumerId: client.consumerId,
						secret: client.secret,
						name: "CSRF test",
					});
					return {
						...pending,
						state:
							new URL(pending.authorizationUrl).pathname.split("/").at(-1) ??
							"",
					};
				};
				const pending = await create();
				const other = await create();
				const confirmation =
					await service.createPersonalAccessTokenBindingConfirmation({
						sessionToken: alice.sessionToken,
						state: pending.state,
					});
				const input = {
					csrfToken: confirmation.csrfToken,
					sessionToken: alice.sessionToken,
					state: pending.state,
				};
				for (const invalid of [
					{ ...input, csrfToken: "" },
					{ ...input, csrfToken: "invalid" },
					{ ...input, csrfToken: `${input.csrfToken}.extra` },
					{
						...input,
						csrfToken:
							(input.csrfToken[0] === "A" ? "B" : "A") +
							input.csrfToken.slice(1),
					},
					{ ...input, sessionToken: bob.sessionToken },
					{ ...input, sessionToken: aliceOtherSession.sessionToken },
					{ ...input, state: other.state },
				])
					await expect(
						service.confirmPersonalAccessTokenBindingWithCsrf(invalid),
					).rejects.toMatchObject({ error: "access_denied" });
				const otherOrigin = new ConnectionOAuthService({
					...options,
					resource: "https://other.example/mcp",
				});
				await expect(
					otherOrigin.confirmPersonalAccessTokenBindingWithCsrf(input),
				).rejects.toMatchObject({ reason: "PROOF_MISMATCH" });
				const clock = vi
					.spyOn(Date, "now")
					.mockReturnValue(Date.now() + 5 * 60_000 + 1);
				try {
					await expect(
						service.confirmPersonalAccessTokenBindingWithCsrf(input),
					).rejects.toMatchObject({ reason: "PROOF_EXPIRED" });
				} finally {
					clock.mockRestore();
				}
				await service.confirmPersonalAccessTokenBinding({
					state: other.state,
					sessionToken: alice.sessionToken,
					expectedPrincipalId: alice.account.principalId,
				});
				const [otherRow] =
					await sql`SELECT protected_token FROM connection_pat_binding_sessions WHERE id = ${other.bindingId}`;
				await expect(
					service.confirmPersonalAccessTokenBindingWithCsrf({
						...input,
						csrfToken: otherRow?.protected_token,
					}),
				).rejects.toMatchObject({ reason: "INVALID_PROOF" });
				await expect(
					service.confirmPersonalAccessTokenBinding({
						state: pending.state,
						sessionToken: alice.sessionToken,
						expectedPrincipalId: alice.account.principalId,
						confirmationExpiresAt: new Date(0),
					}),
				).rejects.toMatchObject({ reason: "PROOF_EXPIRED" });
				const [before] =
					await sql`SELECT status, token_id FROM connection_pat_binding_sessions WHERE id = ${pending.bindingId}`;
				expect(before).toMatchObject({ status: "PENDING", token_id: null });
				const attempts = await Promise.allSettled([
					service.confirmPersonalAccessTokenBindingWithCsrf(input),
					service.confirmPersonalAccessTokenBindingWithCsrf(input),
				]);
				expect(
					attempts.filter((attempt) => attempt.status === "fulfilled"),
				).toHaveLength(1);
				expect(
					attempts.filter((attempt) => attempt.status === "rejected"),
				).toHaveLength(1);
				const [count] =
					await sql`SELECT count(*)::int AS count FROM connection_personal_access_tokens token JOIN connection_pat_binding_sessions binding ON binding.token_id=token.id WHERE binding.id = ${pending.bindingId}`;
				expect(count?.count).toBe(1);
				const claimed = await service.claimPersonalAccessTokenBinding({
					bindingId: pending.bindingId,
					consumerId: client.consumerId,
					secret: client.secret,
				});
				expect(claimed.account.id).toBe(alice.account.principalId);
				await expect(
					service.confirmPersonalAccessTokenBindingWithCsrf(input),
				).rejects.toMatchObject({ error: "invalid_request" });
				const expiredBinding = await create();
				const expiredProof =
					await service.createPersonalAccessTokenBindingConfirmation({
						state: expiredBinding.state,
						sessionToken: alice.sessionToken,
					});
				await sql`UPDATE connection_pat_binding_sessions SET expires_at = now() - interval '1 minute' WHERE id = ${expiredBinding.bindingId}`;
				await expect(
					service.confirmPersonalAccessTokenBindingWithCsrf({
						state: expiredBinding.state,
						csrfToken: expiredProof.csrfToken,
						sessionToken: alice.sessionToken,
					}),
				).rejects.toMatchObject({ error: "invalid_request" });
				const disabledBinding = await create();
				const disabledProof =
					await service.createPersonalAccessTokenBindingConfirmation({
						state: disabledBinding.state,
						sessionToken: alice.sessionToken,
					});
				await service.disablePatBindingConsumer(client.consumerId);
				await expect(
					service.confirmPersonalAccessTokenBindingWithCsrf({
						state: disabledBinding.state,
						csrfToken: disabledProof.csrfToken,
						sessionToken: alice.sessionToken,
					}),
				).rejects.toMatchObject({ error: "invalid_request" });
			} finally {
				await sql.end();
				await bindingRepository.close();
				await oauthRepository.close();
			}
		},
		30_000,
	);
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
				identityRealm: "urn:agora:connection:test",
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
				expect(guardedClaim.account).toEqual({
					id: aliceLogin.account.principalId,
					email: "alice-link-owner@example.invalid",
					displayName: "alice-link-owner",
				});

				const otherClient = await service.registerPatBindingConsumer({
					callbackUrl: "https://other-agent.example/callback",
					consumerId: `other-client-${randomUUID()}`,
					consumerName: "Other client",
				});
				const unhinted = await service.createPersonalAccessTokenBinding({
					consumerId: "consumer-rehoboam-ai",
					name: `unhinted / ${randomUUID()}`,
					secret,
				});
				const unhintedState =
					new URL(unhinted.authorizationUrl).pathname.split("/").at(-1) ?? "";
				const [unhintedRow] =
					await sql`SELECT principal_hint_hash FROM connection_pat_binding_sessions WHERE id = ${unhinted.bindingId}`;
				expect(unhintedRow?.principal_hint_hash).toBeNull();
				await expect(
					service.claimPersonalAccessTokenBinding({
						bindingId: unhinted.bindingId,
						consumerId: "consumer-rehoboam-ai",
						secret,
					}),
				).rejects.toMatchObject({ error: "invalid_grant" });
				for (const expectedPrincipalId of [
					undefined,
					aliceLogin.account.principalId,
				]) {
					await expect(
						service.confirmPersonalAccessTokenBinding({
							expectedPrincipalId,
							sessionToken: bobLogin.sessionToken,
							state: unhintedState,
						}),
					).rejects.toMatchObject({ error: "access_denied" });
				}
				const unhintedConfirmed =
					await service.confirmPersonalAccessTokenBinding({
						expectedPrincipalId: bobLogin.account.principalId,
						sessionToken: bobLogin.sessionToken,
						state: unhintedState,
					});
				expect(new URL(unhintedConfirmed.callbackUrl).searchParams.size).toBe(
					1,
				);
				await expect(
					service.claimPersonalAccessTokenBinding({
						bindingId: unhinted.bindingId,
						consumerId: otherClient.consumerId,
						secret: otherClient.secret,
					}),
				).rejects.toMatchObject({ error: "invalid_grant" });
				const unhintedClaim = await service.claimPersonalAccessTokenBinding({
					bindingId: unhinted.bindingId,
					consumerId: "consumer-rehoboam-ai",
					secret,
				});
				expect(unhintedClaim.account).toEqual({
					id: bobLogin.account.principalId,
					email: "bob-link-recipient@example.invalid",
					displayName: "bob-link-recipient",
				});
				expect(
					(await service.verifyAccessToken(`Bearer ${unhintedClaim.token}`))
						.principalId,
				).toBe(unhintedClaim.account.id);
				await expect(
					service.claimPersonalAccessTokenBinding({
						bindingId: unhinted.bindingId,
						consumerId: "consumer-rehoboam-ai",
						secret,
					}),
				).rejects.toMatchObject({ error: "invalid_grant" });
				for (const principalHint of ["", "  ", null, 42, "x".repeat(321)]) {
					await expect(
						service.createPersonalAccessTokenBinding({
							consumerId: "consumer-rehoboam-ai",
							name: "invalid hint",
							secret,
							principalHint: principalHint as unknown as string,
						}),
					).rejects.toMatchObject({ error: "invalid_request" });
				}

				for (const denial of [
					"expired",
					"revoked",
					"principal",
					"instance",
					"identity",
					"recovery",
				] as const) {
					const login = await service.loginBrowserSession({
						password: "integration-password",
						username: `binding-${denial}-${randomUUID()}`,
					});
					const pending = await service.createPersonalAccessTokenBinding({
						consumerId: "consumer-rehoboam-ai",
						name: `denied-${denial}`,
						secret,
					});
					await service.confirmPersonalAccessTokenBinding({
						expectedPrincipalId: login.account.principalId,
						sessionToken: login.sessionToken,
						state:
							new URL(pending.authorizationUrl).pathname.split("/").at(-1) ??
							"",
					});
					const [issued] =
						await sql`SELECT token_id, instance_id FROM connection_pat_binding_sessions WHERE id = ${pending.bindingId}`;
					if (denial === "expired")
						await sql`UPDATE connection_pat_binding_sessions SET expires_at = now() - interval '1 minute' WHERE id = ${pending.bindingId}`;
					if (denial === "revoked")
						await sql`UPDATE connection_personal_access_tokens SET revoked_at = now() WHERE id = ${issued?.token_id}`;
					if (denial === "principal")
						await sql`UPDATE connection_principals SET status = 'DISABLED' WHERE id = ${login.account.principalId}`;
					if (denial === "instance")
						await sql`UPDATE connection_consumer_instances SET status = 'REVOKED' WHERE id = ${issued?.instance_id}`;
					if (denial === "identity")
						await sql`UPDATE connection_principal_identities SET status = 'DISABLED' WHERE principal_id = ${login.account.principalId}`;
					if (denial === "recovery")
						await sql`UPDATE connection_personal_access_tokens SET recovery_generation = (recovery_generation::bigint + 1)::text WHERE id = ${issued?.token_id}`;
					await expect(
						service.claimPersonalAccessTokenBinding({
							bindingId: pending.bindingId,
							consumerId: "consumer-rehoboam-ai",
							secret,
						}),
					).rejects.toMatchObject({ error: "invalid_grant" });
				}

				const noEmailLogin = await service.loginBrowserSession({
					password: "integration-password",
					username: `no-email-${randomUUID()}`,
				});
				await sql`UPDATE connection_principals SET email = NULL WHERE id = ${noEmailLogin.account.principalId}`;
				const noEmailBinding = await service.createPersonalAccessTokenBinding({
					consumerId: "consumer-rehoboam-ai",
					name: "No email",
					secret,
				});
				await service.confirmPersonalAccessTokenBinding({
					expectedPrincipalId: noEmailLogin.account.principalId,
					sessionToken: noEmailLogin.sessionToken,
					state:
						new URL(noEmailBinding.authorizationUrl).pathname
							.split("/")
							.at(-1) ?? "",
				});
				const noEmailClaim = await service.claimPersonalAccessTokenBinding({
					bindingId: noEmailBinding.bindingId,
					consumerId: "consumer-rehoboam-ai",
					secret,
				});
				expect(noEmailClaim.account.email).toBeNull();
				expect(noEmailClaim.account.id).toBe(noEmailLogin.account.principalId);
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
