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
			const oauthState = randomUUID();
			expect(
				await repository.createOAuthTransaction({
					principalId,
					providerId,
					state: oauthState,
					codeVerifier: "test-only-verifier",
					redirectUri: "https://callback.example.invalid/oauth",
					accessRequestId: "expired-or-consumed-old-request",
				}),
			).toEqual(start);
			expect(
				(await repository.consumeOAuthTransaction(oauthState, providerId))
					.accessRequestId,
			).toBeUndefined();
			expect(
				await repository.validatePersonalConnectRequest({
					principalId,
					providerId,
					requestId: "expired-or-consumed-old-request",
				}),
			).toEqual(start);
			const identity = {
				accessToken: `test-only-${suffix}`,
				displayName: "Account",
				externalAccount: `external-${suffix}`,
				grantedScopes: ["repo"],
				principalId,
				providerId,
				providerReleaseId: catalog.providerReleaseId,
			};
			const { connectionId } = await repository.storeProviderCredential({
				...identity,
				accessRequestId: "expired-or-consumed-old-request",
			});
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
			expect(preview.actions.map((item) => item.id).sort()).toEqual(
				catalog.actions.map((item) => item.id).sort(),
			);
			const selectedPreview =
				await repository.createCurrentConsumerAuthorizationPreview({
					principalId,
					consumerId,
					connectionId,
					actionVersionIds: [action.id],
				});
			await repository.confirmCurrentConsumerAuthorization({
				principalId,
				previewId: selectedPreview.previewId,
				confirmationToken: selectedPreview.confirmationToken,
				idempotencyKey: randomUUID(),
			});
			const affectedConsumer = `${consumerId}-affected`;
			await repository.publishConsumerDeclaration({
				consumer: { id: affectedConsumer, name: "Affected client" },
				providerReleaseId: catalog.providerReleaseId,
				actionVersionIds: catalog.actions.map((item) => item.id),
			});
			await sql`INSERT INTO connection_consumer_instances(id,consumer_id,kind,auth_subject,status,principal_id) VALUES(${`${instanceId}-affected`},${affectedConsumer},'DEVICE',${`${instanceId}-affected`},'ACTIVE',${principalId})`;
			const affected =
				await repository.createCurrentConsumerAuthorizationPreview({
					principalId,
					connectionId,
					consumerId: affectedConsumer,
					actionVersionIds: [catalog.actions[1]!.id],
				});
			await repository.confirmCurrentConsumerAuthorization({
				principalId,
				previewId: affected.previewId,
				confirmationToken: affected.confirmationToken,
				idempotencyKey: randomUUID(),
			});
			const saved = await repository.getProviderCredentialForUpgrade({
				principalId,
				connectionId,
				allowCurrentRelease: true,
				refreshPermissions: true,
			});
			await expect(
				repository.getProviderCredentialForUpgrade({
					principalId: otherId,
					connectionId,
					allowCurrentRelease: true,
					refreshPermissions: true,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			const refreshed = await repository.storeProviderCredential({
				...identity,
				grantedScopes: ["repo", "admin"],
				refreshPermissions: true,
				expectedConnectionId: connectionId,
				expectedCredentialVersionId: saved.credentialVersionId,
			});
			expect(refreshed.connectionId).toBe(connectionId);
			await expect(
				repository.storeProviderCredential({
					...identity,
					grantedScopes: ["repo", "admin"],
					refreshPermissions: true,
					expectedConnectionId: connectionId,
					expectedCredentialVersionId: saved.credentialVersionId,
				}),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
			const expandedPreview =
				await repository.createCurrentConsumerAuthorizationPreview({
					principalId,
					consumerId,
					connectionId,
				});
			expect(expandedPreview.actions.map((item) => item.id).sort()).toEqual(
				catalog.actions.map((item) => item.id).sort(),
			);
			const grantMembers = await sql<
				{ action_version_id: string }[]
			>`SELECT member.action_version_id FROM connection_grant_actions member JOIN connection_authorization_roots root ON root.current_grant_id=member.grant_id WHERE root.principal_id=${principalId} AND root.consumer_id=${consumerId}`;
			expect(grantMembers.map((item) => item.action_version_id)).toEqual([
				action.id,
			]);
			const unchanged = await repository.resolveDirectIdentity({
				principalId,
				consumerId,
				instanceId,
			});
			await repository.verifyInvocation({ ...unchanged, action: action.name });
			await expect(
				repository.verifyInvocation({ ...unchanged, action: "optional.admin" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });

			await repository.storeProviderCredential(identity);
			await repository.resolveDirectIdentity({
				principalId,
				consumerId,
				instanceId,
			});
			const retained = await repository.resolveDirectIdentity({
				principalId,
				consumerId: affectedConsumer,
				instanceId: `${instanceId}-affected`,
			});
			await repository.verifyInvocation({
				...retained,
				action: "optional.admin",
			});
			const [retainedConsent] = await sql<{ consent_reused: boolean }[]>`
				SELECT grant_version.consent_id = original.consent_id AS consent_reused
				FROM connection_grants grant_version JOIN connection_authorization_previews preview ON preview.id = ${affected.previewId}
				JOIN connection_grants original ON original.id = preview.confirmed_grant_id
				WHERE grant_version.id = ${retained.grantId}`;
			expect(retainedConsent?.consent_reused).toBe(true);
			const reconfirm =
				await repository.createCurrentConsumerAuthorizationPreview({
					principalId,
					consumerId,
					connectionId,
					actionVersionIds: [action.id],
				});
			await repository.confirmCurrentConsumerAuthorization({
				principalId,
				previewId: reconfirm.previewId,
				confirmationToken: reconfirm.confirmationToken,
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
				repository.getProviderCredentialForUpgrade({
					principalId,
					connectionId,
					allowCurrentRelease: true,
					refreshPermissions: true,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			const currentCredential =
				await repository.getProviderCredentialForUpgrade({
					principalId,
					connectionId,
					allowCurrentRelease: true,
				});
			await expect(
				repository.storeProviderCredential({
					...identity,
					refreshPermissions: true,
					expectedConnectionId: connectionId,
					expectedCredentialVersionId: currentCredential.credentialVersionId,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
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
			).rejects.toMatchObject({ code: "FORBIDDEN" });
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
			await repository.disconnectConnection({ principalId, connectionId });
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

integrationTest(
	"serializes a settings change and credential save for the same administrator without deadlock",
	async () => {
		if (!databaseUrl) return;
		await migrateConnectionDatabase(
			databaseUrl,
			resolve(import.meta.dirname, "../../../migrations/connection"),
		);
		const sql = postgres(databaseUrl);
		const repository = new PostgresConnectionRepository(
			databaseUrl,
			Buffer.alloc(32, 20),
		);
		const settings = new PostgresConnectionApprovalRepository(databaseUrl);
		const suffix = randomUUID();
		const providerId = `lock-provider-${suffix}`;
		const adminId = `lock-admin-${suffix}`;
		const baseAction = githubConnectionCatalog.actions[0];
		if (!baseAction) throw new Error("Missing Action fixture");
		const catalog = {
			...githubConnectionCatalog,
			provider: providerId,
			providerReleaseId: `lock-release-${suffix}`,
			actions: [
				{
					...baseAction,
					id: `lock-action-${suffix}`,
					requiredScopes: ["repo"],
				},
			],
		};
		let releasePrincipal: (() => void) | undefined;
		let holder: Promise<unknown> | undefined;
		try {
			await repository.publishProviderCatalog(catalog);
			await sql`INSERT INTO connection_principals (id, display_name) VALUES (${adminId}, 'Admin')`;
			await sql`INSERT INTO connection_principal_roles (principal_id, role, status, grant_source) VALUES (${adminId}, 'CONNECTION_ADMIN', 'ACTIVE', 'ADMIN')`;
			let signalLocked!: () => void;
			const locked = new Promise<void>((resolve) => {
				signalLocked = resolve;
			});
			holder = sql.begin(async (tx) => {
				await tx`SELECT id FROM connection_principals WHERE id = ${adminId} FOR UPDATE`;
				signalLocked();
				await new Promise<void>((resolve) => {
					releasePrincipal = resolve;
				});
			});
			await locked;
			const switchAttempt = settings.updateProviderAccessSettings({
				actorPrincipalId: adminId,
				providerId,
				approvalRequired: false,
				expectedRevision: "0",
			});
			// Observe real lock waits rather than assuming timer order. With the old order,
			// the setting owns Principal SHARE once released, while the save owns enforcement SHARE.
			const waitForLocks = async (count: number, actorOnly = false) => {
				const deadline = Date.now() + 5000;
				while (Date.now() < deadline) {
					const [waiting] = await sql<
						{ count: string }[]
					>`SELECT count(*)::text FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
            AND (NOT ${actorOnly} OR query LIKE '%JOIN connection_principal_roles role_binding%')`;
					if (Number(waiting?.count) >= count) return;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				throw new Error("Expected concurrent database lock waits");
			};
			await waitForLocks(1, true);
			const credentialAttempt = repository.storeProviderCredential({
				accessToken: `test-only-lock-${suffix}`,
				displayName: "Admin account",
				externalAccount: suffix,
				grantedScopes: ["repo"],
				principalId: adminId,
				providerId,
				providerReleaseId: catalog.providerReleaseId,
			});
			await waitForLocks(2);
			releasePrincipal?.();
			await holder;
			const [updated, stored] = await Promise.all([
				switchAttempt,
				credentialAttempt,
			]);
			expect(updated.approvalRequired).toBe(false);
			expect(
				(await repository.getOverview(adminId)).connections.some(
					(connection) => connection.id === stored.connectionId,
				),
			).toBe(true);
			await repository.disconnectConnection({
				principalId: adminId,
				connectionId: stored.connectionId,
			});
		} finally {
			releasePrincipal?.();
			await holder;
			await settings.close();
			await repository.close();
			await sql.end();
		}
	},
	15_000,
);

integrationTest(
	"detects only new catalog names relative to Consent and stops prompting after fresh confirmation",
	async () => {
		if (!databaseUrl) return;
		await migrateConnectionDatabase(
			databaseUrl,
			resolve(import.meta.dirname, "../../../migrations/connection"),
		);
		const sql = postgres(databaseUrl);
		const repo = new PostgresConnectionRepository(
			databaseUrl,
			Buffer.alloc(32, 19),
		);
		const suffix = randomUUID();
		const principalId = `delta-owner-${suffix}`;
		const consumerId = `delta-consumer-${suffix}`;
		const providerId = `delta-provider-${suffix}`;
		const template = githubConnectionCatalog.actions[0];
		if (!template) throw new Error("Missing Action fixture");
		const oldActions = ["selected", "cancelled"].map((name) => ({
			...template,
			id: `${name}-${suffix}`,
			name: `delta.${name}`,
			requiredScopes: ["read"],
		}));
		const source = {
			...githubConnectionCatalog,
			provider: providerId,
			providerReleaseId: `delta-source-${suffix}`,
			actions: oldActions,
		};
		const added = {
			...template,
			id: `new-${suffix}`,
			name: "delta.new",
			requiredScopes: ["extra"],
		};
		const target = {
			...source,
			providerReleaseId: `delta-target-${suffix}`,
			actions: [
				...oldActions.map((a) => ({ ...a, id: `${a.id}-target` })),
				added,
			],
		};
		try {
			await repo.publishProviderCatalog(source);
			await sql`INSERT INTO connection_principals(id,display_name) VALUES(${principalId},'Delta owner')`;
			const identity = {
				principalId,
				providerId,
				providerReleaseId: source.providerReleaseId,
				externalAccount: `delta-account-${suffix}`,
				displayName: "Delta",
				accessToken: "delta-fixture-only",
				grantedScopes: ["read"],
			};
			const { connectionId } = await repo.storeProviderCredential(identity);
			await repo.publishConsumerDeclaration({
				consumer: { id: consumerId, name: "Delta client" },
				providerReleaseId: source.providerReleaseId,
				actionVersionIds: oldActions.map((a) => a.id),
			});
			await sql`INSERT INTO connection_consumer_instances(id,consumer_id,kind,auth_subject,status,principal_id) VALUES(${`delta-instance-${suffix}`},${consumerId},'DEVICE',${`delta-instance-${suffix}`},'ACTIVE',${principalId})`;
			const preview = await repo.createCurrentConsumerAuthorizationPreview({
				principalId,
				connectionId,
				consumerId,
				actionVersionIds: [oldActions[0]!.id],
			});
			await repo.confirmCurrentConsumerAuthorization({
				principalId,
				previewId: preview.previewId,
				confirmationToken: preview.confirmationToken,
				idempotencyKey: randomUUID(),
			});
			await repo.publishProviderCatalog(target);
			await repo.publishConsumerDeclaration({
				consumer: { id: consumerId, name: "Delta client" },
				providerReleaseId: target.providerReleaseId,
				actionVersionIds: target.actions.map((a) => a.id),
			});
			await repo.storeProviderCredential({
				...identity,
				providerReleaseId: target.providerReleaseId,
				grantedScopes: ["read", "extra"],
			});
			const before = await repo.getOverview(principalId);
			expect(before.grants[0]?.newActionVersionIds).toEqual([added.id]);
			const selection = await repo.createCurrentConsumerAuthorizationPreview({
				principalId,
				connectionId,
				consumerId,
				actionVersionIds: [target.actions[0]!.id],
			});
			await repo.confirmCurrentConsumerAuthorization({
				principalId,
				previewId: selection.previewId,
				confirmationToken: selection.confirmationToken,
				idempotencyKey: randomUUID(),
			});
			const after = await repo.getOverview(principalId);
			expect(
				after.grants.find((g) => g.status === "ACTIVE")?.newActionVersionIds,
			).toEqual([]);
			expect(
				after.grants.find((g) => g.status === "ACTIVE")?.actionVersionIds,
			).toEqual([target.actions[0]!.id]);
			await repo.disconnectConnection({ principalId, connectionId });
		} finally {
			await repo.close();
			await sql.end();
		}
	},
);
