import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	ConnectionApplicationService,
	canonicalHash,
} from "@agent-infra/connection-core";
import {
	bitbucketServerConnectionCatalog,
	githubConnectionCatalog,
} from "@agent-infra/openconnector-adapter";
import {
	bitbucketAuthorizationCompatibility,
	datalegoAuthorizationCompatibility,
	datalegoV5ConnectionCatalog,
} from "@agent-infra/openconnector-adapter/authorization-compatibility";
import { datalegoV4ConnectionCatalog } from "@agent-infra/openconnector-adapter/datalego-v4";
import {
	DataLegoV5Adapter,
	datalegoV5ConnectionCatalog as immutableDatalegoV5,
} from "@agent-infra/openconnector-adapter/datalego-v5";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresConnectionAccessRequestRepository } from "./access-request-repository";
import { PostgresConnectionApprovalRepository } from "./approval-repository";
import { seedApprovedConnectPermit } from "./approved-connect-fixture";
import { migrateConnectionDatabase } from "./migrations";
import {
	PostgresConnectionRepository,
	type PublishedProviderCatalog,
} from "./repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_RECONNECT_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl)
	throw new Error("Upgrade test database required");

describe("compatible approval upgrade", () => {
	for (const recovery of ["renewal", "reconnect"] as const) {
		(databaseUrl ? it : it.skip)(
			`${recovery} recovers obsolete selections but propagates invalid authorization lookups`,
			async () => {
				if (!databaseUrl) return;
				await migrateConnectionDatabase(
					databaseUrl,
					resolve(import.meta.dirname, "../../../migrations/connection"),
				);
				const sql = postgres(databaseUrl);
				const repository = new PostgresConnectionRepository(
					databaseUrl,
					Buffer.alloc(32, 23),
				);
				const suffix = randomUUID();
				const principalId = `recovery-${suffix}`;
				const consumerId = `consumer-${suffix}`;
				try {
					await repository.publishProviderCatalog(immutableDatalegoV5);
					await sql`INSERT INTO connection_principals (id, display_name) VALUES (${principalId}, 'Recovery owner')`;
					const identity = {
						principalId,
						providerId: "datalego",
						providerReleaseId: immutableDatalegoV5.providerReleaseId,
						externalAccount: "recovery@example.invalid",
						displayName: "Recovery account",
						accessToken: "recovery-fixture",
						grantedScopes: ["datalego.query"],
					};
					const { connectionId } = await repository.storeProviderCredential({
						...identity,
						accessRequestId: await seedApprovedConnectPermit(sql, {
							principalId,
							providerReleaseId: identity.providerReleaseId,
							scopes: identity.grantedScopes,
						}),
					});
					const declaration = {
						consumer: { id: consumerId, name: "Recovery consumer" },
						providerReleaseId: identity.providerReleaseId,
					};
					const selected = "datalego.get_current_user@v5";
					await repository.publishConsumerDeclaration({
						...declaration,
						actionVersionIds: [selected],
					});
					await sql`INSERT INTO connection_consumer_instances (id,consumer_id,kind,auth_subject,status,principal_id)
						VALUES (${`instance-${suffix}`},${consumerId},'DEVICE',${suffix},'ACTIVE',${principalId})`;
					const input = { principalId, consumerId, connectionId };
					const preview =
						await repository.createCurrentConsumerAuthorizationPreview({
							...input,
							actionVersionIds: [selected],
						});
					await repository.confirmCurrentConsumerAuthorization({
						principalId,
						previewId: preview.previewId,
						confirmationToken: preview.confirmationToken,
						idempotencyKey: randomUUID(),
					});
					const credential = await repository.getProviderCredentialForUpgrade({
						principalId,
						connectionId,
						allowCurrentRelease: true,
					});
					const recover = () =>
						recovery === "renewal"
							? sql.begin(async (transaction) => {
									await repository.restoreGrantsAfterRenewal(
										transaction,
										connectionId,
									);
								})
							: repository.storeProviderCredential({
									...identity,
									expectedConnectionId: connectionId,
									expectedCredentialVersionId: credential.credentialVersionId,
								});
					const { declarationId } = await repository.publishConsumerDeclaration(
						{
							...declaration,
							actionVersionIds: ["datalego.get_query_status@v5"],
						},
					);
					// Empty lookup results are malformed, even while restoring a Grant.
					await sql`DELETE FROM connection_consumer_declared_actions WHERE declaration_id=${declarationId}`;
					await expect(
						repository.createCurrentConsumerAuthorizationPreview(input),
					).rejects.toMatchObject({ code: "INVALID_REQUEST" });
					await expect(recover()).rejects.toMatchObject({
						code: "INVALID_REQUEST",
					});
					await sql`INSERT INTO connection_consumer_declared_actions (declaration_id, action_version_id) VALUES (${declarationId}, 'datalego.get_query_status@v5')`;
					// A stale selection is rejected on normal preview, but restoration must require fresh consent.
					await expect(
						repository.createCurrentConsumerAuthorizationPreview({
							...input,
							actionVersionIds: [selected],
						}),
					).rejects.toMatchObject({ code: "INVALID_REQUEST" });
					await recover();
					const [root] =
						await sql`SELECT current_grant_id FROM connection_authorization_roots WHERE principal_id=${principalId} AND consumer_id=${consumerId}`;
					expect(root?.current_grant_id).toBeNull();
					await expect(
						repository.createCurrentConsumerAuthorizationPreview({
							...input,
							actionVersionIds: ["datalego.get_query_status@v5"],
						}),
					).resolves.toMatchObject({
						actions: [{ id: "datalego.get_query_status@v5" }],
					});
				} finally {
					await repository.close();
					await sql.end();
				}
			},
			30_000,
		);
	}
	(databaseUrl ? it : it.skip)(
		"current releases require valid approval and credentials but no migration proof",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const sql = postgres(databaseUrl);
			const repository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 23),
			);
			const principalId = `current-release-${randomUUID()}`;
			let createdConnectionId: string | undefined;
			const catalog = {
				...immutableDatalegoV5,
				providerReleaseId: `current-${principalId}`,
				actions: immutableDatalegoV5.actions.map((action) => ({
					...action,
					id: `${action.id}-${principalId}`,
				})),
			};
			try {
				await repository.publishProviderCatalog(catalog);
				await sql`INSERT INTO connection_principals (id, display_name) VALUES (${principalId}, 'Current release owner')`;
				const { connectionId } = await repository.storeProviderCredential({
					principalId,
					providerId: "datalego",
					providerReleaseId: catalog.providerReleaseId,
					externalAccount: "current@example.invalid",
					displayName: "Current account",
					accessToken: "current-fixture",
					grantedScopes: ["datalego.query"],
					accessRequestId: await seedApprovedConnectPermit(sql, {
						principalId,
						providerReleaseId: catalog.providerReleaseId,
						scopes: ["datalego.query"],
					}),
				});
				createdConnectionId = connectionId;
				const input = { principalId, connectionId };
				// Retiring one Action does not require migrating an already-current account.
				// Other approved Actions remain available; self-migration cannot map the retired Action.
				await sql`UPDATE connection_action_versions SET status='DISABLED' WHERE id=${catalog.actions[0]?.id ?? "missing"}`;
				await expect(
					repository.getProviderUpgradeReadiness(input),
				).resolves.toMatchObject({
					nextAction: "NONE",
					reason: "ALREADY_CURRENT",
				});
				await expect(
					repository.getProviderUpgradeReadiness({
						...input,
						principalId: "another-owner",
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await sql`UPDATE connection_credential_versions SET status='REVOKED' WHERE connection_id=${connectionId}`;
				await expect(
					repository.getProviderUpgradeReadiness(input),
				).resolves.toMatchObject({
					nextAction: "REAUTHORIZE",
					reason: "CREDENTIAL_REAUTHORIZATION_REQUIRED",
				});
				await sql`UPDATE connection_credential_versions SET status='ACTIVE', expires_at=now()-interval '1 minute' WHERE connection_id=${connectionId}`;
				await expect(
					repository.getProviderUpgradeReadiness(input),
				).resolves.toMatchObject({
					nextAction: "REAUTHORIZE",
					reason: "CREDENTIAL_REAUTHORIZATION_REQUIRED",
				});
				await sql`UPDATE connection_credential_versions SET expires_at=now()+interval '1 hour' WHERE connection_id=${connectionId}`;
				await expect(
					repository.getProviderUpgradeReadiness(input),
				).resolves.toMatchObject({
					nextAction: "NONE",
					reason: "ALREADY_CURRENT",
				});
				for (const state of ["REVOKED", "SUSPENDED", "EXPIRED"] as const) {
					await sql`UPDATE connection_access_authorizations SET state=${state} WHERE connection_id=${connectionId}`;
					await expect(
						repository.getProviderUpgradeReadiness(input),
					).resolves.toMatchObject({ nextAction: "REQUEST_APPROVAL" });
				}
				await sql`UPDATE connection_access_authorizations SET state='ACTIVE', validity_kind='FINITE', valid_until=now()-interval '1 minute' WHERE connection_id=${connectionId}`;
				await expect(
					repository.getProviderUpgradeReadiness(input),
				).resolves.toMatchObject({ nextAction: "REQUEST_APPROVAL" });
			} finally {
				if (createdConnectionId) {
					await repository.disconnectConnection({
						principalId,
						connectionId: createdConnectionId,
					});
					await sql`UPDATE connection_access_authorizations SET state='REVOKED' WHERE connection_id=${createdConnectionId}`;
				}
				await repository.close();
				await sql.end();
			}
		},
		30_000,
	);
	(databaseUrl ? it : it.skip)(
		"upgrades real DataLego v4 OAuth catalog without expanding approval or losing refresh credentials",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const sql = postgres(databaseUrl);
			const repository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 23),
			);
			const principalId = `datalego-repair-${randomUUID()}`;
			const identity = {
				principalId,
				providerId: "datalego",
				providerReleaseId: datalegoV4ConnectionCatalog.providerReleaseId,
				externalAccount: "alice@example.invalid",
				displayName: "Alice",
				accessToken: "datalego-access-fixture",
				refreshToken: "datalego-refresh-fixture",
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
				grantedScopes: ["datalego.query"],
			};
			try {
				await repository.publishProviderCatalog(datalegoV4ConnectionCatalog);
				await sql`INSERT INTO connection_principals (id, display_name) VALUES (${principalId}, 'DataLego repair')`;
				const requestId = await seedApprovedConnectPermit(sql, {
					principalId,
					providerReleaseId: identity.providerReleaseId,
					scopes: identity.grantedScopes,
					actionVersionIds: [
						"datalego.get_current_user@v4",
						"datalego.get_query_status@v4",
					],
				});
				const { connectionId } = await repository.storeProviderCredential({
					...identity,
					accessRequestId: requestId,
				});
				await expect(
					repository.getProviderUpgradeReadiness({ principalId, connectionId }),
				).resolves.toMatchObject({ nextAction: "NONE" });
				const [originalAccess] =
					await sql`SELECT id,valid_until,source_request_id FROM connection_effective_access_authorizations WHERE connection_id=${connectionId}`;
				const originalCredential =
					await repository.getProviderCredentialForUpgrade({
						principalId,
						connectionId,
						allowCurrentRelease: true,
					});
				await expect(
					repository.getProviderCredentialForUpgrade({
						principalId: "other-user",
						connectionId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await repository.publishProviderCatalog(immutableDatalegoV5);
				await expect(
					repository.getProviderUpgradeReadiness({ principalId, connectionId }),
				).resolves.toMatchObject({ nextAction: "REQUEST_APPROVAL" });
				const adapter = new DataLegoV5Adapter(
					async (url, init) => {
						if (String(url) === "https://oauth.agoralab.co/oauth/token")
							return Response.json({
								access_token: "rotated-access-fixture",
								token_type: "Bearer",
								refresh_token: "rotated-refresh-fixture",
								expires_in: 3600,
							});
						if (String(url) === "https://oauth.agoralab.co/api/v2/userInfo") {
							expect([
								"Bearer datalego-access-fixture",
								"Bearer rotated-access-fixture",
							]).toContain(new Headers(init?.headers).get("authorization"));
							return Response.json({ email: identity.externalAccount });
						}
						return Response.json(
							{ message: "record not found" },
							{ status: 400 },
						);
					},
					{
						clientId: "test-client",
						clientSecret: "test-secret",
						redirectUri:
							"https://connection.example/oauth/callback?provider=datalego",
					},
				);
				const service = new ConnectionApplicationService(
					repository,
					{ execute: (input) => adapter.execute(input) },
					undefined,
					{ datalego: adapter },
					{ datalego: adapter },
				);
				await expect(
					service.upgradeProviderConnection(principalId, connectionId),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await repository.publishProviderCatalog({
					...datalegoV5ConnectionCatalog,
					authorizationCompatibility: [
						{
							...datalegoAuthorizationCompatibility[0],
							toExecutorDigest: `sha256:${"0".repeat(64)}`,
						},
					],
				});
				await expect(
					service.upgradeProviderConnection(principalId, connectionId),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await repository.publishProviderCatalog(datalegoV5ConnectionCatalog);
				await expect(
					repository.getProviderUpgradeReadiness({ principalId, connectionId }),
				).resolves.toMatchObject({ nextAction: "UPGRADE" });
				await expect(
					repository.getProviderUpgradeReadiness({
						principalId: "other-user",
						connectionId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const binding = await repository.validatePersonalReconnect({
					principalId,
					connectionId,
				});
				expect(binding.upgradeBinding?.targetProviderReleaseId).toBe(
					datalegoV5ConnectionCatalog.providerReleaseId,
				);
				const transaction = {
					providerId: "datalego",
					principalId,
					codeVerifier: "verifier-fixture",
					redirectUri:
						"https://connection.example/oauth/callback?provider=datalego",
					reconnectConnectionId: connectionId,
					upgradeBinding: binding.upgradeBinding,
					state: randomUUID(),
				};
				await repository.createOAuthTransaction(transaction);
				const decoded = await repository.consumeOAuthTransaction(
					transaction.state,
					"datalego",
				);
				expect(decoded.codeVerifier).toBe(transaction.codeVerifier);
				expect(decoded.upgradeBinding).toEqual(binding.upgradeBinding);
				await expect(
					repository.consumeOAuthTransaction(transaction.state, "datalego"),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				await expect(
					service.upgradeProviderConnection(principalId, connectionId),
				).resolves.toEqual({ connectionId });
				const current = await repository.getProviderCredentialForUpgrade({
					principalId,
					connectionId,
					allowCurrentRelease: true,
				});
				await expect(
					repository.getProviderUpgradeReadiness({ principalId, connectionId }),
				).resolves.toMatchObject({ nextAction: "NONE" });
				expect(
					(
						await repository.validatePersonalReconnect({
							principalId,
							connectionId,
						})
					).upgradeBinding?.credentialVersionId,
				).not.toBe(decoded.upgradeBinding?.credentialVersionId);
				await expect(
					adapter.execute({
						action: "datalego.get_current_user",
						credential: { accessToken: current.accessToken },
						input: {},
					}),
				).resolves.toEqual({ email: identity.externalAccount });
				await sql`UPDATE connection_credential_versions SET expires_at=now()-interval '1 minute' WHERE id=${current.credentialVersionId}`;
				await expect(
					repository.getProviderUpgradeReadiness({ principalId, connectionId }),
				).resolves.toMatchObject({ nextAction: "REAUTHORIZE" });
				await sql`UPDATE connection_credential_versions SET expires_at=${identity.expiresAt} WHERE id=${current.credentialVersionId}`;
				const consumerId = `upgrade-read-${randomUUID()}`;
				const instanceId = `instance-${randomUUID()}`;
				await repository.publishConsumerDeclaration({
					consumer: { id: consumerId, name: "Upgrade lifecycle test" },
					providerReleaseId: datalegoV5ConnectionCatalog.providerReleaseId,
					actionVersionIds: datalegoV5ConnectionCatalog.actions.map(
						(action) => action.id,
					),
				});
				await sql`INSERT INTO connection_consumer_instances
					(id,consumer_id,kind,auth_subject,status,principal_id)
					VALUES (${instanceId},${consumerId},'DEVICE',${instanceId},'ACTIVE',${principalId})`;
				const preview =
					await repository.createCurrentConsumerAuthorizationPreview({
						principalId,
						consumerId,
						connectionId,
						actionVersionIds: ["datalego.get_current_user@v5"],
					});
				await repository.confirmCurrentConsumerAuthorization({
					principalId,
					previewId: preview.previewId,
					confirmationToken: preview.confirmationToken,
					idempotencyKey: randomUUID(),
				});
				const directIdentity = { principalId, consumerId, instanceId };
				await expect(
					service.invokeDirectForIdentity(
						directIdentity,
						"datalego.get_current_user",
						{},
					),
				).resolves.toMatchObject({
					status: "SUCCEEDED",
					result: { email: identity.externalAccount },
				});
				await sql`UPDATE connection_credential_versions SET expires_at=now()-interval '1 minute' WHERE id=${current.credentialVersionId}`;
				await expect(
					service.invokeDirectForIdentity(
						directIdentity,
						"datalego.get_current_user",
						{},
					),
				).resolves.toMatchObject({
					status: "SUCCEEDED",
					result: { email: identity.externalAccount },
				});
				const refreshed = await repository.getProviderCredentialForUpgrade({
					principalId,
					connectionId,
					allowCurrentRelease: true,
				});
				expect(refreshed.refreshToken).toBe("rotated-refresh-fixture");
				expect(refreshed.credentialVersionId).not.toBe(
					current.credentialVersionId,
				);
				await expect(
					repository.getProviderUpgradeReadiness({ principalId, connectionId }),
				).resolves.toMatchObject({ nextAction: "NONE" });
				const [refreshedAccount] = await sql`
					SELECT last_credential_version_id FROM connection_accounts WHERE id=${connectionId}
				`;
				expect(refreshedAccount?.last_credential_version_id).toBe(
					refreshed.credentialVersionId,
				);
				const refreshedActions = await sql<{ action_version_id: string }[]>`
					SELECT member.action_version_id FROM connection_authorization_roots root
					JOIN connection_grant_actions member ON member.grant_id=root.current_grant_id
					WHERE root.consumer_id=${consumerId} AND root.principal_id=${principalId}
				`;
				expect(refreshedActions.map((row) => row.action_version_id)).toEqual([
					"datalego.get_current_user@v5",
				]);
				expect(current).toMatchObject({
					accessToken: identity.accessToken,
					refreshToken: identity.refreshToken,
					expiresAt: identity.expiresAt,
					refreshExpiresAt: identity.refreshExpiresAt,
				});
				const [access] =
					await sql`SELECT * FROM connection_effective_access_authorizations WHERE connection_id=${connectionId}`;
				expect(access?.id).toBe(originalAccess?.id);
				expect(access?.provider_release_id).toBe(
					datalegoV5ConnectionCatalog.providerReleaseId,
				);
				expect(access?.approved_provider_release_id).toBe(
					datalegoV4ConnectionCatalog.providerReleaseId,
				);
				expect(access?.source_request_id).toBe(
					originalAccess?.source_request_id,
				);
				expect(access?.valid_until).toEqual(originalAccess?.valid_until);
				const members =
					await sql`SELECT action_version_id FROM connection_capability_profile_actions WHERE capability_profile_id=${access?.capability_profile_id} ORDER BY action_version_id`;
				expect(members.map((row) => row.action_version_id)).toEqual([
					"datalego.get_current_user@v5",
					"datalego.get_query_status@v5",
				]);
				const [stored] =
					await sql`SELECT refresh_ciphertext FROM connection_credential_versions WHERE id=${current.credentialVersionId}`;
				expect(stored?.refresh_ciphertext).toBeTruthy();
				expect(stored?.refresh_ciphertext).not.toBe(identity.refreshToken);
				await expect(
					repository.storeProviderCredential({
						...identity,
						providerReleaseId: datalegoV5ConnectionCatalog.providerReleaseId,
						expectedConnectionId: connectionId,
						expectedCredentialVersionId: originalCredential.credentialVersionId,
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				const overview = JSON.stringify(
					await repository.getOverview(principalId),
				);
				expect(overview).not.toContain(identity.accessToken);
				expect(overview).not.toContain(identity.refreshToken);
			} finally {
				await repository.close();
				await sql.end();
			}
		},
	);
	(databaseUrl ? it : it.skip)(
		"upgrades the pinned Bitbucket v7 account to v8 using reviewed repair evidence",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const sql = postgres(databaseUrl);
			const repository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 23),
			);
			const proof = bitbucketAuthorizationCompatibility[0];
			const source = {
				...bitbucketServerConnectionCatalog,
				providerReleaseId: proof.fromReleaseId,
				executorDigest: proof.fromExecutorDigest,
				actions: bitbucketServerConnectionCatalog.actions.map((action) => ({
					...action,
					id: action.id.replace(/@v8$/, "@v7"),
				})),
			};
			const principalId = `bitbucket-repair-${randomUUID()}`;
			try {
				await repository.publishProviderCatalog(source);
				await sql`INSERT INTO connection_principals (id, display_name) VALUES (${principalId}, 'Repair test')`;
				const requestId = await seedApprovedConnectPermit(sql, {
					principalId,
					providerReleaseId: source.providerReleaseId,
					scopes: ["bitbucket.server.pat"],
					actionVersionIds: source.actions.map((action) => action.id),
				});
				const identity = {
					principalId,
					providerId: source.provider,
					externalAccount: "2588-test-fixture",
					accessToken: "isolated-test-fixture",
					displayName: "Repair account",
					grantedScopes: ["bitbucket.server.pat"],
					providerReleaseId: source.providerReleaseId,
				};
				const { connectionId } = await repository.storeProviderCredential({
					...identity,
					accessRequestId: requestId,
				});
				await repository.publishProviderCatalog(
					bitbucketServerConnectionCatalog,
				);
				const credential = await repository.getProviderCredentialForUpgrade({
					principalId,
					connectionId,
				});
				const upgrade = {
					...identity,
					providerReleaseId: bitbucketServerConnectionCatalog.providerReleaseId,
					expectedConnectionId: connectionId,
					expectedCredentialVersionId: credential.credentialVersionId,
				};
				await expect(
					repository.storeProviderCredential(upgrade),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await repository.publishProviderCatalog({
					...bitbucketServerConnectionCatalog,
					authorizationCompatibility: bitbucketAuthorizationCompatibility,
				});
				await expect(
					repository.storeProviderCredential(upgrade),
				).resolves.toMatchObject({ connectionId });
				const [access] =
					await sql`SELECT * FROM connection_effective_access_authorizations WHERE connection_id = ${connectionId}`;
				expect(access?.approved_provider_release_id).toBe(
					source.providerReleaseId,
				);
				expect(access?.provider_release_id).toBe(
					bitbucketServerConnectionCatalog.providerReleaseId,
				);
				expect(access?.source_request_id).toBe(requestId);
			} finally {
				await repository.close();
				await sql.end();
			}
		},
	);
	(databaseUrl ? it : it.skip).each([false, true])(
		"maps only five approved Actions from ten to twelve, retaining validity and original revocation (reviewed repair: %s)",
		async (reviewedRepair) => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const sql = postgres(databaseUrl);
			const repository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 23),
			);
			const approval = new PostgresConnectionApprovalRepository(databaseUrl);
			const requests = new PostgresConnectionAccessRequestRepository(
				databaseUrl,
			);
			const suffix = randomUUID();
			const principalId = `upgrade-owner-${suffix}`;
			const approverId = `upgrade-reviewer-${suffix}`;
			const provider = `upgrade-provider-${suffix}`;
			const template = githubConnectionCatalog.actions[0];
			if (!template) throw new Error("Action fixture missing");
			const catalog = (
				version: number,
				count: number,
			): PublishedProviderCatalog => ({
				...githubConnectionCatalog,
				provider,
				providerReleaseId: `${provider}-v${version}`,
				actions: Array.from({ length: count }, (_, index) => ({
					...template,
					id: `${provider}.action-${index}@v${version}`,
					name: `${provider}.action-${index}`,
					requiredScopes: ["repo"],
				})),
			});
			const v5 = catalog(5, 10);
			const v6 = catalog(6, 12);
			if (reviewedRepair) {
				v6.executorDigest = `sha256:${"2".repeat(64)}`;
				v6.authorizationCompatibility = [
					{
						provider,
						fromReleaseId: v5.providerReleaseId,
						toReleaseId: v6.providerReleaseId,
						fromExecutorDigest: v5.executorDigest,
						toExecutorDigest: v6.executorDigest,
						rationale: "Reviewed transport-only repair",
						reviewReference: "issue-1003-test",
					},
				];
			}
			try {
				await repository.publishProviderCatalog(v5);
				await sql`INSERT INTO connection_principals (id, display_name) VALUES (${principalId}, 'Upgrade owner')`;
				await sql`INSERT INTO connection_principals (id, display_name) VALUES (${approverId}, 'Upgrade reviewer')`;
				await sql`INSERT INTO connection_principal_roles (principal_id, role, status, grant_source)
				VALUES (${principalId}, 'CONNECTION_ADMIN', 'ACTIVE', 'BOOTSTRAP')`;
				const requestId = await seedApprovedConnectPermit(sql, {
					principalId,
					providerReleaseId: v5.providerReleaseId,
					renewalApproverId: approverId,
					scopes: ["repo"],
					actionVersionIds: v5.actions.slice(0, 5).map((action) => action.id),
				});
				const identity = {
					principalId,
					providerId: provider,
					externalAccount: "stable-id",
					accessToken: "upgrade-fixture-credential",
					displayName: "Upgrade account",
					grantedScopes: ["repo"],
					providerReleaseId: v5.providerReleaseId,
				};
				const { connectionId } = await repository.storeProviderCredential({
					...identity,
					accessRequestId: requestId,
				});
				await sql`UPDATE connection_access_authorizations SET validity_kind = 'FINITE', valid_until = now() + interval '10 days'
				WHERE connection_id = ${connectionId}`;
				const [before] =
					await sql`SELECT * FROM connection_access_authorizations WHERE connection_id = ${connectionId}`;
				await repository.publishProviderCatalog(v6);
				const credential = await repository.getProviderCredentialForUpgrade({
					principalId,
					connectionId,
				});
				const upgrade = {
					...identity,
					providerReleaseId: v6.providerReleaseId,
					expectedConnectionId: connectionId,
					expectedCredentialVersionId: credential.credentialVersionId,
				};
				if (reviewedRepair) {
					const evidence = v6.authorizationCompatibility?.[0];
					if (!evidence) throw new Error("Evidence fixture missing");
					for (const field of [
						"provider",
						"fromReleaseId",
						"toReleaseId",
						"fromExecutorDigest",
						"toExecutorDigest",
						"rationale",
						"reviewReference",
					] as const) {
						await repository.publishProviderCatalog({
							...v6,
							authorizationCompatibility: [
								{
									...evidence,
									[field]:
										field === "rationale" || field === "reviewReference"
											? ""
											: "mismatch",
								},
							],
						});
						await expect(
							repository.storeProviderCredential(upgrade),
						).rejects.toMatchObject({ code: "FORBIDDEN" });
					}
					await repository.publishProviderCatalog({
						...v6,
						authorizationCompatibility: [],
					});
					await expect(
						repository.storeProviderCredential(upgrade),
					).rejects.toMatchObject({ code: "FORBIDDEN" });
					await repository.publishProviderCatalog(v6);
				}
				await expect(
					repository.storeProviderCredential({
						...upgrade,
						grantedScopes: ["repo", "admin"],
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(
					repository.storeProviderCredential({
						...upgrade,
						principalId: `${principalId}-other`,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(
					repository.storeProviderCredential({
						...upgrade,
						externalAccount: "different-id",
					}),
				).rejects.toBeDefined();
				const concurrent = await Promise.allSettled([
					repository.storeProviderCredential(upgrade),
					repository.storeProviderCredential(upgrade),
				]);
				expect(
					concurrent.filter((result) => result.status === "fulfilled"),
				).toHaveLength(1);
				expect(
					concurrent.filter((result) => result.status === "rejected"),
				).toHaveLength(1);
				const [after] =
					await sql`SELECT * FROM connection_effective_access_authorizations WHERE connection_id = ${connectionId}`;
				expect(after?.provider_release_id).toBe(v6.providerReleaseId);
				expect(after?.approved_provider_release_id).toBe(v5.providerReleaseId);
				expect(after?.source_request_id).toBe(requestId);
				expect(after?.valid_until).toEqual(before?.valid_until);
				expect(Number(after?.revision)).toBe(Number(before?.revision) + 1);
				const mapped =
					await sql`SELECT action_version_id FROM connection_capability_profile_actions
						WHERE capability_profile_id = ${after?.capability_profile_id} ORDER BY action_version_id`;
				const [audit] = await sql`SELECT detail FROM connection_audit_records
					WHERE principal_id = ${principalId} AND event = 'CONNECTION_APPROVAL_COMPATIBLE_UPGRADE'`;
				expect(audit?.detail.executorCompatibility).toEqual(
					reviewedRepair ? v6.authorizationCompatibility?.[0] : null,
				);
				expect(mapped.map((row) => row.action_version_id)).toEqual(
					v6.actions
						.slice(0, 5)
						.map((action) => action.id)
						.sort(),
				);
				await expect(
					repository.storeProviderCredential(upgrade),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				const consumerId = `upgrade-consumer-${suffix}`;
				await repository.publishConsumerDeclaration({
					consumer: { id: consumerId, name: "Upgrade consumer" },
					providerReleaseId: v6.providerReleaseId,
					actionVersionIds: v6.actions.map((action) => action.id),
				});
				await sql`INSERT INTO connection_consumer_instances
					(id, consumer_id, kind, auth_subject, status, principal_id)
					VALUES (${`instance-${suffix}`}, ${consumerId}, 'DEVICE', ${`subject-${suffix}`}, 'ACTIVE', ${principalId})`;
				const preview =
					await repository.createCurrentConsumerAuthorizationPreview({
						principalId,
						consumerId,
						connectionId,
					});
				expect(preview.actions.map((action) => action.id).sort()).toEqual(
					v6.actions
						.slice(0, 5)
						.map((action) => action.id)
						.sort(),
				);
				await expect(
					repository.createCurrentConsumerAuthorizationPreview({
						principalId,
						consumerId,
						connectionId,
						actionVersionIds: [v6.actions[10]?.id ?? "missing"],
					}),
				).rejects.toBeDefined();
				const [renewalPolicy] =
					await sql`SELECT policy_version_id, capability_profile_id FROM connection_access_requests WHERE id = ${requestId}`;
				if (!renewalPolicy || !after)
					throw new Error("Renewal fixture missing");
				const presentationId = `upgrade-presentation-${suffix}`;
				await sql`INSERT INTO connection_disclaimer_presentations (id, principal_id, policy_version_id, disclaimer_bundle_digest)
					VALUES (${presentationId}, ${principalId}, ${renewalPolicy.policy_version_id}, ${canonicalHash([])})`;
				const renewalRequestId = `upgrade-renewal-${suffix}`;
				await requests.createRenewalRequest({
					id: renewalRequestId,
					applicantPrincipalId: principalId,
					authorizationId: after.id,
					capabilityProfileId: renewalPolicy.capability_profile_id,
					providerReleaseId: v5.providerReleaseId,
					policyVersionId: renewalPolicy.policy_version_id,
					presentationId,
					duration: { kind: "FINITE", days: 90 },
					disclaimerConfirmations: [],
					purpose: "Renew compatible approval",
				});
				await repository.publishProviderCatalog({
					...catalog(8, 12),
					executorDigest: v6.executorDigest,
				});
				const current = await repository.getProviderCredentialForUpgrade({
					principalId,
					connectionId,
				});
				expect(current.accessToken).toBe(identity.accessToken);
				for (const change of [
					"executor",
					"effect",
					"schema",
					"scope",
					"auth",
					"deployment",
					"missing",
					"description",
				] as const) {
					const target = catalog(7, 12);
					target.providerReleaseId += `-${change}`;
					target.actions = target.actions.map((action) => ({
						...action,
						id: `${action.id}-${change}`,
					}));
					if (change === "executor")
						target.executorDigest = `sha256:${"0".repeat(64)}`;
					if (reviewedRepair && change !== "executor") {
						target.authorizationCompatibility = [
							{
								provider,
								fromReleaseId: v6.providerReleaseId,
								toReleaseId: target.providerReleaseId,
								fromExecutorDigest: v6.executorDigest,
								toExecutorDigest: target.executorDigest,
								rationale:
									"Evidence cannot bypass action/auth/deployment checks",
								reviewReference: "issue-1003-test",
							},
						];
					}
					if (change === "auth")
						target.authProfile = { ...target.authProfile, expanded: true };
					if (change === "deployment")
						target.deploymentProfile = {
							...target.deploymentProfile,
							expanded: true,
						};
					if (change === "missing") target.actions = target.actions.slice(1);
					const first = target.actions[0];
					if (first && change === "description")
						first.description += " changed behavior";
					if (first && change === "effect")
						first.effect = first.effect === "READ" ? "WRITE" : "READ";
					if (first && change === "schema")
						first.inputSchema = {
							type: "object",
							required: [],
							additionalProperties: true,
						};
					if (first && change === "scope")
						first.requiredScopes = ["repo", "admin"];
					await repository.publishProviderCatalog(target);
					await expect(
						repository.storeProviderCredential({
							...upgrade,
							providerReleaseId: target.providerReleaseId,
							expectedCredentialVersionId: current.credentialVersionId,
						}),
					).rejects.toMatchObject({ code: "FORBIDDEN" });
				}
				const v8 = catalog(8, 12);
				if (reviewedRepair) v8.executorDigest = v6.executorDigest;
				await repository.publishProviderCatalog(v8);
				await sql`UPDATE connection_access_authorizations SET valid_until = now() - interval '1 second' WHERE id = ${after?.id}`;
				await expect(
					repository.storeProviderCredential({
						...upgrade,
						providerReleaseId: v8.providerReleaseId,
						expectedCredentialVersionId: current.credentialVersionId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await sql`UPDATE connection_access_authorizations SET valid_until = (
					SELECT prior_valid_until FROM connection_authorization_renewals WHERE request_id = ${renewalRequestId}
				) WHERE id = ${after?.id}`;
				for (const state of ["EXPIRED", "REVOKED", "SUSPENDED"] as const) {
					await sql`UPDATE connection_access_authorizations SET state = ${state} WHERE id = ${after?.id}`;
					await expect(
						repository.storeProviderCredential({
							...upgrade,
							providerReleaseId: v8.providerReleaseId,
							expectedCredentialVersionId: current.credentialVersionId,
						}),
					).rejects.toMatchObject({ code: "FORBIDDEN" });
				}
				await sql`UPDATE connection_access_authorizations SET state = 'ACTIVE' WHERE id = ${after?.id}`;
				await repository.storeProviderCredential({
					...upgrade,
					providerReleaseId: v8.providerReleaseId,
					expectedCredentialVersionId: current.credentialVersionId,
				});
				const [secondUpgrade] =
					await sql`SELECT * FROM connection_effective_access_authorizations WHERE id = ${after?.id}`;
				expect(secondUpgrade?.provider_release_id).toBe(v8.providerReleaseId);
				expect(secondUpgrade?.approved_provider_release_id).toBe(
					v5.providerReleaseId,
				);
				expect(secondUpgrade?.valid_until).toEqual(before?.valid_until);
				const renewal = await requests.getRequest(
					principalId,
					renewalRequestId,
				);
				const stage = renewal.stages[0];
				if (!stage) throw new Error("Renewal stage missing");
				await requests.decide({
					actorPrincipalId: approverId,
					approverPrincipalId: approverId,
					decision: "APPROVE",
					expectedRequestRevision: renewal.revision,
					expectedRoutingRevision: stage.routingRevision,
					expectedStageRevision: stage.revision,
					id: `upgrade-renewal-decision-${suffix}`,
					requestId: renewalRequestId,
				});
				const [renewed] =
					await sql`SELECT valid_until FROM connection_access_authorizations WHERE id = ${after.id}`;
				expect(renewed?.valid_until.getTime()).toBeGreaterThan(
					before?.valid_until.getTime() + 89 * 86400000,
				);
				const [policy] =
					await sql`SELECT policy.id, policy.revision::text FROM connection_access_policy_versions policy
				JOIN connection_access_requests request ON request.policy_version_id = policy.id WHERE request.id = ${requestId}`;
				const campaign = {
					id: `upgraded-campaign-${suffix}`,
					actorPrincipalId: principalId,
					capabilityProfileId: before?.capability_profile_id,
					providerReleaseId: v5.providerReleaseId,
					triggerKind: "PROVIDER_RELEASE" as const,
					triggerVersionId: v8.providerReleaseId,
					deadlineAt: new Date(Date.now() + 7 * 86400000).toISOString(),
					reason: "Reapprove original policy after upgrade",
				};
				await sql`UPDATE connection_access_authorizations SET upgraded_external_account_fingerprint = 'invalid' WHERE id = ${after.id}`;
				await expect(
					requests.createReapprovalCampaign(campaign),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await sql`UPDATE connection_access_authorizations SET upgraded_external_account_fingerprint = ${secondUpgrade?.external_account_fingerprint} WHERE id = ${after.id}`;
				await expect(
					requests.createReapprovalCampaign(campaign),
				).resolves.toEqual({ campaignId: campaign.id, affectedConnections: 1 });
				const [reapproval] =
					await sql`SELECT state, reapproval_deadline_at FROM connection_access_authorizations WHERE id = ${after.id}`;
				expect(reapproval?.state).toBe("REAPPROVAL_REQUIRED");
				expect(reapproval?.reapproval_deadline_at.toISOString()).toBe(
					campaign.deadlineAt,
				);
				await approval.revokePolicy({
					actorPrincipalId: principalId,
					policyVersionId: policy?.id,
					expectedRevision: policy?.revision,
					reason: "Revoke original approval after compatible migration",
				});
				const [revoked] =
					await sql`SELECT state FROM connection_access_authorizations WHERE id = ${after?.id}`;
				expect(revoked?.state).toBe("SUSPENDED");
				const expandedRequestId = await seedApprovedConnectPermit(sql, {
					principalId,
					providerReleaseId: v8.providerReleaseId,
					scopes: ["repo"],
					actionVersionIds: v8.actions.slice(0, 6).map((action) => action.id),
				});
				const reused = await repository.getProviderCredentialForUpgrade({
					principalId,
					connectionId,
					allowCurrentRelease: true,
				});
				await expect(
					repository.storeProviderCredential({
						...upgrade,
						providerReleaseId: v8.providerReleaseId,
						expectedCredentialVersionId: reused.credentialVersionId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await repository.storeProviderCredential({
					...upgrade,
					accessToken: reused.accessToken,
					accessRequestId: expandedRequestId,
					providerReleaseId: v8.providerReleaseId,
					expectedCredentialVersionId: reused.credentialVersionId,
				});
				const [expanded] =
					await sql`SELECT access.source_request_id, count(member.action_version_id)::int AS count
					FROM connection_effective_access_authorizations access
					JOIN connection_capability_profile_actions member ON member.capability_profile_id = access.capability_profile_id
					WHERE access.connection_id = ${connectionId} AND access.state = 'ACTIVE' GROUP BY access.source_request_id`;
				expect(expanded).toEqual({
					source_request_id: expandedRequestId,
					count: 6,
				});
			} finally {
				await repository.close();
				await approval.close();
				await requests.close();
				await sql.end();
			}
		},
		30_000,
	);
});
