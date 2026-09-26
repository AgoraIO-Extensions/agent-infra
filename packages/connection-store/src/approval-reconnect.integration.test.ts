import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { githubConnectionCatalog } from "@agent-infra/openconnector-adapter";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresConnectionApprovalRepository } from "./approval-repository";
import { seedApprovedConnectPermit } from "./approved-connect-fixture";
import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionRepository } from "./repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_RECONNECT_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
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
			} finally {
				await repository.close();
				await approval.close();
				await sql.end();
			}
		},
		30_000,
	);
});
