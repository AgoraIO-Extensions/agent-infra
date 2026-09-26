import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { githubConnectionCatalog } from "@agent-infra/openconnector-adapter";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresConnectionAccessRequestRepository } from "./access-request-repository";
import { PostgresConnectionApprovalRepository } from "./approval-repository";
import { seedApprovedConnectPermit } from "./approved-connect-fixture";
import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionRepository } from "./repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_RECONNECT_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl) {
	throw new Error("CONNECTION_RECONNECT_TEST_DATABASE_URL is required in CI");
}
const integrationTest = databaseUrl ? it : it.skip;

describe("approved personal Connection reconnect", () => {
	integrationTest(
		"reconnects only the same account and exact credential scopes while valid",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const principalId = `reconnect-principal-${randomUUID()}`;
			const repository = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 23),
			);
			const approval = new PostgresConnectionApprovalRepository(databaseUrl);
			const access = new PostgresConnectionAccessRequestRepository(databaseUrl);
			const sql = postgres(databaseUrl);
			try {
				await repository.publishProviderCatalog(githubConnectionCatalog);
				await sql`INSERT INTO connection_principals (id, display_name) VALUES (${principalId}, 'Reconnect owner')`;
				await sql`
				INSERT INTO connection_principal_roles (principal_id, role, status, grant_source)
				VALUES (${principalId}, 'CONNECTION_ADMIN', 'ACTIVE', 'BOOTSTRAP')
			`;
				const connected = await repository.storeGithubOAuthCredential({
					accessRequestId: await seedApprovedConnectPermit(sql, {
						principalId,
						providerReleaseId: githubConnectionCatalog.providerReleaseId,
						scopes: ["repo"],
					}),
					accessToken: "fixture-token-first",
					displayName: "Existing GitHub",
					externalAccount: "stable-github-uid",
					grantedScopes: ["repo"],
					principalId,
				});
				expect(await approval.activatePreLaunchBaseline(principalId)).toEqual({
					baselinedConnections: 0,
				});
				await repository.disconnectConnection({
					connectionId: connected.connectionId,
					principalId,
				});
				expect(
					await repository.validatePersonalReconnect({
						connectionId: connected.connectionId,
						principalId,
					}),
				).toEqual({ providerId: "github" });
				const reconnected = await repository.storeGithubOAuthCredential({
					accessToken: "fixture-token-second",
					displayName: "Existing GitHub",
					externalAccount: "stable-github-uid",
					grantedScopes: ["repo"],
					principalId,
					expectedConnectionId: connected.connectionId,
				});
				expect(reconnected.connectionId).toBe(connected.connectionId);
				const [state] = await sql<
					{
						account_status: string;
						authorization_state: string;
						active_credentials: number;
					}[]
				>`
				SELECT account.status AS account_status, access.state AS authorization_state,
					(SELECT count(*)::int FROM connection_credential_versions credential
					 WHERE credential.connection_id = account.id AND credential.status = 'ACTIVE') AS active_credentials
				FROM connection_accounts account
				JOIN connection_access_authorizations access ON access.connection_id = account.id
				WHERE account.id = ${connected.connectionId}
			`;
				expect(state).toEqual({
					account_status: "ACTIVE",
					authorization_state: "ACTIVE",
					active_credentials: 1,
				});
				await expect(
					repository.storeGithubOAuthCredential({
						accessToken: "fixture-wrong-account",
						displayName: "Different GitHub",
						externalAccount: "different-github-uid",
						grantedScopes: ["repo"],
						principalId,
						expectedConnectionId: connected.connectionId,
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				const [currentCredential] = await sql<{ id: string }[]>`
				SELECT id FROM connection_credential_versions
				WHERE connection_id = ${connected.connectionId} AND status = 'ACTIVE'
			`;
				await expect(
					repository.storeGithubOAuthCredential({
						accessToken: "fixture-wider-token",
						displayName: "Existing GitHub",
						externalAccount: "stable-github-uid",
						grantedScopes: ["repo", "user"],
						principalId,
						expectedConnectionId: connected.connectionId,
						expectedCredentialVersionId: currentCredential?.id,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const nextReleaseId = `github-approval-upgrade-${randomUUID()}`;
				await repository.publishProviderCatalog({
					...githubConnectionCatalog,
					providerReleaseId: nextReleaseId,
					actions: githubConnectionCatalog.actions.map((action) => ({
						...action,
						id: `${action.id}-${nextReleaseId}`,
					})),
				});
				const [beforeUpgrade] = await sql`
					SELECT account.provider_release_id, account.revision, account.execution_fence,
						credential.id AS credential_id, access.id AS access_id, access.state AS access_state,
						access.provider_release_id AS approved_release_id
					FROM connection_accounts account
					JOIN connection_credential_versions credential ON credential.connection_id = account.id AND credential.status = 'ACTIVE'
					JOIN connection_access_authorizations access ON access.connection_id = account.id
					WHERE account.id = ${connected.connectionId}
				`;
				await expect(
					repository.storeProviderCredential({
						accessToken: "fixture-unapproved-upgrade",
						displayName: "Existing GitHub",
						externalAccount: "stable-github-uid",
						grantedScopes: ["repo"],
						principalId,
						providerId: "github",
						providerReleaseId: nextReleaseId,
						expectedConnectionId: connected.connectionId,
						expectedCredentialVersionId: currentCredential?.id,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const [afterUpgrade] = await sql`
					SELECT account.provider_release_id, account.revision, account.execution_fence,
						credential.id AS credential_id, access.id AS access_id, access.state AS access_state,
						access.provider_release_id AS approved_release_id
					FROM connection_accounts account
					JOIN connection_credential_versions credential ON credential.connection_id = account.id AND credential.status = 'ACTIVE'
					JOIN connection_access_authorizations access ON access.connection_id = account.id
					WHERE account.id = ${connected.connectionId}
				`;
				expect(afterUpgrade).toEqual(beforeUpgrade);
				await repository.storeProviderCredential({
					accessRequestId: await seedApprovedConnectPermit(sql, {
						principalId,
						providerReleaseId: nextReleaseId,
						scopes: ["repo"],
					}),
					accessToken: "fixture-approved-upgrade",
					displayName: "Existing GitHub",
					externalAccount: "stable-github-uid",
					grantedScopes: ["repo"],
					principalId,
					providerId: "github",
					providerReleaseId: nextReleaseId,
					expectedConnectionId: connected.connectionId,
					expectedCredentialVersionId: currentCredential?.id,
				});
				const [approvedUpgrade] = await sql`
					SELECT account.provider_release_id, access.provider_release_id AS approved_release_id,
						(SELECT state FROM connection_access_authorizations WHERE id = ${beforeUpgrade?.access_id}) AS prior_state
					FROM connection_accounts account
					JOIN connection_access_authorizations access ON access.connection_id = account.id AND access.state = 'ACTIVE'
					WHERE account.id = ${connected.connectionId}
				`;
				expect(approvedUpgrade).toEqual({
					provider_release_id: nextReleaseId,
					approved_release_id: nextReleaseId,
					prior_state: "REVOKED",
				});
				const [accounts] = await sql<{ count: number }[]>`
				SELECT count(*)::int AS count FROM connection_accounts
				WHERE owner_principal_id = ${principalId}
			`;
				expect(accounts?.count).toBe(1);
				await repository.disconnectConnection({
					connectionId: connected.connectionId,
					principalId,
				});
				await sql`
				UPDATE connection_access_authorizations
				SET validity_kind = 'FINITE', valid_until = now() - interval '1 second'
				WHERE connection_id = ${connected.connectionId}
			`;
				expect(await access.expireDueAuthorizations()).toBe(1);
				expect(await access.expireDueAuthorizations()).toBe(0);
				const [expiry] = await sql`
					SELECT access_record.state, account.status,
						(SELECT count(*)::int FROM connection_notifications WHERE business_id = access_record.id AND event_type = 'EXPIRED') AS notifications
					FROM connection_access_authorizations access_record
					JOIN connection_accounts account ON account.id = access_record.connection_id
					WHERE account.id = ${connected.connectionId} AND access_record.provider_release_id = ${nextReleaseId}
				`;
				expect(expiry).toEqual({
					state: "EXPIRED",
					status: "DISCONNECTED",
					notifications: 1,
				});
				await expect(
					repository.validatePersonalReconnect({
						connectionId: connected.connectionId,
						principalId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(
					repository.validatePersonalReconnect({
						connectionId: connected.connectionId,
						principalId: "another-principal",
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				for (const authorizationState of [
					"SUSPENDED",
					"REAPPROVAL_REQUIRED",
				] as const) {
					const requestId = await seedApprovedConnectPermit(sql, {
						principalId,
						providerReleaseId: nextReleaseId,
						scopes: ["repo"],
					});
					const externalAccount = `restricted-${authorizationState}-${randomUUID()}`;
					const restricted = await repository.storeProviderCredential({
						accessRequestId: requestId,
						accessToken: "fixture-restricted-token",
						displayName: "Restricted account",
						externalAccount,
						grantedScopes: ["repo"],
						principalId,
						providerId: "github",
						providerReleaseId: nextReleaseId,
					});
					if (authorizationState === "SUSPENDED") {
						const [policy] = await sql<{ id: string; revision: string }[]>`
							SELECT policy.id, policy.revision::text FROM connection_access_policy_versions policy
							JOIN connection_access_requests request ON request.policy_version_id = policy.id WHERE request.id = ${requestId}
						`;
						if (!policy) throw new Error("Policy fixture is missing");
						await approval.revokePolicy({
							actorPrincipalId: principalId,
							policyVersionId: policy.id,
							expectedRevision: policy.revision,
							reason: "Security revocation",
						});
					} else {
						await sql`UPDATE connection_access_authorizations SET state = 'REAPPROVAL_REQUIRED', reapproval_deadline_at = now() + interval '1 day' WHERE connection_id = ${restricted.connectionId}`;
					}
					await repository.disconnectConnection({
						connectionId: restricted.connectionId,
						principalId,
					});
					const [preserved] = await sql<
						{ state: string }[]
					>`SELECT state FROM connection_access_authorizations WHERE connection_id = ${restricted.connectionId}`;
					expect(preserved?.state).toBe(authorizationState);
					await expect(
						repository.validatePersonalReconnect({
							connectionId: restricted.connectionId,
							principalId,
						}),
					).rejects.toMatchObject({ code: "FORBIDDEN" });
					await expect(
						repository.storeProviderCredential({
							accessToken: "fixture-reconnect-rejected",
							displayName: "Restricted account",
							externalAccount,
							grantedScopes: ["repo"],
							principalId,
							providerId: "github",
							providerReleaseId: nextReleaseId,
							expectedConnectionId: restricted.connectionId,
						}),
					).rejects.toMatchObject({ code: "FORBIDDEN" });
				}
			} finally {
				await repository.close();
				await approval.close();
				await access.close();
				await sql.end();
			}
		},
		30_000,
	);
});
