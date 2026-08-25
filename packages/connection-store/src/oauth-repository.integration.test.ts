import { createHash, createHmac, hkdfSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConnectionOAuthService } from "@agent-infra/connection-core";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionOAuthRepository } from "./oauth-repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl) {
	throw new Error("CONNECTION_TEST_DATABASE_URL is required in CI");
}
const integrationTest = databaseUrl ? it : it.skip;

describe("PostgreSQL Connection OAuth", () => {
	integrationTest(
		"issues hash-only portable PATs for one LDAP Principal with independent revocation",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const repository = new PostgresConnectionOAuthRepository(databaseUrl);
			const sql = postgres(databaseUrl, { max: 1 });
			const service = new ConnectionOAuthService({
				consumer: { id: "consumer-codex", name: "Codex" },
				directory: {
					authenticate: async (username: string) => ({
						displayName: "PAT Integration User",
						email: "pat-integration@example.invalid",
						issuer: "urn:test:company-ldap",
						subject: username,
					}),
					isActive: async () => true,
				},
				identityEnvironment: "test",
				identityKey: Buffer.alloc(32, 19),
				repository,
				resource: "https://connection.example/mcp",
			});

			try {
				const browserLogin = await service.loginBrowserSession({
					password: "integration-password",
					username: "pat-stable-uid",
				});
				const otherBrowserLogin = await service.loginBrowserSession({
					password: "integration-password",
					username: "pat-other-stable-uid",
				});
				const first = await service.issuePersonalAccessToken({
					name: `Codex ${randomUUID()}`,
					sessionToken: browserLogin.sessionToken,
				});
				const second = await service.issuePersonalAccessToken({
					name: `Claude ${randomUUID()}`,
					sessionToken: browserLogin.sessionToken,
				});
				const other = await service.issuePersonalAccessToken({
					name: `Other principal ${randomUUID()}`,
					sessionToken: otherBrowserLogin.sessionToken,
				});
				expect(first.token).toMatch(/^conn_pat_[A-Za-z0-9_-]{43}$/);
				expect(second.token).not.toBe(first.token);

				const firstIdentity = await service.verifyAccessToken(
					`Bearer ${first.token}`,
				);
				const secondIdentity = await service.verifyAccessToken(
					`Bearer ${second.token}`,
				);
				const verifier = "P".repeat(43);
				const client = await service.registerClient({
					clientName: `OAuth ${randomUUID()}`,
					redirectUris: ["http://127.0.0.1/callback"],
				});
				const pending = await service.beginAuthorization({
					clientId: client.clientId,
					codeChallenge: createHash("sha256")
						.update(verifier, "ascii")
						.digest("base64url"),
					codeChallengeMethod: "S256",
					redirectUri: "http://127.0.0.1/callback",
					resource: "https://connection.example/mcp",
					responseType: "code",
					scope: "mcp",
					state: randomUUID(),
				});
				const approved = await service.approveAuthorization({
					password: "integration-password",
					requestId: pending.requestId,
					username: "pat-stable-uid",
				});
				const oauthTokens = await service.exchangeAuthorizationCode({
					clientId: client.clientId,
					code: approved.code,
					codeVerifier: verifier,
					redirectUri: "http://127.0.0.1/callback",
					resource: "https://connection.example/mcp",
				});
				const oauthIdentity = await service.verifyAccessToken(
					`Bearer ${oauthTokens.access_token}`,
				);
				expect(firstIdentity).toMatchObject({
					consumerId: "consumer-portable-pat",
				});
				expect(firstIdentity.principalId).toBe(secondIdentity.principalId);
				expect(oauthIdentity).toMatchObject({ consumerId: "consumer-codex" });
				expect(oauthIdentity.principalId).toBe(firstIdentity.principalId);
				expect(firstIdentity.instanceId).not.toBe(secondIdentity.instanceId);
				expect(
					await service.getBrowserAccount(browserLogin.sessionToken),
				).toMatchObject({ principalId: firstIdentity.principalId });
				const visibleTokenIds = (
					await service.listPersonalAccessTokens(browserLogin.sessionToken)
				).map((token) => token.tokenId);
				expect(visibleTokenIds).toEqual(
					expect.arrayContaining([first.tokenId, second.tokenId]),
				);
				expect(visibleTokenIds).not.toContain(other.tokenId);

				const [stored] = await sql<
					{ instance_kind: string; name: string; token_hash: string }[]
				>`
					SELECT token.name, token.token_hash, instance.kind AS instance_kind
					FROM connection_personal_access_tokens token
					JOIN connection_consumer_instances instance ON instance.id = token.instance_id
					WHERE token.id = ${first.tokenId}
				`;
				expect(stored?.name).toBe(first.name);
				expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/);
				expect(stored?.token_hash).not.toBe(first.token);
				expect(stored?.instance_kind).toBe("TOKEN");
				const [storedBrowserSession] = await sql<{ session_hash: string }[]>`
					SELECT session_hash FROM connection_browser_sessions
					WHERE principal_id = ${firstIdentity.principalId}
					ORDER BY created_at DESC LIMIT 1
				`;
				expect(storedBrowserSession?.session_hash).toMatch(/^[a-f0-9]{64}$/);
				expect(storedBrowserSession?.session_hash).not.toBe(
					browserLogin.sessionToken,
				);
				const [otherStored] = await sql<{ principal_id: string }[]>`
					SELECT principal_id FROM connection_personal_access_tokens
					WHERE id = ${other.tokenId}
				`;
				await expect(sql`
					UPDATE connection_personal_access_tokens
					SET principal_id = ${otherStored?.principal_id ?? ""}
					WHERE id = ${first.tokenId}
				`).rejects.toBeDefined();
				await expect(
					service.revokeInstance(
						`Bearer ${first.token}`,
						secondIdentity.instanceId,
					),
				).rejects.toMatchObject({ error: "invalid_token" });
				await expect(sql`
					UPDATE connection_oauth_sessions
					SET principal_id = ${otherStored?.principal_id ?? ""}
					WHERE instance_id = ${oauthIdentity.instanceId}
				`).rejects.toBeDefined();
				await expect(sql`
					UPDATE connection_oauth_authorizations
					SET consumer_id = 'consumer-portable-pat'
					WHERE client_id = ${client.clientId}
				`).rejects.toBeDefined();
				await service.revokePersonalAccessToken({
					sessionToken: otherBrowserLogin.sessionToken,
					tokenId: first.tokenId,
				});
				expect(
					await service.verifyAccessToken(`Bearer ${first.token}`),
				).toMatchObject({ principalId: firstIdentity.principalId });
				await service.revokePersonalAccessToken({
					sessionToken: browserLogin.sessionToken,
					tokenId: first.tokenId,
				});
				await expect(
					service.verifyAccessToken(`Bearer ${first.token}`),
				).rejects.toMatchObject({ error: "invalid_token" });

				expect(
					await service.verifyAccessToken(`Bearer ${second.token}`),
				).toMatchObject({ principalId: secondIdentity.principalId });
				await service.logoutBrowserSession(browserLogin.sessionToken);
				await expect(
					service.getBrowserAccount(browserLogin.sessionToken),
				).rejects.toMatchObject({ error: "invalid_token" });
				expect(
					await service.verifyAccessToken(`Bearer ${second.token}`),
				).toMatchObject({ principalId: secondIdentity.principalId });
			} finally {
				await sql.end();
				await repository.close();
			}
		},
		30_000,
	);

	integrationTest(
		"invalidates browser sessions after expiry, account disable, or recovery",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const repository = new PostgresConnectionOAuthRepository(databaseUrl);
			const sql = postgres(databaseUrl, { max: 1 });
			const service = new ConnectionOAuthService({
				consumer: { id: "consumer-codex", name: "Codex" },
				directory: {
					authenticate: async (username: string) => ({
						displayName: "Browser Session User",
						email: "browser-session@example.invalid",
						issuer: "urn:test:company-ldap",
						subject: username,
					}),
					isActive: async () => true,
				},
				identityEnvironment: "test",
				identityKey: Buffer.alloc(32, 23),
				repository,
				resource: "https://connection.example/mcp",
			});
			const login = () =>
				service.loginBrowserSession({
					password: "integration-password",
					username: `browser-session-${randomUUID()}`,
				});
			const expectInvalid = async (sessionToken: string) => {
				await expect(
					service.listPersonalAccessTokens(sessionToken),
				).rejects.toMatchObject({ error: "invalid_token" });
			};

			try {
				const expired = await login();
				await sql`
					UPDATE connection_browser_sessions SET expires_at = now() - interval '1 second'
					WHERE principal_id = ${expired.account.principalId}
				`;
				await expectInvalid(expired.sessionToken);

				const identityDisabled = await login();
				await sql`
					UPDATE connection_principal_identities SET status = 'DISABLED'
					WHERE principal_id = ${identityDisabled.account.principalId}
				`;
				await expectInvalid(identityDisabled.sessionToken);

				const principalDisabled = await login();
				await sql`
					UPDATE connection_principals SET status = 'DISABLED'
					WHERE id = ${principalDisabled.account.principalId}
				`;
				await expectInvalid(principalDisabled.sessionToken);

				const recovered = await login();
				await sql`
					UPDATE connection_recovery_control
					SET generation = (generation::bigint + 1)::text
				`;
				await expectInvalid(recovered.sessionToken);
			} finally {
				await sql.end();
				await repository.close();
			}
		},
		30_000,
	);

	integrationTest(
		"shares one Principal across devices and isolates session revocation",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const repository = new PostgresConnectionOAuthRepository(databaseUrl);
			const sql = postgres(databaseUrl, { max: 1 });
			const directory = {
				authenticate: async (username: string) => ({
					displayName: "Integration User",
					email: "integration@example.invalid",
					issuer: "urn:test:company-ldap",
					subject: username,
				}),
				isActive: async () => true,
			};
			const identityKey = Buffer.alloc(32, 9);
			const stableSubject = `integration-stable-uid-${randomUUID()}`;
			const createService = (consumer: { id: string; name: string }) =>
				new ConnectionOAuthService({
					consumer,
					directory,
					identityEnvironment: "test",
					identityKey,
					repository,
					resource: "https://connection.example/mcp",
				});
			const service = createService({ id: "consumer-codex", name: "Codex" });
			const verifier = "A".repeat(43);
			const challenge = createHash("sha256")
				.update(verifier, "ascii")
				.digest("base64url");

			const login = async (
				clientName: string,
				username = stableSubject,
				oauthService = service,
				resource = "https://connection.example/mcp",
			) => {
				const client = await oauthService.registerClient({
					clientName,
					redirectUris: ["http://127.0.0.1/callback"],
				});
				const pending = await oauthService.beginAuthorization({
					clientId: client.clientId,
					codeChallenge: challenge,
					codeChallengeMethod: "S256",
					redirectUri: "http://127.0.0.1/callback",
					resource,
					responseType: "code",
					scope: "mcp",
					state: `${clientName}-${randomUUID()}`,
				});
				const approved = await oauthService.approveAuthorization({
					password: "integration-password",
					requestId: pending.requestId,
					username,
				});
				const tokens = await oauthService.exchangeAuthorizationCode({
					clientId: client.clientId,
					code: approved.code,
					codeVerifier: verifier,
					redirectUri: "http://127.0.0.1/callback",
					resource,
				});
				return {
					client,
					identity: await oauthService.verifyAccessToken(
						`Bearer ${tokens.access_token}`,
					),
					tokens,
				};
			};

			try {
				const rootColumns = await sql<{ column_name: string }[]>`
						SELECT column_name FROM information_schema.columns
						WHERE table_name = 'connection_authorization_roots'
					`;
				expect(rootColumns.map((row) => row.column_name)).toContain(
					"provider_id",
				);
				expect(rootColumns.map((row) => row.column_name)).not.toContain(
					"connection_id",
				);
				expect(rootColumns.map((row) => row.column_name)).not.toContain(
					"instance_id",
				);

				const first = await login(`device-one-${randomUUID()}`);
				expect(first.identity.principalId).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
				);
				const [currentMapping] = await sql<{ identity_subject_hash: string }[]>`
					SELECT identity_subject_hash FROM connection_principal_identities
					WHERE principal_id = ${first.identity.principalId}
				`;
				expect(currentMapping?.identity_subject_hash).toMatch(
					/^v1:[0-9a-f]{64}$/,
				);
				const subjectKey = Buffer.from(
					hkdfSync(
						"sha256",
						identityKey,
						Buffer.alloc(0),
						"connection-identity-subject",
						32,
					),
				);
				const legacyHash = createHmac("sha256", subjectKey)
					.update("urn:test:company-ldap", "utf8")
					.update("\0")
					.update(stableSubject, "utf8")
					.digest("hex");
				const legacyPrincipalId = `principal-${legacyHash}`;
				await sql`
					UPDATE connection_principals SET id = ${legacyPrincipalId}
					WHERE id = ${first.identity.principalId}
				`;
				await sql`
					UPDATE connection_principal_identities
					SET identity_subject_hash = ${legacyHash}
					WHERE principal_id = ${legacyPrincipalId}
				`;
				const second = await login(`device-two-${randomUUID()}`);
				const remappedFirst = await service.verifyAccessToken(
					`Bearer ${first.tokens.access_token}`,
				);
				const other = await login(
					`other-principal-${randomUUID()}`,
					"other-stable-uid",
				);
				expect(second.identity.principalId).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
				);
				expect(second.identity.principalId).not.toBe(legacyPrincipalId);
				expect(remappedFirst.principalId).toBe(second.identity.principalId);
				const [upgradedMapping] = await sql<
					{ identity_subject_hash: string }[]
				>`
					SELECT identity_subject_hash FROM connection_principal_identities
					WHERE principal_id = ${second.identity.principalId}
				`;
				expect(upgradedMapping?.identity_subject_hash).toBe(
					currentMapping?.identity_subject_hash,
				);
				expect(first.identity.instanceId).not.toBe(second.identity.instanceId);
				const isolatedResource = "https://isolated-connection.example/mcp";
				const isolatedEnvironmentService = new ConnectionOAuthService({
					consumer: { id: "consumer-codex", name: "Codex" },
					directory,
					identityEnvironment: "isolated-test",
					identityKey,
					repository,
					resource: isolatedResource,
				});
				const isolatedEnvironment = await login(
					`isolated-environment-${randomUUID()}`,
					stableSubject,
					isolatedEnvironmentService,
					isolatedResource,
				);
				expect(isolatedEnvironment.identity.principalId).not.toBe(
					second.identity.principalId,
				);
				const [isolatedMapping] = await sql<
					{ identity_subject_hash: string }[]
				>`
					SELECT identity_subject_hash FROM connection_principal_identities
					WHERE principal_id = ${isolatedEnvironment.identity.principalId}
				`;
				expect(isolatedMapping?.identity_subject_hash).not.toBe(
					upgradedMapping?.identity_subject_hash,
				);
				await expect(
					service.verifyAccessToken(
						`Bearer ${isolatedEnvironment.tokens.access_token}`,
					),
				).rejects.toMatchObject({ error: "invalid_token" });
				expect(other.identity.principalId).not.toBe(
					second.identity.principalId,
				);
				const otherConsumerId = `consumer-cursor-${randomUUID()}`;
				const otherConsumerService = createService({
					id: otherConsumerId,
					name: "Cursor",
				});
				const otherConsumer = await login(
					`other-consumer-${randomUUID()}`,
					stableSubject,
					otherConsumerService,
				);
				const oldResource = "https://old-connection.example/mcp";
				const oldResourceService = new ConnectionOAuthService({
					consumer: { id: "consumer-codex", name: "Codex" },
					directory,
					identityEnvironment: "test",
					identityKey,
					repository,
					resource: oldResource,
				});
				const oldAudience = await login(
					`old-audience-${randomUUID()}`,
					stableSubject,
					oldResourceService,
					oldResource,
				);
				await expect(
					service.verifyAccessToken(
						`Bearer ${oldAudience.tokens.access_token}`,
					),
				).rejects.toMatchObject({ error: "invalid_token" });
				expect(
					await oldResourceService.verifyAccessToken(
						`Bearer ${oldAudience.tokens.access_token}`,
					),
				).toMatchObject({ principalId: second.identity.principalId });
				await expect(
					service.revokeInstance(
						`Bearer ${first.tokens.access_token}`,
						otherConsumer.identity.instanceId,
					),
				).rejects.toMatchObject({ error: "invalid_token" });
				expect(
					await otherConsumerService.verifyAccessToken(
						`Bearer ${otherConsumer.tokens.access_token}`,
					),
				).toMatchObject({ instanceId: otherConsumer.identity.instanceId });
				await sql`
					UPDATE connection_consumers SET status = 'DISABLED'
					WHERE id = ${otherConsumerId}
				`;
				await expect(
					otherConsumerService.verifyAccessToken(
						`Bearer ${otherConsumer.tokens.access_token}`,
					),
				).rejects.toMatchObject({ error: "invalid_token" });
				await expect(
					otherConsumerService.refresh({
						clientId: otherConsumer.client.clientId,
						refreshToken: otherConsumer.tokens.refresh_token,
						resource: "https://connection.example/mcp",
					}),
				).rejects.toMatchObject({ error: "invalid_grant" });
				await expect(
					repository.rotateRefreshToken({
						accessTokenExpiresAt: new Date(Date.now() + 60_000),
						accessTokenHash: createHash("sha256")
							.update(randomUUID())
							.digest("hex"),
						clientId: otherConsumer.client.clientId,
						oldRefreshTokenHash: createHash("sha256")
							.update(otherConsumer.tokens.refresh_token)
							.digest("hex"),
						refreshTokenExpiresAt: new Date(Date.now() + 120_000),
						refreshTokenHash: createHash("sha256")
							.update(randomUUID())
							.digest("hex"),
						resource: "https://connection.example/mcp",
					}),
				).rejects.toMatchObject({ error: "invalid_grant" });

				const rotated = await service.refresh({
					clientId: first.client.clientId,
					refreshToken: first.tokens.refresh_token,
					resource: "https://connection.example/mcp",
				});
				await expect(
					service.refresh({
						clientId: first.client.clientId,
						refreshToken: first.tokens.refresh_token,
						resource: "https://connection.example/mcp",
					}),
				).rejects.toMatchObject({ error: "invalid_grant" });
				await expect(
					service.verifyAccessToken(`Bearer ${rotated.access_token}`),
				).rejects.toMatchObject({ error: "invalid_token" });
				await expect(
					service.revokeInstance(
						`Bearer ${second.tokens.access_token}`,
						other.identity.instanceId,
					),
				).rejects.toMatchObject({ error: "invalid_token" });
				expect(
					await service.verifyAccessToken(
						`Bearer ${other.tokens.access_token}`,
					),
				).toMatchObject({ principalId: other.identity.principalId });

				await service.revokeInstance(
					`Bearer ${second.tokens.access_token}`,
					second.identity.instanceId,
				);
				await expect(
					service.verifyAccessToken(`Bearer ${second.tokens.access_token}`),
				).rejects.toMatchObject({ error: "invalid_token" });
				const audit = await sql<
					{
						detail: { consumerId?: string; consumerInstanceId?: string };
						event: string;
					}[]
				>`
						SELECT event, detail FROM connection_audit_records
						WHERE principal_id = ${second.identity.principalId}
							AND event IN ('CONNECTION_LOGIN_APPROVED', 'CONSUMER_INSTANCE_REVOKED')
					`;
				expect(audit.length).toBeGreaterThan(0);
				for (const record of audit) {
					expect(record.detail.consumerId).toBeTruthy();
					expect(record.detail.consumerInstanceId).toBeTruthy();
				}

				const recoveryClient = await service.registerClient({
					clientName: `recovery-${randomUUID()}`,
					redirectUris: ["http://127.0.0.1/callback"],
				});
				const recoveryPending = await service.beginAuthorization({
					clientId: recoveryClient.clientId,
					codeChallenge: challenge,
					codeChallengeMethod: "S256",
					redirectUri: "http://127.0.0.1/callback",
					resource: "https://connection.example/mcp",
					responseType: "code",
					scope: "mcp",
					state: randomUUID(),
				});
				const recoveryApproved = await service.approveAuthorization({
					password: "integration-password",
					requestId: recoveryPending.requestId,
					username: stableSubject,
				});
				await sql`
					UPDATE connection_recovery_control
					SET generation = ((generation::bigint + 1)::text), updated_at = now()
				`;
				await expect(
					service.exchangeAuthorizationCode({
						clientId: recoveryClient.clientId,
						code: recoveryApproved.code,
						codeVerifier: verifier,
						redirectUri: "http://127.0.0.1/callback",
						resource: "https://connection.example/mcp",
					}),
				).rejects.toMatchObject({ error: "invalid_grant" });
			} finally {
				await sql.end();
				await repository.close();
			}
		},
		30_000,
	);

	integrationTest(
		"cascades opaque Principal remaps across the complete subject graph",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const sql = postgres(databaseUrl, { max: 1 });
			const suffix = randomUUID();
			const oldPrincipalId = `principal-${createHash("sha256")
				.update(suffix)
				.digest("hex")}`;
			const ids = {
				action: `cascade-action-${suffix}`,
				account: `cascade-account-${suffix}`,
				browser: `cascade-browser-${suffix}`,
				call: `cascade-call-${suffix}`,
				client: `cascade-client-${suffix}`,
				consumer: `cascade-consumer-${suffix}`,
				credential: `cascade-credential-${suffix}`,
				device: `cascade-device-${suffix}`,
				grant: `cascade-grant-${suffix}`,
				issuer: `urn:test:cascade:${suffix}`,
				pat: `cascade-pat-${suffix}`,
				provider: `cascade-provider-${suffix}`,
				release: `cascade-release-${suffix}`,
				request: createHash("sha256").update(`request-${suffix}`).digest("hex"),
				root: `cascade-root-${suffix}`,
				session: `cascade-session-${suffix}`,
				state: createHash("sha256").update(`state-${suffix}`).digest("hex"),
				token: `cascade-token-${suffix}`,
				transaction: createHash("sha256")
					.update(`transaction-${suffix}`)
					.digest("hex"),
			};
			const cascadeConstraints = [
				"connection_accounts_owner_principal_fkey",
				"connection_audit_records_principal_id_fkey",
				"connection_authorization_roots_principal_id_fkey",
				"connection_browser_sessions_identity_fkey",
				"connection_browser_sessions_principal_id_fkey",
				"connection_calls_principal_id_fkey",
				"connection_consumer_instances_principal_id_fkey",
				"connection_grants_direct_root_subject_fkey",
				"connection_grants_principal_id_fkey",
				"connection_oauth_authorizations_instance_subject_fkey",
				"connection_oauth_authorizations_principal_id_fkey",
				"connection_oauth_sessions_instance_subject_fkey",
				"connection_oauth_sessions_principal_id_fkey",
				"connection_oauth_transactions_principal_id_fkey",
				"connection_personal_access_tokens_instance_subject_fkey",
				"connection_personal_access_tokens_principal_id_fkey",
				"connection_principal_identities_principal_id_fkey",
				"connection_principal_roles_granted_by_fkey",
				"connection_principal_roles_principal_id_fkey",
				"connection_principal_roles_revoked_by_fkey",
				"connection_shared_scope_principals_granted_by_fkey",
				"connection_shared_scope_principals_principal_id_fkey",
				"connection_shared_scope_principals_revoked_by_fkey",
				"connection_shared_scopes_created_by_fkey",
			];

			try {
				await sql.begin(async (transaction) => {
					await transaction`
						INSERT INTO connection_principals (id, display_name)
						VALUES (${oldPrincipalId}, 'Cascade Review')
					`;
					await transaction`
						INSERT INTO connection_principal_identities (
							identity_issuer, identity_subject_hash, principal_id,
							identity_reference, status, verified_at
						)
						VALUES (
							${ids.issuer},
							${createHash("sha256").update(`identity-${suffix}`).digest("hex")},
							${oldPrincipalId}, ${`identity-${suffix}`}, 'ACTIVE', now()
						)
					`;
					await transaction`
						INSERT INTO connection_consumers (id, display_name, status)
						VALUES (${ids.consumer}, 'Cascade Review', 'ACTIVE')
					`;
					await transaction`
						INSERT INTO connection_consumer_instances (
							id, consumer_id, kind, auth_subject, status, principal_id
						)
						VALUES
							(${ids.device}, ${ids.consumer}, 'DEVICE', ${ids.device}, 'ACTIVE', ${oldPrincipalId}),
							(${ids.token}, ${ids.consumer}, 'TOKEN', ${ids.token}, 'ACTIVE', ${oldPrincipalId})
					`;
					await transaction`
						INSERT INTO connection_provider_releases (
							id, provider, source_commit, status
						)
						VALUES (${ids.release}, ${ids.provider}, ${suffix}, 'PUBLISHED')
					`;
					await transaction`
						INSERT INTO connection_action_versions (
							id, provider_release_id, name, description, effect, input_schema, status
						)
						VALUES (
							${ids.action}, ${ids.release}, 'cascade', 'cascade', 'READ',
							${transaction.json({})}, 'PUBLISHED'
						)
					`;
					await transaction`
						INSERT INTO connection_accounts (
							id, owner_type, owner_principal_id, shared_scope_id,
							provider_release_id, external_account, display_name, status,
							provider_id
						)
						VALUES (
							${ids.account}, 'PERSONAL', ${oldPrincipalId}, NULL,
							${ids.release}, ${`external-${suffix}`}, 'Cascade Review',
							'ACTIVE', ${ids.provider}
						)
					`;
					await transaction`
						INSERT INTO connection_credential_versions (
							id, connection_id, ciphertext, nonce, tag, status
						)
						VALUES (${ids.credential}, ${ids.account}, 'cipher', 'nonce', 'tag', 'ACTIVE')
					`;
					await transaction`
						INSERT INTO connection_authorization_roots (
							id, principal_id, consumer_id, current_grant_id,
							status, actor_key, provider_id
						)
						VALUES (
							${ids.root}, ${oldPrincipalId}, ${ids.consumer}, NULL,
							'ACTIVE', '', ${ids.provider}
						)
					`;
					await transaction`
						INSERT INTO connection_grants (
							id, principal_id, consumer_id, connection_id,
							status, root_id, actor_key, provider_id
						)
						VALUES (
							${ids.grant}, ${oldPrincipalId}, ${ids.consumer}, ${ids.account},
							'ACTIVE', ${ids.root}, '', ${ids.provider}
						)
					`;
					await transaction`
						INSERT INTO connection_calls (
							id, principal_id, consumer_id, instance_id, grant_id, connection_id,
							credential_version_id, action_version_id, request_hash, status
						)
						VALUES (
							${ids.call}, ${oldPrincipalId}, ${ids.consumer}, ${ids.device},
							${ids.grant}, ${ids.account}, ${ids.credential}, ${ids.action},
							${ids.request}, 'AUTHORIZED'
						)
					`;
					await transaction`
						INSERT INTO connection_audit_records (principal_id, call_id, event)
						VALUES (${oldPrincipalId}, ${ids.call}, 'CASCADE_REVIEW')
					`;
					await transaction`
						INSERT INTO connection_oauth_transactions (
							state_hash, principal_id, verifier_ciphertext, verifier_nonce,
							verifier_tag, redirect_uri, expires_at
						)
						VALUES (
							${ids.transaction}, ${oldPrincipalId}, 'cipher', 'nonce', 'tag',
							'http://127.0.0.1/callback', now() + interval '1 hour'
						)
					`;
					await transaction`
						INSERT INTO connection_oauth_clients (
							client_id, client_name, consumer_id, instance_id, redirect_uris, status
						)
						VALUES (
							${ids.client}, 'Cascade Review', ${ids.consumer}, ${ids.device},
							${transaction.json(["http://127.0.0.1/callback"])}, 'ACTIVE'
						)
					`;
					await transaction`
						INSERT INTO connection_oauth_authorizations (
							request_id_hash, client_id, consumer_id, instance_id, principal_id,
							code_challenge, redirect_uri, resource, scope, state,
							expires_at, recovery_generation
						)
						SELECT
							${ids.request}, ${ids.client}, ${ids.consumer}, ${ids.device},
							${oldPrincipalId}, 'challenge', 'http://127.0.0.1/callback',
							'https://cascade.example/mcp', 'mcp', ${ids.state},
							now() + interval '1 hour', generation
						FROM connection_recovery_control
					`;
					await transaction`
						INSERT INTO connection_oauth_sessions (
							id, family_id, client_id, consumer_id, instance_id, principal_id,
							resource, scope, recovery_generation, status
						)
						SELECT
							${ids.session}, ${`family-${suffix}`}, ${ids.client}, ${ids.consumer},
							${ids.device}, ${oldPrincipalId}, 'https://cascade.example/mcp',
							'mcp', generation, 'ACTIVE'
						FROM connection_recovery_control
					`;
					await transaction`
						INSERT INTO connection_personal_access_tokens (
							id, token_hash, principal_id, consumer_id, instance_id,
							name, recovery_generation, expires_at
						)
						SELECT
							${ids.pat}, ${createHash("sha256").update(`pat-${suffix}`).digest("hex")},
							${oldPrincipalId}, ${ids.consumer}, ${ids.token}, 'Cascade Review',
							generation, now() + interval '1 hour'
						FROM connection_recovery_control
					`;
					await transaction`
						INSERT INTO connection_browser_sessions (
							id, session_hash, principal_id, identity_issuer,
							recovery_generation, expires_at
						)
						SELECT
							${ids.browser},
							${createHash("sha256").update(`browser-${suffix}`).digest("hex")},
							${oldPrincipalId}, ${ids.issuer}, generation,
							now() + interval '1 hour'
						FROM connection_recovery_control
					`;

					const constraints = await transaction<
						{ constraint_name: string; update_rule: string }[]
					>`
						SELECT constraint_name, update_rule
						FROM information_schema.referential_constraints
						WHERE constraint_schema = current_schema()
					`;
					const updateRules = new Map(
						constraints.map((constraint) => [
							constraint.constraint_name,
							constraint.update_rule,
						]),
					);
					for (const constraint of cascadeConstraints) {
						expect(updateRules.get(constraint)).toBe("CASCADE");
					}

					const backfill = await readFile(
						resolve(
							import.meta.dirname,
							"../../../migrations/connection/0012_legacy_principal_id_backfill.sql",
						),
						"utf8",
					);
					await transaction.unsafe(backfill);
					await transaction`SET CONSTRAINTS ALL IMMEDIATE`;
					const references = await transaction<
						{ principal_id: string; source: string }[]
					>`
						SELECT 'accounts' AS source, owner_principal_id AS principal_id FROM connection_accounts WHERE id = ${ids.account}
						UNION ALL SELECT 'audit_records', principal_id FROM connection_audit_records WHERE call_id = ${ids.call}
						UNION ALL SELECT 'authorization_roots', principal_id FROM connection_authorization_roots WHERE id = ${ids.root}
						UNION ALL SELECT 'browser_sessions', principal_id FROM connection_browser_sessions WHERE id = ${ids.browser}
						UNION ALL SELECT 'calls', principal_id FROM connection_calls WHERE id = ${ids.call}
						UNION ALL SELECT 'consumer_instances', principal_id FROM connection_consumer_instances WHERE id = ${ids.device}
						UNION ALL SELECT 'grants', principal_id FROM connection_grants WHERE id = ${ids.grant}
						UNION ALL SELECT 'oauth_authorizations', principal_id FROM connection_oauth_authorizations WHERE request_id_hash = ${ids.request}
						UNION ALL SELECT 'oauth_sessions', principal_id FROM connection_oauth_sessions WHERE id = ${ids.session}
						UNION ALL SELECT 'oauth_transactions', principal_id FROM connection_oauth_transactions WHERE state_hash = ${ids.transaction}
						UNION ALL SELECT 'personal_access_tokens', principal_id FROM connection_personal_access_tokens WHERE id = ${ids.pat}
						UNION ALL SELECT 'principal_identities', principal_id FROM connection_principal_identities WHERE identity_issuer = ${ids.issuer}
					`;
					expect(references).toHaveLength(12);
					const newPrincipalId = references[0]?.principal_id;
					expect(newPrincipalId).toMatch(
						/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
					);
					for (const reference of references) {
						expect(reference.principal_id).toBe(newPrincipalId);
					}
				});
			} finally {
				await sql.end();
			}
		},
		30_000,
	);
});
