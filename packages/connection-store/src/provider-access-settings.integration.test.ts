import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { githubConnectionCatalog } from "@agent-infra/openconnector-adapter";
import postgres from "postgres";
import { expect, it } from "vitest";
import { PostgresConnectionAccessRequestRepository } from "./access-request-repository";
import { PostgresConnectionApprovalRepository } from "./approval-repository";
import { seedApprovedConnectPermit } from "./approved-connect-fixture";
import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionRepository } from "./repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_APPROVAL_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
const integrationTest = databaseUrl ? it : it.skip;

integrationTest(
	"defaults to direct connection and fences admissions when an administrator enables approval",
	async () => {
		if (!databaseUrl) return;
		await migrateConnectionDatabase(
			databaseUrl,
			resolve(import.meta.dirname, "../../../migrations/connection"),
		);
		const sql = postgres(databaseUrl);
		const repository = new PostgresConnectionRepository(
			databaseUrl,
			Buffer.alloc(32, 19),
		);
		const settings = new PostgresConnectionApprovalRepository(databaseUrl);
		const requests = new PostgresConnectionAccessRequestRepository(databaseUrl);
		const suffix = randomUUID();
		const providerId = `optional-${suffix}`;
		const principalId = `owner-${suffix}`;
		const otherId = `other-${suffix}`;
		const adminId = `admin-${suffix}`;
		const consumerId = `consumer-${suffix}`;
		const instanceId = `instance-${suffix}`;
		const baseAction = githubConnectionCatalog.actions[0];
		if (!baseAction) throw new Error("Missing Action fixture");
		const action = {
			...baseAction,
			id: `optional-read-${suffix}`,
			name: "optional.read",
			effect: "WRITE" as const,
			requiredScopes: ["repo"],
		};
		const catalog = {
			...githubConnectionCatalog,
			credentialUpgradeBehavior: "REAUTHORIZE" as const,
			provider: providerId,
			providerReleaseId: `optional-release-${suffix}`,
			actions: [
				action,
				{
					...action,
					id: `optional-admin-${suffix}`,
					name: "optional.admin",
					requiredScopes: ["admin"],
				},
			],
		};
		try {
			await repository.publishProviderCatalog(catalog);
			await sql`INSERT INTO connection_principals (id, display_name) VALUES (${principalId}, 'Owner'), (${otherId}, 'Other'), (${adminId}, 'Admin')`;
			await sql`INSERT INTO connection_principal_roles (principal_id, role, status, grant_source) VALUES (${adminId}, 'CONNECTION_ADMIN', 'ACTIVE', 'ADMIN')`;
			const [initial] = await settings.listProviderAccessSettings([providerId]);
			expect(initial).toEqual({
				providerId,
				approvalRequired: false,
				revision: "0",
			});
			await expect(
				settings.updateProviderAccessSettings({
					actorPrincipalId: principalId,
					providerId,
					approvalRequired: true,
					expectedRevision: "0",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				settings.updateProviderAccessSettings({
					actorPrincipalId: adminId,
					providerId: "unknown",
					approvalRequired: false,
					expectedRevision: "0",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				repository.validatePersonalConnectRequest({
					principalId: otherId,
					providerId: "unknown",
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			const start = await repository.validatePersonalConnectRequest({
				principalId,
				providerId,
			});
			expect(start.requiredScopes).toEqual(["admin", "repo"]);
			const identity = {
				accessToken: `test-only-${suffix}`,
				displayName: "Account",
				externalAccount: `external-${suffix}`,
				grantedScopes: ["repo"],
				principalId,
				providerId,
				providerReleaseId: catalog.providerReleaseId,
			};
			const { connectionId } =
				await repository.storeProviderCredential(identity);
			expect(
				await sql`SELECT id FROM connection_access_authorizations WHERE connection_id = ${connectionId}`,
			).toHaveLength(0);
			expect(
				await repository.getProviderUpgradeReadiness({
					principalId,
					connectionId,
				}),
			).toMatchObject({ nextAction: "NONE" });
			await repository.publishConsumerDeclaration({
				consumer: { id: consumerId, name: "Test consumer" },
				providerReleaseId: catalog.providerReleaseId,
				actionVersionIds: catalog.actions.map((item) => item.id),
			});
			await sql`INSERT INTO connection_consumer_instances (id, consumer_id, kind, auth_subject, status, principal_id) VALUES (${instanceId}, ${consumerId}, 'DEVICE', ${instanceId}, 'ACTIVE', ${principalId})`;
			await expect(
				repository.createCurrentConsumerAuthorizationPreview({
					principalId: otherId,
					consumerId,
					connectionId,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			const preview =
				await repository.createCurrentConsumerAuthorizationPreview({
					principalId,
					consumerId,
					connectionId,
				});
			expect(preview.actions.map((item) => item.id)).toEqual([action.id]);
			await repository.confirmCurrentConsumerAuthorization({
				principalId,
				previewId: preview.previewId,
				confirmationToken: preview.confirmationToken,
				idempotencyKey: randomUUID(),
			});
			const invocation = await repository.resolveDirectIdentity({
				principalId,
				consumerId,
				instanceId,
			});
			await repository.verifyInvocation({ ...invocation, action: action.name });
			const call = await repository.createCall({
				action: action.name,
				argsHash: suffix,
				input: {},
				invocation,
			});
			const enabled = await settings.updateProviderAccessSettings({
				actorPrincipalId: adminId,
				providerId,
				approvalRequired: true,
				expectedRevision: "0",
			});
			await expect(
				settings.updateProviderAccessSettings({
					actorPrincipalId: adminId,
					providerId,
					approvalRequired: false,
					expectedRevision: "0",
				}),
			).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
			await expect(
				repository.validatePersonalConnectRequest({ principalId, providerId }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			// An OAuth callback started before the switch must also fail at credential commit.
			await expect(
				repository.storeProviderCredential({
					...identity,
					externalAccount: `late-${suffix}`,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				repository.verifyInvocation({ ...invocation, action: action.name }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				repository.startDispatch({
					action: action.name,
					callId: call.call.callId,
					invocation,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				repository.confirmCurrentConsumerAuthorization({
					principalId,
					previewId: preview.previewId,
					confirmationToken: preview.confirmationToken,
					idempotencyKey: randomUUID(),
				}),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
			// Existing approval engine still grants and constrains an enabled Provider.
			const accessRequestId = await seedApprovedConnectPermit(sql, {
				principalId,
				providerReleaseId: catalog.providerReleaseId,
				scopes: ["repo"],
				actionVersionIds: [action.id],
			});
			await repository.storeProviderCredential({
				...identity,
				accessRequestId,
			});
			await expect(
				repository.storeProviderCredential({
					...identity,
					accessRequestId,
					externalAccount: `replay-${suffix}`,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			const [current] = await settings.listProviderAccessSettings([providerId]);
			if (!current) throw new Error("Missing Provider settings");
			const disabled = await settings.updateProviderAccessSettings({
				actorPrincipalId: adminId,
				providerId,
				approvalRequired: false,
				expectedRevision: current.revision,
			});
			expect(BigInt(disabled.revision)).toBeGreaterThan(
				BigInt(enabled.revision),
			);
			await sql`UPDATE connection_access_authorizations SET validity_kind = 'FINITE', valid_until = now() - interval '1 second', revision = revision + 1 WHERE connection_id = ${connectionId} AND state = 'ACTIVE'`;
			const [beforeExpiry] =
				await sql`SELECT revision::text FROM connection_accounts WHERE id = ${connectionId}`;
			await requests.expireDueAuthorizations(10000);
			const [afterExpiry] =
				await sql`SELECT revision::text FROM connection_accounts WHERE id = ${connectionId}`;
			expect(afterExpiry).toEqual(beforeExpiry);
			await repository.disconnectConnection({ principalId, connectionId });
			await expect(
				repository.validatePersonalReconnect({
					principalId: otherId,
					connectionId,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(
				await repository.validatePersonalReconnect({
					principalId,
					connectionId,
				}),
			).toMatchObject({ providerId, requiredScopes: ["repo"] });
			await repository.storeProviderCredential({
				...identity,
				expectedConnectionId: connectionId,
			});
			const audit =
				await sql`SELECT detail FROM connection_audit_records WHERE event = 'connection.provider-access-settings.changed' AND detail->>'providerId' = ${providerId}`;
			expect(audit).toHaveLength(2);
			expect(
				await sql`SELECT id FROM connection_outbox_events WHERE topic = 'connection.provider-access-settings.changed' AND payload->>'providerId' = ${providerId}`,
			).toHaveLength(2);
			// Shared admission locks prevent the switch overtaking a credential/dispatch transaction.
			let release!: () => void;
			let locked!: () => void;
			const barrier = new Promise<void>((resolve) => {
				locked = resolve;
			});
			const held = sql.begin(async (tx) => {
				await tx`SELECT connection_provider_requires_approval(${providerId})`;
				locked();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			});
			await barrier;
			let completed = false;
			const switchAttempt = settings
				.updateProviderAccessSettings({
					actorPrincipalId: adminId,
					providerId,
					approvalRequired: true,
					expectedRevision: disabled.revision,
				})
				.then((value) => {
					completed = true;
					return value;
				});
			await sql`SELECT pg_sleep(0.05)`;
			expect(completed).toBe(false);
			release();
			await held;
			const switched = await switchAttempt;
			await settings.updateProviderAccessSettings({
				actorPrincipalId: adminId,
				providerId,
				approvalRequired: false,
				expectedRevision: switched.revision,
			});
			const targetReleaseId = `${catalog.providerReleaseId}-v2`;
			await repository.publishProviderCatalog({
				...catalog,
				providerReleaseId: targetReleaseId,
				credentialUpgradeBehavior: "DIRECT",
				actions: catalog.actions.map((item) => ({
					...item,
					id: `${item.id}-v2`,
				})),
				upgradePaths: [
					{
						provider: providerId,
						fromReleaseId: catalog.providerReleaseId,
						toReleaseId: targetReleaseId,
						fromExecutorDigest: catalog.executorDigest,
						toExecutorDigest: catalog.executorDigest,
						strategy: "REAUTHORIZATION_REQUIRED",
						reviewReference: "test-only",
					},
				],
			});
			expect(
				await repository.getProviderUpgradeReadiness({
					principalId,
					connectionId,
				}),
			).toMatchObject({
				nextAction: "REAUTHORIZE",
				reason: "PROVIDER_REAUTHORIZATION_REQUIRED",
			});
		} finally {
			await sql`UPDATE connection_access_policy_versions SET status = 'SUPERSEDED', revision = revision + 1
				WHERE provider_release_id = ${catalog.providerReleaseId} AND status = 'PUBLISHED'`;
			await requests.close();
			await settings.close();
			await repository.close();
			await sql.end();
		}
	},
	30_000,
);
