import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	ConnectionApplicationService,
	ConnectionOAuthService,
	type ConnectionRepository,
} from "@agent-infra/connection-core";
import { githubConnectionCatalog } from "@agent-infra/openconnector-adapter";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionOAuthRepository } from "./oauth-repository";
import { PostgresConnectionRepository } from "./repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl) {
	throw new Error("CONNECTION_TEST_DATABASE_URL is required in CI");
}
const integrationTest = databaseUrl ? it : it.skip;

async function authorizeCurrentConsumer(
	authority: Pick<
		ConnectionRepository,
		| "confirmCurrentConsumerAuthorization"
		| "createCurrentConsumerAuthorizationPreview"
	>,
	input: { connectionId: string; consumerId: string; principalId: string },
) {
	const preview =
		await authority.createCurrentConsumerAuthorizationPreview(input);
	return authority.confirmCurrentConsumerAuthorization({
		confirmationToken: preview.confirmationToken,
		idempotencyKey: randomUUID(),
		previewId: preview.previewId,
		principalId: input.principalId,
	});
}

describe("PostgreSQL Connection business authority", () => {
	integrationTest(
		"bootstraps one audited Connection administrator without promoting ordinary Principals",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const repository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 31),
			);
			const sql = postgres(databaseUrl, { max: 1 });
			const suffix = randomUUID();
			const adminPrincipalId = `principal-admin-${suffix}`;
			const disabledAdminPrincipalId = `principal-disabled-admin-${suffix}`;
			const userPrincipalId = `principal-user-${suffix}`;
			const identityIssuer = "urn:test:company-ldap";
			const identitySubjectHash = `v2:${"a".repeat(64)}${suffix}`;

			try {
				await sql`
					INSERT INTO connection_principals (id, display_name, email)
					VALUES
						(${adminPrincipalId}, 'Connection Admin', 'admin@example.invalid'),
						(${userPrincipalId}, 'Connection User', 'user@example.invalid')
				`;
				await sql`
					INSERT INTO connection_principal_identities (
						identity_issuer, identity_subject_hash, principal_id,
						identity_reference, status, verified_at
					)
					VALUES (
						${identityIssuer}, ${identitySubjectHash}, ${adminPrincipalId},
						'protected-identity-reference', 'ACTIVE', now()
					)
				`;

				expect(
					await repository.isConnectionAdministrator(adminPrincipalId),
				).toBe(false);
				expect(
					await repository.isConnectionAdministrator(userPrincipalId),
				).toBe(false);

				await repository.bootstrapConnectionAdministrator({
					identityIssuer,
					identitySubjectHash,
				});
				await repository.bootstrapConnectionAdministrator({
					identityIssuer,
					identitySubjectHash,
				});
				await sql`
					INSERT INTO connection_principals (
						id, display_name, email, status
					)
					VALUES (
						${disabledAdminPrincipalId}, 'Disabled administrator',
						'disabled-admin@example.invalid', 'DISABLED'
					)
				`;
				await sql`
					INSERT INTO connection_principal_roles (
						principal_id, role, status, grant_source
					)
					VALUES (
						${disabledAdminPrincipalId}, 'CONNECTION_ADMIN', 'ACTIVE', 'BOOTSTRAP'
					)
				`;

				expect(
					await repository.isConnectionAdministrator(adminPrincipalId),
				).toBe(true);
				expect(
					await repository.listConnectionAdministrators(adminPrincipalId),
				).toEqual([
					{
						displayName: "Connection Admin",
						email: "admin@example.invalid",
						principalId: adminPrincipalId,
					},
				]);
				expect(
					await repository.listConnectionAdministratorCandidates(
						adminPrincipalId,
					),
				).toEqual(
					expect.arrayContaining([
						{
							displayName: "Connection Admin",
							email: "admin@example.invalid",
							isAdministrator: true,
							principalId: adminPrincipalId,
						},
						{
							displayName: "Connection User",
							email: "user@example.invalid",
							isAdministrator: false,
							principalId: userPrincipalId,
						},
					]),
				);
				await expect(
					repository.listConnectionAdministrators(userPrincipalId),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				expect(
					await repository.authorizeConnectionAdministration(userPrincipalId),
				).toBe(false);

				await repository.grantConnectionAdministrator({
					actorPrincipalId: adminPrincipalId,
					targetPrincipalId: userPrincipalId,
				});
				expect(
					await repository.authorizeConnectionAdministration(adminPrincipalId),
				).toBe(true);
				expect(
					await repository.listConnectionAdministrators(userPrincipalId),
				).toEqual([
					{
						displayName: "Connection Admin",
						email: "admin@example.invalid",
						principalId: adminPrincipalId,
					},
					{
						displayName: "Connection User",
						email: "user@example.invalid",
						principalId: userPrincipalId,
					},
				]);
				await repository.revokeConnectionAdministrator({
					actorPrincipalId: userPrincipalId,
					targetPrincipalId: adminPrincipalId,
				});
				expect(
					await repository.isConnectionAdministrator(adminPrincipalId),
				).toBe(false);
				await expect(
					repository.grantConnectionAdministrator({
						actorPrincipalId: adminPrincipalId,
						targetPrincipalId: userPrincipalId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(
					repository.revokeConnectionAdministrator({
						actorPrincipalId: userPrincipalId,
						targetPrincipalId: userPrincipalId,
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				const [auditCount] = await sql<{ count: string }[]>`
					SELECT count(*)::text AS count FROM connection_audit_records
					WHERE principal_id = ${adminPrincipalId}
						AND event = 'CONNECTION_ADMIN_BOOTSTRAPPED'
				`;
				expect(auditCount?.count).toBe("1");
				const [roleAuditCount] = await sql<{ count: string }[]>`
					SELECT count(*)::text AS count FROM connection_audit_records
					WHERE principal_id IN (${adminPrincipalId}, ${userPrincipalId})
						AND event IN (
							'CONNECTION_ADMIN_GRANTED',
							'CONNECTION_ADMIN_REVOKED'
						)
				`;
				expect(roleAuditCount?.count).toBe("2");
				const [denialAuditCount] = await sql<{ count: string }[]>`
					SELECT count(*)::text AS count FROM connection_audit_records
					WHERE principal_id = ${userPrincipalId}
						AND event = 'CONNECTION_ADMIN_DENIED'
				`;
				expect(denialAuditCount?.count).toBe("2");
				const [staleAdministratorDenial] = await sql<{ count: string }[]>`
					SELECT count(*)::text AS count FROM connection_audit_records
					WHERE principal_id = ${adminPrincipalId}
						AND event = 'CONNECTION_ADMIN_DENIED'
				`;
				expect(staleAdministratorDenial?.count).toBe("1");
				const managementQueryAudits = await sql<{ event: string }[]>`
					SELECT event FROM connection_audit_records
					WHERE principal_id IN (${adminPrincipalId}, ${userPrincipalId})
						AND event IN (
							'CONNECTION_ADMINISTRATORS_QUERIED',
							'CONNECTION_ADMIN_CANDIDATES_QUERIED'
						)
				`;
				expect(
					new Set(managementQueryAudits.map(({ event }) => event)),
				).toEqual(
					new Set([
						"CONNECTION_ADMINISTRATORS_QUERIED",
						"CONNECTION_ADMIN_CANDIDATES_QUERIED",
					]),
				);
			} finally {
				await sql.end();
				await repository.close();
			}
		},
		30_000,
	);

	integrationTest(
		"keeps Shared GitHub eligibility separate from administration and revalidates it",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const repository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 31),
			);
			const sql = postgres(databaseUrl, { max: 1 });
			const suffix = randomUUID();
			const adminPrincipalId = `shared-admin-${suffix}`;
			const eligiblePrincipalA = `shared-user-a-${suffix}`;
			const eligiblePrincipalB = `shared-user-b-${suffix}`;
			const ineligiblePrincipal = `shared-user-c-${suffix}`;
			const consumerId = `shared-consumer-${suffix}`;
			const actionId = `github.shared_read_${suffix}@v1`;
			const catalog = {
				authProfile: { type: "test" },
				actions: [
					{
						description: "Read through a Shared GitHub Connection",
						effect: "READ" as const,
						id: actionId,
						inputSchema: { required: [] },
						name: `github.shared_read_${suffix}`,
						requiredScopes: ["repo"],
					},
				],
				deploymentProfile: { deployment: "test" },
				executorDigest: `sha256:${"3".repeat(64)}`,
				provider: "github",
				providerReleaseId: `github-shared-${suffix}`,
				sourceCommit: "3".repeat(40),
			};

			try {
				await sql`
					INSERT INTO connection_principals (id, display_name, email)
					VALUES
						(${adminPrincipalId}, 'Shared admin', 'shared-admin@example.invalid'),
						(${eligiblePrincipalA}, 'Shared user A', 'shared-a@example.invalid'),
						(${eligiblePrincipalB}, 'Shared user B', 'shared-b@example.invalid'),
						(${ineligiblePrincipal}, 'Shared user C', 'shared-c@example.invalid')
				`;
				await sql`
					INSERT INTO connection_principal_roles (
						principal_id, role, status, grant_source
					)
					VALUES (
						${adminPrincipalId}, 'CONNECTION_ADMIN', 'ACTIVE', 'BOOTSTRAP'
					)
				`;
				await repository.publishGithubCatalog(catalog);
				await repository.publishConsumerDeclaration({
					actionVersionIds: [actionId],
					consumer: { id: consumerId, name: "Shared test consumer" },
					providerReleaseId: catalog.providerReleaseId,
				});
				for (const principalId of [
					adminPrincipalId,
					eligiblePrincipalA,
					eligiblePrincipalB,
					ineligiblePrincipal,
				]) {
					await sql`
						INSERT INTO connection_consumer_instances (
							id, consumer_id, kind, auth_subject, status, principal_id
						)
						VALUES (
							${`instance-${principalId}`}, ${consumerId}, 'DEVICE',
							${`subject-${principalId}`}, 'ACTIVE', ${principalId}
						)
					`;
				}

				const scope = await repository.createSharedScope({
					actorPrincipalId: adminPrincipalId,
					displayName: "Agora shared GitHub",
				});
				for (const targetPrincipalId of [
					eligiblePrincipalA,
					eligiblePrincipalB,
				]) {
					await repository.grantSharedScopePrincipal({
						actorPrincipalId: adminPrincipalId,
						sharedScopeId: scope.sharedScopeId,
						targetPrincipalId,
					});
				}
				const personalConnection = await repository.storeGithubOAuthCredential({
					accessToken: `personal-provider-secret-${suffix}`,
					displayName: "Personal GitHub",
					externalAccount: `personal-github-${suffix}`,
					grantedScopes: ["repo"],
					principalId: adminPrincipalId,
				});
				await expect(
					sql`
						UPDATE connection_accounts
						SET owner_type = 'SHARED', owner_principal_id = NULL,
							shared_scope_id = ${scope.sharedScopeId}
						WHERE id = ${personalConnection.connectionId}
					`,
				).rejects.toMatchObject({ code: "23514" });
				await expect(
					sql`
						UPDATE connection_accounts
						SET owner_principal_id = ${eligiblePrincipalA}
						WHERE id = ${personalConnection.connectionId}
					`,
				).rejects.toMatchObject({ code: "23514" });
				await expect(
					repository.createOAuthTransaction({
						codeVerifier: `ineligible-verifier-${suffix}`,
						principalId: eligiblePrincipalA,
						redirectUri: "https://connection.example/oauth/callback",
						sharedScopeId: scope.sharedScopeId,
						state: `ineligible-state-${suffix}`,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const sharedOAuthState = `shared-state-${suffix}`;
				await repository.createOAuthTransaction({
					codeVerifier: `shared-verifier-${suffix}`,
					principalId: adminPrincipalId,
					redirectUri: "https://connection.example/oauth/callback",
					sharedScopeId: scope.sharedScopeId,
					state: sharedOAuthState,
				});
				expect(
					await repository.consumeOAuthTransaction(sharedOAuthState),
				).toEqual({
					codeVerifier: `shared-verifier-${suffix}`,
					principalId: adminPrincipalId,
					redirectUri: "https://connection.example/oauth/callback",
					sharedScopeId: scope.sharedScopeId,
				});
				const connection = await repository.storeSharedGithubOAuthCredential({
					accessToken: `shared-provider-secret-${suffix}`,
					actorPrincipalId: adminPrincipalId,
					displayName: "Agora GitHub",
					externalAccount: `agora-github-${suffix}`,
					grantedScopes: ["repo"],
					sharedScopeId: scope.sharedScopeId,
				});
				await expect(
					sql`
						UPDATE connection_accounts
						SET owner_type = 'PERSONAL',
							owner_principal_id = ${adminPrincipalId},
							shared_scope_id = NULL
						WHERE id = ${connection.connectionId}
					`,
				).rejects.toMatchObject({ code: "23514" });

				expect(
					(await repository.getOverview(adminPrincipalId)).connections.filter(
						(stored) => stored.ownerType === "SHARED",
					),
				).toEqual([]);
				expect(
					(await repository.getOverview(ineligiblePrincipal)).connections,
				).toEqual([]);
				for (const principalId of [eligiblePrincipalA, eligiblePrincipalB]) {
					expect(
						(await repository.getOverview(principalId)).connections,
					).toMatchObject([
						{
							id: connection.connectionId,
							ownerType: "SHARED",
						},
					]);
				}
				await expect(
					repository.createCurrentConsumerAuthorizationPreview({
						connectionId: connection.connectionId,
						consumerId,
						principalId: ineligiblePrincipal,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });

				await authorizeCurrentConsumer(repository, {
					connectionId: connection.connectionId,
					consumerId,
					principalId: eligiblePrincipalA,
				});
				const eligibleIdentityA = {
					consumerId,
					instanceId: `instance-${eligiblePrincipalA}`,
					principalId: eligiblePrincipalA,
				};
				expect(
					(
						await repository.listAuthorizedActions(
							await repository.resolveDirectIdentity(eligibleIdentityA),
						)
					).map((action) => action.id),
				).toEqual([actionId]);

				await repository.revokeSharedScopePrincipal({
					actorPrincipalId: adminPrincipalId,
					sharedScopeId: scope.sharedScopeId,
					targetPrincipalId: eligiblePrincipalA,
				});
				const [terminated] = await sql<
					{ current_grant_id: string | null; status: string }[]
				>`
					SELECT root.current_grant_id, stored_grant.status
					FROM connection_grants stored_grant
					JOIN connection_authorization_roots root ON root.id = stored_grant.root_id
					WHERE stored_grant.principal_id = ${eligiblePrincipalA}
						AND stored_grant.connection_id = ${connection.connectionId}
				`;
				expect(terminated).toEqual({
					current_grant_id: null,
					status: "TERMINATED",
				});
				await expect(
					repository.resolveDirectIdentity(eligibleIdentityA),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await authorizeCurrentConsumer(repository, {
					connectionId: connection.connectionId,
					consumerId,
					principalId: eligiblePrincipalB,
				});
				const eligibleIdentityB = {
					consumerId,
					instanceId: `instance-${eligiblePrincipalB}`,
					principalId: eligiblePrincipalB,
				};
				const beforeReconnect =
					await repository.resolveDirectIdentity(eligibleIdentityB);
				await expect(
					repository.renameSharedScope({
						actorPrincipalId: eligiblePrincipalB,
						displayName: "Unauthorized rename",
						sharedScopeId: scope.sharedScopeId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await repository.renameSharedScope({
					actorPrincipalId: adminPrincipalId,
					displayName: "Release Engineering",
					sharedScopeId: scope.sharedScopeId,
				});
				expect(
					(
						await repository.sharedGithubAdministration(adminPrincipalId)
					).scopes.find((entry) => entry.sharedScopeId === scope.sharedScopeId),
				).toMatchObject({ displayName: "Release Engineering" });
				expect(
					(await repository.resolveDirectIdentity(eligibleIdentityB)).grantId,
				).toBe(beforeReconnect.grantId);
				const [renameAudit] = await sql<{ count: string }[]>`
					SELECT count(*)::text AS count FROM connection_audit_records
					WHERE principal_id = ${adminPrincipalId}
						AND event = 'SHARED_SCOPE_RENAMED'
				`;
				expect(renameAudit?.count).toBe("1");
				const [managementQueryAudit] = await sql<{ count: string }[]>`
					SELECT count(*)::text AS count FROM connection_audit_records
					WHERE principal_id = ${adminPrincipalId}
						AND event = 'SHARED_GITHUB_ADMINISTRATION_QUERIED'
				`;
				expect(managementQueryAudit?.count).toBe("1");
				await repository.storeSharedGithubOAuthCredential({
					accessToken: `shared-provider-secret-reconnected-${suffix}`,
					actorPrincipalId: adminPrincipalId,
					displayName: "Agora GitHub",
					externalAccount: `agora-github-${suffix}`,
					grantedScopes: ["repo"],
					sharedScopeId: scope.sharedScopeId,
				});
				const afterReconnect =
					await repository.resolveDirectIdentity(eligibleIdentityB);
				expect(afterReconnect.grantId).not.toBe(beforeReconnect.grantId);
				const [replacement] = await sql<
					{ consent_reused: boolean; old_status: string }[]
				>`
					SELECT old_grant.status AS old_status,
						old_grant.consent_id = new_grant.consent_id AS consent_reused
					FROM connection_grants old_grant
					JOIN connection_grants new_grant ON new_grant.id = ${afterReconnect.grantId}
					WHERE old_grant.id = ${beforeReconnect.grantId}
				`;
				expect(replacement).toEqual({
					consent_reused: true,
					old_status: "REPLACED",
				});
				await expect(
					repository.disconnectSharedConnection({
						actorPrincipalId: eligiblePrincipalB,
						connectionId: connection.connectionId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await repository.disconnectSharedConnection({
					actorPrincipalId: adminPrincipalId,
					connectionId: connection.connectionId,
				});
				await expect(
					repository.resolveDirectIdentity(eligibleIdentityB),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const [disconnected] = await sql<
					{
						connection_status: string;
						credential_status: string;
						grant_status: string;
					}[]
				>`
					SELECT account.status AS connection_status,
						credential.status AS credential_status,
						stored_grant.status AS grant_status
					FROM connection_accounts account
					JOIN connection_credential_versions credential
						ON credential.connection_id = account.id
					JOIN connection_grants stored_grant
						ON stored_grant.id = ${afterReconnect.grantId}
					WHERE account.id = ${connection.connectionId}
						AND credential.id = ${afterReconnect.credentialVersionId}
				`;
				expect(disconnected).toEqual({
					connection_status: "DISCONNECTED",
					credential_status: "REVOKED",
					grant_status: "PAUSED_CONNECTION",
				});
			} finally {
				await sql.end();
				await repository.close();
			}
		},
		30_000,
	);

	integrationTest(
		"keeps a Connection pinned to its exact release when a newer catalog is published",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const repository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 31),
			);
			const sql = postgres(databaseUrl, { max: 1 });
			const suffix = randomUUID();
			const principalId = `principal-${suffix}`;
			const consumerId = `consumer-${suffix}`;
			const instanceId = `instance-${suffix}`;
			const v1ActionId = `github.catalog_v1_${suffix}@v1`;
			const undeclaredActionId = `github.undeclared_${suffix}@v1`;
			const v2ActionId = `github.catalog_v2_${suffix}@v1`;
			const externalAccount = `github-${suffix}`;
			const v1 = {
				authProfile: { type: "test" },
				actions: [
					{
						description: "Catalog V1 action",
						effect: "READ" as const,
						id: v1ActionId,
						inputSchema: { required: [] },
						name: `github.catalog_v1_${suffix}`,
						requiredScopes: ["repo"],
					},
					{
						description: "Undeclared catalog action",
						effect: "READ" as const,
						id: undeclaredActionId,
						inputSchema: { required: [] },
						name: `github.undeclared_${suffix}`,
						requiredScopes: ["repo"],
					},
				],
				deploymentProfile: { deployment: "test" },
				executorDigest: `sha256:${"1".repeat(64)}`,
				provider: "github",
				providerReleaseId: `github-release-v1-${suffix}`,
				sourceCommit: "1".repeat(40),
			};
			const v2 = {
				...v1,
				actions: [
					{
						description: "Catalog V2 action",
						effect: "READ" as const,
						id: v2ActionId,
						inputSchema: { required: [] },
						name: `github.catalog_v2_${suffix}`,
						requiredScopes: ["repo"],
					},
				],
				providerReleaseId: `github-release-v2-${suffix}`,
				sourceCommit: "2".repeat(40),
			};

			try {
				await sql`
					INSERT INTO connection_principals (id, display_name)
					VALUES (${principalId}, 'Catalog test principal')
				`;
				await sql`
					INSERT INTO connection_consumers (id, display_name, status)
					VALUES (${consumerId}, 'Catalog test consumer', 'ACTIVE')
				`;
				await sql`
					INSERT INTO connection_consumer_instances (
						id, consumer_id, kind, auth_subject, status, principal_id
					)
					VALUES (
						${instanceId}, ${consumerId}, 'DEVICE', ${`subject-${suffix}`},
						'ACTIVE', ${principalId}
					)
				`;
				await repository.publishGithubCatalog(v1);
				await repository.publishGithubCatalog(v1);
				await expect(
					repository.publishGithubCatalog({
						...v1,
						actions: v1.actions.map((action) => ({
							...action,
							requiredScopes: ["repo", "workflow"],
						})),
					}),
				).rejects.toThrow("Pinned ProviderRelease does not match the catalog");
				await repository.publishConsumerDeclaration({
					actionVersionIds: [v1ActionId],
					consumer: { id: consumerId, name: "Catalog test consumer" },
					providerReleaseId: v1.providerReleaseId,
				});
				const connection = await repository.storeGithubOAuthCredential({
					accessToken: `provider-secret-${suffix}`,
					displayName: "Catalog test GitHub",
					externalAccount,
					grantedScopes: ["repo"],
					principalId,
				});

				await repository.publishGithubCatalog(v2);
				const overview = await repository.getOverview(principalId);
				const pinnedConnection = overview.connections.find(
					(entry) => entry.id === connection.connectionId,
				);
				expect(overview.actions.map((action) => action.id)).toEqual([
					v2ActionId,
				]);
				expect(pinnedConnection).toMatchObject({
					actionVersionIds: [v1ActionId, undeclaredActionId].sort(),
					requiresReconnect: true,
				});
				await authorizeCurrentConsumer(repository, {
					connectionId: connection.connectionId,
					consumerId,
					principalId,
				});
				const directIdentity = { consumerId, instanceId, principalId };
				expect(
					(
						await repository.listAuthorizedActions(
							await repository.resolveDirectIdentity(directIdentity),
						)
					).map((action) => action.id),
				).toEqual([v1ActionId]);
				await expect(
					repository.verifyInvocation({
						...(await repository.resolveDirectIdentity(directIdentity)),
						action: `github.undeclared_${suffix}`,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });

				await repository.storeGithubOAuthCredential({
					accessToken: `replacement-provider-secret-${suffix}`,
					displayName: "Catalog test GitHub",
					externalAccount,
					grantedScopes: ["repo"],
					principalId,
				});
				await repository.publishConsumerDeclaration({
					actionVersionIds: [v2ActionId],
					consumer: { id: consumerId, name: "Catalog test consumer" },
					providerReleaseId: v2.providerReleaseId,
				});
				const reconnected = (
					await repository.getOverview(principalId)
				).connections.find((entry) => entry.id === connection.connectionId);
				expect(reconnected).toMatchObject({
					actionVersionIds: [v2ActionId],
					requiresReconnect: false,
				});
				await expect(
					repository.resolveDirectIdentity(directIdentity),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await authorizeCurrentConsumer(repository, {
					connectionId: connection.connectionId,
					consumerId,
					principalId,
				});
				expect(
					(
						await repository.listAuthorizedActions(
							await repository.resolveDirectIdentity(directIdentity),
						)
					).map((action) => action.id),
				).toEqual([v2ActionId]);

				const [release] = await sql<{ status: string }[]>`
					SELECT status FROM connection_provider_releases
					WHERE id = ${v1.providerReleaseId}
				`;
				expect(release?.status).toBe("PUBLISHED");
			} finally {
				await sql.end();
				await repository.close();
			}
		},
		30_000,
	);

	integrationTest(
		"previews and atomically switches the current GitHub Connection with idempotent confirmation",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const oauthRepository = new PostgresConnectionOAuthRepository(
				databaseUrl,
			);
			const repository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 31),
			);
			const expiringRepository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 31),
				{ authorizationPreviewTtlMs: 0 },
			);
			const sql = postgres(databaseUrl, { max: 1 });
			const suffix = randomUUID();
			const grantedScopes = [
				"delete_repo",
				"read:user",
				"repo",
				"user:email",
				"workflow",
			] as const;
			const oauth = new ConnectionOAuthService({
				consumer: { id: "consumer-codex", name: "Codex" },
				directory: {
					authenticate: async (username: string) => ({
						displayName: "Authorization Preview User",
						email: `${username}@example.invalid`,
						issuer: "urn:test:company-ldap",
						subject: username,
					}),
					isActive: async () => true,
				},
				identityEnvironment: `authorization-preview-${suffix}`,
				identityKey: Buffer.alloc(32, 29),
				repository: oauthRepository,
				resource: "https://connection.example/mcp",
			});
			const service = new ConnectionApplicationService(repository, {
				execute: async () => ({}),
			});
			const expiringService = new ConnectionApplicationService(
				expiringRepository,
				{ execute: async () => ({}) },
			);

			try {
				await repository.publishGithubCatalog(githubConnectionCatalog);
				const browser = await oauth.loginBrowserSession({
					password: "not-persisted",
					username: `authorization-preview-${suffix}`,
				});
				const pat = await oauth.issuePersonalAccessToken({
					name: "Authorization preview test",
					sessionToken: browser.sessionToken,
				});
				const identity = await oauth.verifyAccessToken(`Bearer ${pat.token}`);
				await repository.publishConsumerDeclaration({
					actionVersionIds: githubConnectionCatalog.actions.map(
						(action) => action.id,
					),
					consumer: {
						id: identity.consumerId,
						name: "Portable Connection PAT",
					},
					providerReleaseId: githubConnectionCatalog.providerReleaseId,
				});
				const accountA = await repository.storeGithubOAuthCredential({
					accessToken: `provider-a-${suffix}`,
					displayName: "GitHub A",
					externalAccount: `github-a-${suffix}`,
					grantedScopes,
					principalId: identity.principalId,
				});
				const accountB = await repository.storeGithubOAuthCredential({
					accessToken: `provider-b-${suffix}`,
					displayName: "GitHub B",
					externalAccount: `github-b-${suffix}`,
					grantedScopes,
					principalId: identity.principalId,
				});

				const initial = await service.createCurrentConsumerAuthorizationPreview(
					{
						connectionId: accountA.connectionId,
						consumerId: identity.consumerId,
						principalId: identity.principalId,
					},
				);
				await expect(
					service.listDirectConnectionsForIdentity(identity),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await service.confirmCurrentConsumerAuthorization({
					confirmationToken: initial.confirmationToken,
					idempotencyKey: `initial-${suffix}`,
					previewId: initial.previewId,
					principalId: identity.principalId,
				});
				const declarationStale =
					await service.createCurrentConsumerAuthorizationPreview({
						connectionId: accountB.connectionId,
						consumerId: identity.consumerId,
						principalId: identity.principalId,
					});
				await repository.publishConsumerDeclaration({
					actionVersionIds: [githubConnectionCatalog.actions[0]?.id ?? ""],
					consumer: {
						id: identity.consumerId,
						name: "Portable Connection PAT",
					},
					providerReleaseId: githubConnectionCatalog.providerReleaseId,
				});
				await expect(
					service.confirmCurrentConsumerAuthorization({
						confirmationToken: declarationStale.confirmationToken,
						idempotencyKey: `declaration-stale-${suffix}`,
						previewId: declarationStale.previewId,
						principalId: identity.principalId,
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				await repository.publishConsumerDeclaration({
					actionVersionIds: githubConnectionCatalog.actions.map(
						(action) => action.id,
					),
					consumer: {
						id: identity.consumerId,
						name: "Portable Connection PAT",
					},
					providerReleaseId: githubConnectionCatalog.providerReleaseId,
				});

				const stale = await service.createCurrentConsumerAuthorizationPreview({
					connectionId: accountB.connectionId,
					consumerId: identity.consumerId,
					principalId: identity.principalId,
				});
				expect(stale.currentConnection?.id).toBe(accountA.connectionId);
				expect(stale.targetConnection.id).toBe(accountB.connectionId);
				expect(stale.effectSummary).toEqual(["READ", "WRITE"]);
				expect(
					(await service.listDirectConnectionsForIdentity(identity)).map(
						(connection) => connection.id,
					),
				).toEqual([accountA.connectionId]);

				const current = await service.createCurrentConsumerAuthorizationPreview(
					{
						connectionId: accountB.connectionId,
						consumerId: identity.consumerId,
						principalId: identity.principalId,
					},
				);
				const confirmation = {
					confirmationToken: current.confirmationToken,
					idempotencyKey: `switch-${suffix}`,
					previewId: current.previewId,
					principalId: identity.principalId,
				};
				await expect(
					service.confirmCurrentConsumerAuthorization({
						...confirmation,
						confirmationToken: "wrong-opaque-token",
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const [switched, replayed] = await Promise.all([
					service.confirmCurrentConsumerAuthorization(confirmation),
					service.confirmCurrentConsumerAuthorization(confirmation),
				]);
				expect(replayed).toEqual(switched);
				expect(
					(await service.listDirectConnectionsForIdentity(identity)).map(
						(connection) => connection.id,
					),
				).toEqual([accountB.connectionId]);
				await expect(
					service.confirmCurrentConsumerAuthorization({
						confirmationToken: stale.confirmationToken,
						idempotencyKey: `stale-${suffix}`,
						previewId: stale.previewId,
						principalId: identity.principalId,
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });

				const expired =
					await expiringService.createCurrentConsumerAuthorizationPreview({
						connectionId: accountA.connectionId,
						consumerId: identity.consumerId,
						principalId: identity.principalId,
					});
				await expect(
					expiringService.confirmCurrentConsumerAuthorization({
						confirmationToken: expired.confirmationToken,
						idempotencyKey: `expired-${suffix}`,
						previewId: expired.previewId,
						principalId: identity.principalId,
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });

				await sql`
					CREATE OR REPLACE FUNCTION connection_test_delay_authorization_root_insert()
					RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN
						PERFORM pg_sleep(0.2);
						RETURN NEW;
					END;
					$$
				`;
				await sql`
					CREATE TRIGGER connection_test_delay_authorization_root_insert
					BEFORE INSERT ON connection_authorization_roots
					FOR EACH ROW EXECUTE FUNCTION connection_test_delay_authorization_root_insert()
				`;
				let previewReconnectResults: PromiseSettledResult<unknown>[];
				try {
					const preview = service.createCurrentConsumerAuthorizationPreview({
						connectionId: accountB.connectionId,
						consumerId: identity.consumerId,
						principalId: identity.principalId,
					});
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
					previewReconnectResults = await Promise.allSettled([
						preview,
						repository.storeGithubOAuthCredential({
							accessToken: `provider-b-reconnected-${suffix}`,
							displayName: "GitHub B",
							externalAccount: `github-b-${suffix}`,
							grantedScopes,
							principalId: identity.principalId,
						}),
					]);
				} finally {
					await sql`DROP TRIGGER connection_test_delay_authorization_root_insert ON connection_authorization_roots`;
					await sql`DROP FUNCTION connection_test_delay_authorization_root_insert()`;
				}
				for (const result of previewReconnectResults) {
					if (result.status === "rejected") throw result.reason;
				}
				expect(previewReconnectResults.map((result) => result.status)).toEqual([
					"fulfilled",
					"fulfilled",
				]);

				const confirmPreview =
					await service.createCurrentConsumerAuthorizationPreview({
						connectionId: accountB.connectionId,
						consumerId: identity.consumerId,
						principalId: identity.principalId,
					});
				await sql`
					CREATE OR REPLACE FUNCTION connection_test_delay_authorization_consent_insert()
					RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN
						PERFORM pg_sleep(0.2);
						RETURN NEW;
					END;
					$$
				`;
				await sql`
					CREATE TRIGGER connection_test_delay_authorization_consent_insert
					BEFORE INSERT ON connection_authorization_consents
					FOR EACH ROW EXECUTE FUNCTION connection_test_delay_authorization_consent_insert()
				`;
				let confirmReconnectResults: PromiseSettledResult<unknown>[];
				try {
					const confirm = service.confirmCurrentConsumerAuthorization({
						confirmationToken: confirmPreview.confirmationToken,
						idempotencyKey: `race-confirm-${suffix}`,
						previewId: confirmPreview.previewId,
						principalId: identity.principalId,
					});
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
					confirmReconnectResults = await Promise.allSettled([
						confirm,
						repository.storeGithubOAuthCredential({
							accessToken: `provider-b-confirm-reconnected-${suffix}`,
							displayName: "GitHub B",
							externalAccount: `github-b-${suffix}`,
							grantedScopes,
							principalId: identity.principalId,
						}),
					]);
				} finally {
					await sql`DROP TRIGGER connection_test_delay_authorization_consent_insert ON connection_authorization_consents`;
					await sql`DROP FUNCTION connection_test_delay_authorization_consent_insert()`;
				}
				for (const result of confirmReconnectResults) {
					if (result.status === "rejected") throw result.reason;
				}
				expect(confirmReconnectResults.map((result) => result.status)).toEqual([
					"fulfilled",
					"fulfilled",
				]);
			} finally {
				await sql.end();
				await expiringRepository.close();
				await repository.close();
				await oauthRepository.close();
			}
		},
		30_000,
	);

	integrationTest(
		"shares one encrypted GitHub Connection through an authorized PAT and fails closed",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const oauthRepository = new PostgresConnectionOAuthRepository(
				databaseUrl,
			);
			const repository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 31),
			);
			const sql = postgres(databaseUrl, { max: 1 });
			const oauth = new ConnectionOAuthService({
				consumer: { id: "consumer-codex", name: "Codex" },
				directory: {
					authenticate: async (username: string) => ({
						displayName: "Business Integration User",
						email: `${username}@example.invalid`,
						issuer: "urn:test:company-ldap",
						subject: username,
					}),
					isActive: async () => true,
				},
				identityEnvironment: "business-integration",
				identityKey: Buffer.alloc(32, 29),
				repository: oauthRepository,
				resource: "https://connection.example/mcp",
			});
			const providerToken = `provider-secret-${randomUUID()}`;
			const replacementProviderToken = `provider-secret-${randomUUID()}`;
			const externalAccount = `github-${randomUUID()}`;
			const grantedScopes = [
				"delete_repo",
				"read:user",
				"repo",
				"user:email",
				"workflow",
			] as const;
			let injectedCredential = "";
			const service = new ConnectionApplicationService(repository, {
				execute: async ({ credential }) => {
					injectedCredential = credential.accessToken;
					return { fullName: "AgoraIO-Extensions/agent-infra" };
				},
			});

			try {
				await repository.publishGithubCatalog(githubConnectionCatalog);
				const browser = await oauth.loginBrowserSession({
					password: "not-persisted",
					username: `business-${randomUUID()}`,
				});
				const pat = await oauth.issuePersonalAccessToken({
					name: "Codex integration",
					sessionToken: browser.sessionToken,
				});
				const identity = await oauth.verifyAccessToken(`Bearer ${pat.token}`);
				await repository.publishConsumerDeclaration({
					actionVersionIds: githubConnectionCatalog.actions.map(
						(action) => action.id,
					),
					consumer: {
						id: identity.consumerId,
						name: "Portable Connection PAT",
					},
					providerReleaseId: githubConnectionCatalog.providerReleaseId,
				});
				const connection = await repository.storeGithubOAuthCredential({
					accessToken: providerToken,
					displayName: "Business GitHub",
					externalAccount,
					grantedScopes,
					principalId: identity.principalId,
				});
				await authorizeCurrentConsumer(service, {
					connectionId: connection.connectionId,
					consumerId: identity.consumerId,
					principalId: identity.principalId,
				});

				expect(
					(await service.listDirectActionsForIdentity(identity)).map(
						(action) => action.id,
					),
				).toEqual(
					expect.arrayContaining([
						githubConnectionCatalog.actions.find(
							(action) => action.name === "github.get_repository",
						)?.id,
						githubConnectionCatalog.actions.find(
							(action) => action.name === "github.create_pull_request",
						)?.id,
					]),
				);
				const result = await service.invokeDirectForIdentity(
					identity,
					"github.get_repository",
					{ owner: "AgoraIO-Extensions", repo: "agent-infra" },
				);
				expect(result.status).toBe("SUCCEEDED");
				expect(result.result).toEqual({
					fullName: "AgoraIO-Extensions/agent-infra",
				});
				expect(injectedCredential).toBe(providerToken);
				const originalInvocation =
					await repository.resolveDirectIdentity(identity);
				await repository.storeGithubOAuthCredential({
					accessToken: replacementProviderToken,
					displayName: "Business GitHub",
					externalAccount,
					grantedScopes,
					principalId: identity.principalId,
				});
				const restoredInvocation =
					await repository.resolveDirectIdentity(identity);
				expect(restoredInvocation.grantId).not.toBe(originalInvocation.grantId);
				expect(restoredInvocation.credentialVersionId).not.toBe(
					originalInvocation.credentialVersionId,
				);
				await sql.begin(async (transaction) => {
					for (const terminalStatus of [
						"PAUSED_CONNECTION",
						"PAUSED_CREDENTIAL",
						"REPLACED",
						"REVOKED",
						"TERMINATED",
					] as const) {
						const rollback = new Error(`rollback-${terminalStatus}`);
						await expect(
							transaction.savepoint(async (savepoint) => {
								await savepoint`
									UPDATE connection_grants SET status = ${terminalStatus}
									WHERE id = ${restoredInvocation.grantId}
								`;
								await savepoint`
									UPDATE connection_grants SET status = ${terminalStatus}
									WHERE id = ${restoredInvocation.grantId}
								`;
								const [grant] = await savepoint<{ status: string }[]>`
									SELECT status FROM connection_grants
									WHERE id = ${restoredInvocation.grantId}
								`;
								expect(grant?.status).toBe(terminalStatus);
								throw rollback;
							}),
						).rejects.toBe(rollback);

						await expect(
							transaction.savepoint(async (savepoint) => {
								await savepoint`
									UPDATE connection_grants SET status = ${terminalStatus}
									WHERE id = ${restoredInvocation.grantId}
								`;
								await savepoint`
									UPDATE connection_grants SET status = 'ACTIVE'
										WHERE id = ${restoredInvocation.grantId}
									`;
							}),
						).rejects.toMatchObject({ code: "23514" });
					}
					for (const pausedStatus of [
						"PAUSED_CONNECTION",
						"PAUSED_CREDENTIAL",
					] as const) {
						const rollback = new Error(`rollback-${pausedStatus}-terminated`);
						await expect(
							transaction.savepoint(async (savepoint) => {
								await savepoint`
										UPDATE connection_grants SET status = ${pausedStatus}
										WHERE id = ${restoredInvocation.grantId}
									`;
								await savepoint`
										UPDATE connection_grants SET status = 'TERMINATED'
										WHERE id = ${restoredInvocation.grantId}
									`;
								const [grant] = await savepoint<{ status: string }[]>`
										SELECT status FROM connection_grants
										WHERE id = ${restoredInvocation.grantId}
									`;
								expect(grant?.status).toBe("TERMINATED");
								throw rollback;
							}),
						).rejects.toBe(rollback);
					}
				});
				const [replacement] = await sql<
					{
						consent_reused: boolean;
						old_status: string;
					}[]
				>`
					SELECT old_grant.status AS old_status,
						old_grant.consent_id = new_grant.consent_id AS consent_reused
					FROM connection_grants old_grant
					JOIN connection_grants new_grant ON new_grant.id = ${restoredInvocation.grantId}
					WHERE old_grant.id = ${originalInvocation.grantId}
				`;
				expect(replacement).toEqual({
					consent_reused: true,
					old_status: "REPLACED",
				});
				await service.invokeDirectForIdentity(
					identity,
					"github.get_repository",
					{ owner: "AgoraIO-Extensions", repo: "agent-infra" },
				);
				expect(injectedCredential).toBe(replacementProviderToken);

				const [rootBeforeProofChange] = await sql<
					{ fence: string; root_id: string }[]
				>`
						SELECT root.id AS root_id, root.fence::text
						FROM connection_grants stored_grant
						JOIN connection_authorization_roots root
							ON root.id = stored_grant.root_id
						WHERE stored_grant.id = ${restoredInvocation.grantId}
					`;
				if (!rootBeforeProofChange)
					throw new Error("missing authorization root");
				const reducedScopes = grantedScopes.filter(
					(scope) => scope !== "delete_repo",
				);
				await repository.storeGithubOAuthCredential({
					accessToken: `provider-secret-${randomUUID()}`,
					displayName: "Business GitHub",
					externalAccount,
					grantedScopes: reducedScopes,
					principalId: identity.principalId,
				});
				const [pausedGrant] = await sql<
					{
						current_grant_id: string | null;
						detail: unknown;
						event: string | null;
						fence: string;
						status: string;
					}[]
				>`
						SELECT stored_grant.status, root.current_grant_id,
							root.fence::text, audit.event, audit.detail
						FROM connection_grants stored_grant
						JOIN connection_authorization_roots root
							ON root.id = stored_grant.root_id
						LEFT JOIN LATERAL (
							SELECT event, detail FROM connection_audit_records
							WHERE principal_id = ${identity.principalId}
								AND event = 'GRANT_RECONFIRMATION_REQUIRED_AFTER_RECONNECT'
								AND detail->>'grantId' = ${restoredInvocation.grantId}
							ORDER BY id DESC LIMIT 1
						) audit ON true
						WHERE stored_grant.id = ${restoredInvocation.grantId}
					`;
				expect(pausedGrant).toMatchObject({
					current_grant_id: null,
					event: "GRANT_RECONFIRMATION_REQUIRED_AFTER_RECONNECT",
					status: "PAUSED_CREDENTIAL",
				});
				expect(pausedGrant?.detail).toMatchObject({
					connectionId: connection.connectionId,
					grantId: restoredInvocation.grantId,
					reason: "AUTHORIZATION_PROOF_CHANGED",
				});
				expect(BigInt(pausedGrant?.fence ?? "0")).toBe(
					BigInt(rootBeforeProofChange.fence) + 1n,
				);
				await expect(
					repository.resolveDirectIdentity(identity),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await repository.publishConsumerDeclaration({
					actionVersionIds: githubConnectionCatalog.actions
						.filter((action) => !action.requiredScopes.includes("delete_repo"))
						.map((action) => action.id),
					consumer: {
						id: identity.consumerId,
						name: "Portable Connection PAT",
					},
					providerReleaseId: githubConnectionCatalog.providerReleaseId,
				});
				await authorizeCurrentConsumer(service, {
					connectionId: connection.connectionId,
					consumerId: identity.consumerId,
					principalId: identity.principalId,
				});

				const [storedCredential] = await sql<
					{ ciphertext: string; detail: unknown }[]
				>`
					SELECT credential.ciphertext, audit.detail
					FROM connection_credential_versions credential
					JOIN connection_audit_records audit
						ON audit.principal_id = ${identity.principalId}
					WHERE credential.connection_id = ${connection.connectionId}
					ORDER BY audit.id DESC LIMIT 1
				`;
				expect(storedCredential?.ciphertext).not.toContain(providerToken);
				expect(JSON.stringify(storedCredential?.detail)).not.toContain(
					providerToken,
				);

				const invocation = await repository.resolveDirectIdentity(identity);
				const idempotencyKey = randomUUID();
				const claimInput = {
					action: "github.create_pull_request" as const,
					argsHash: randomUUID(),
					idempotencyKey,
					input: {
						base: "main",
						head: "test/concurrent-idempotency",
						repository: "AgoraIO-Extensions/agent-infra",
						title: "Concurrent idempotency",
					},
					invocation,
				};
				const concurrentClaims = await Promise.all([
					repository.createCall(claimInput),
					repository.createCall(claimInput),
				]);
				expect(concurrentClaims.filter((claim) => claim.created)).toHaveLength(
					1,
				);
				expect(
					new Set(concurrentClaims.map((claim) => claim.call.callId)),
				).toEqual(new Set([concurrentClaims[0]?.call.callId]));
				if (concurrentClaims[0]) {
					await repository.setCallResult({
						callId: concurrentClaims[0].call.callId,
						status: "FAILED",
					});
				}

				const reconciliationClaim = await repository.createCall({
					...claimInput,
					argsHash: randomUUID(),
					idempotencyKey: randomUUID(),
				});
				await repository.startDispatch({
					action: "github.create_pull_request",
					callId: reconciliationClaim.call.callId,
					invocation,
				});
				await repository.setCallResult({
					callId: reconciliationClaim.call.callId,
					status: "UNCERTAIN",
				});
				const expiredLeaseId = `lease-${randomUUID()}`;
				await sql`
					UPDATE connection_reconciliation_jobs
					SET status = 'LEASED', lease_id = ${expiredLeaseId},
						leased_at = now() - interval '1 minute',
						lease_expires_at = now() - interval '1 second'
					WHERE call_id = ${reconciliationClaim.call.callId}
				`;
				await repository.rescheduleReconciliationJob({
					callId: reconciliationClaim.call.callId,
					leaseId: expiredLeaseId,
					reason: "stale worker",
				});
				const [expiredLease] = await sql<
					{ lease_id: string; status: string }[]
				>`
					SELECT lease_id, status FROM connection_reconciliation_jobs
					WHERE call_id = ${reconciliationClaim.call.callId}
				`;
				expect(expiredLease).toEqual({
					lease_id: expiredLeaseId,
					status: "LEASED",
				});
				await sql`
					UPDATE connection_reconciliation_jobs SET status = 'SUCCEEDED'
					WHERE call_id = ${reconciliationClaim.call.callId}
				`;

				const { call: deniedCall } = await repository.createCall({
					action: "github.create_pull_request",
					argsHash: randomUUID(),
					idempotencyKey: randomUUID(),
					input: {
						base: "main",
						head: "test/pre-submit-denial",
						repository: "AgoraIO-Extensions/agent-infra",
						title: "Pre-submit denial",
					},
					invocation,
				});
				await oauth.revokePersonalAccessToken({
					sessionToken: browser.sessionToken,
					tokenId: pat.tokenId,
				});
				await expect(
					repository.startDispatch({
						action: "github.create_pull_request",
						callId: deniedCall.callId,
						invocation,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await repository.setCallResult({
					callId: deniedCall.callId,
					status: "DENIED_LOCAL",
				});
				const [deniedState] = await sql<
					{
						call_status: string;
						dispatch_status: string;
						effect_status: string;
					}[]
				>`
					SELECT call.status AS call_status, effect.status AS effect_status,
						dispatch.status AS dispatch_status
					FROM connection_calls call
					JOIN connection_effects effect ON effect.call_id = call.id
					JOIN connection_dispatches dispatch ON dispatch.effect_id = effect.id
					WHERE call.id = ${deniedCall.callId}
				`;
				expect(deniedState).toEqual({
					call_status: "DENIED_LOCAL",
					dispatch_status: "FAILED",
					effect_status: "FAILED",
				});

				const otherBrowser = await oauth.loginBrowserSession({
					password: "not-persisted",
					username: `other-${randomUUID()}`,
				});
				const otherPat = await oauth.issuePersonalAccessToken({
					name: "Other principal",
					sessionToken: otherBrowser.sessionToken,
				});
				const otherIdentity = await oauth.verifyAccessToken(
					`Bearer ${otherPat.token}`,
				);
				await expect(
					authorizeCurrentConsumer(service, {
						connectionId: connection.connectionId,
						consumerId: otherIdentity.consumerId,
						principalId: otherIdentity.principalId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });

				const [rootBeforeRace] = await sql<
					{ fence: string; grant_id: string; root_id: string }[]
				>`
						SELECT root.id AS root_id, root.current_grant_id AS grant_id,
							root.fence::text
						FROM connection_authorization_roots root
						WHERE root.id = (
							SELECT root_id FROM connection_grants WHERE id = ${invocation.grantId}
						)
					`;
				if (!rootBeforeRace) throw new Error("missing authorization root");
				await sql`
						CREATE OR REPLACE FUNCTION connection_test_delay_disconnect()
						RETURNS trigger LANGUAGE plpgsql AS $$
						BEGIN
							IF OLD.status = 'ACTIVE' AND NEW.status = 'DISCONNECTED' THEN
								PERFORM pg_sleep(0.2);
							END IF;
							RETURN NEW;
						END;
						$$
					`;
				await sql`
						CREATE TRIGGER connection_test_delay_disconnect
						BEFORE UPDATE ON connection_accounts
						FOR EACH ROW EXECUTE FUNCTION connection_test_delay_disconnect()
					`;
				let raceResults: PromiseSettledResult<unknown>[];
				try {
					const disconnect = repository.disconnectConnection({
						connectionId: connection.connectionId,
						principalId: identity.principalId,
					});
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
					raceResults = await Promise.allSettled([
						disconnect,
						repository.storeGithubOAuthCredential({
							accessToken: `provider-secret-${randomUUID()}`,
							displayName: "Business GitHub",
							externalAccount,
							grantedScopes: reducedScopes,
							principalId: identity.principalId,
						}),
					]);
				} finally {
					await sql`DROP TRIGGER connection_test_delay_disconnect ON connection_accounts`;
					await sql`DROP FUNCTION connection_test_delay_disconnect()`;
				}
				for (const result of raceResults) {
					if (result.status === "rejected") throw result.reason;
				}
				expect(raceResults.map((result) => result.status)).toEqual([
					"fulfilled",
					"fulfilled",
				]);
				const [raceState] = await sql<
					{
						account_status: string;
						current_grant_id: string | null;
						fence: string;
						grant_status: string;
						root_status: string;
					}[]
				>`
						SELECT account.status AS account_status,
							root.current_grant_id, root.fence::text,
							root.status AS root_status, stored_grant.status AS grant_status
						FROM connection_accounts account
						JOIN connection_authorization_roots root ON root.id = ${rootBeforeRace.root_id}
						JOIN connection_grants stored_grant ON stored_grant.id = ${rootBeforeRace.grant_id}
						WHERE account.id = ${connection.connectionId}
					`;
				expect(raceState).toEqual({
					account_status: "ACTIVE",
					current_grant_id: null,
					fence: (BigInt(rootBeforeRace.fence) + 1n).toString(),
					grant_status: "REVOKED",
					root_status: "TERMINATED",
				});
				const raceAudit = await sql<{ event: string }[]>`
						SELECT event FROM connection_audit_records
						WHERE principal_id = ${identity.principalId}
							AND event IN ('CONNECTION_CONNECTED', 'CONNECTION_DISCONNECTED')
						ORDER BY id DESC LIMIT 2
					`;
				expect(new Set(raceAudit.map((record) => record.event))).toEqual(
					new Set(["CONNECTION_CONNECTED", "CONNECTION_DISCONNECTED"]),
				);
				await expect(
					service.invokeDirectForIdentity(identity, "github.get_repository", {
						owner: "AgoraIO-Extensions",
						repo: "agent-infra",
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			} finally {
				await sql.end();
				await repository.close();
				await oauthRepository.close();
			}
		},
		30_000,
	);

	integrationTest(
		"keeps one current Consumer declaration per Provider",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const repository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 23),
			);
			const sql = postgres(databaseUrl, { max: 1 });
			const suffix = randomUUID();
			const consumer = {
				id: `consumer-multi-provider-${suffix}`,
				name: "Multi-provider consumer",
			};
			const catalog = (provider: "bitbucket" | "github") => ({
				actions: [
					{
						description: `Read ${provider}`,
						effect: "READ" as const,
						id: `${provider}.read_${suffix}@v1`,
						inputSchema: { required: [] },
						name: `${provider}.read_${suffix}`,
						requiredScopes: [`${provider}.read`],
					},
				],
				authProfile: { type: "test" },
				deploymentProfile: { deployment: "test" },
				executorDigest: `sha256:${"4".repeat(64)}`,
				provider,
				providerReleaseId: `${provider}-multi-provider-${suffix}`,
				sourceCommit: "4".repeat(40),
			});
			try {
				for (const provider of ["github", "bitbucket"] as const) {
					const published = catalog(provider);
					await repository.publishProviderCatalog(published);
					await repository.publishConsumerDeclaration({
						actionVersionIds: published.actions.map((action) => action.id),
						consumer,
						providerReleaseId: published.providerReleaseId,
					});
				}
				const declarations = await sql<
					{ provider_id: string; status: string }[]
				>`
					SELECT provider_id, status
					FROM connection_consumer_action_declarations
					WHERE consumer_id = ${consumer.id}
					ORDER BY provider_id
				`;
				expect(declarations).toEqual([
					{ provider_id: "bitbucket", status: "PUBLISHED" },
					{ provider_id: "github", status: "PUBLISHED" },
				]);
				const legacyConsumerId = `consumer-legacy-${suffix}`;
				const legacyDeclarationId = `declaration-legacy-${suffix}`;
				await sql`
					INSERT INTO connection_consumers (id, display_name, status)
					VALUES (${legacyConsumerId}, 'Legacy rolling consumer', 'ACTIVE')
				`;
				await sql`
					INSERT INTO connection_consumer_action_declarations (
						id, consumer_id, provider_release_id, revision, digest, status
					)
					VALUES (
						${legacyDeclarationId}, ${legacyConsumerId},
						${`github-multi-provider-${suffix}`}, 1,
						${`legacy-${suffix}`}, 'PUBLISHED'
					)
				`;
				const [legacyDeclaration] = await sql<{ provider_id: string }[]>`
					SELECT provider_id
					FROM connection_consumer_action_declarations
					WHERE id = ${legacyDeclarationId}
				`;
				expect(legacyDeclaration?.provider_id).toBe("github");
			} finally {
				await sql.end();
				await repository.close();
			}
		},
		30_000,
	);
});
