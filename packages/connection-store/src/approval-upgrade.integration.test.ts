import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { canonicalHash } from "@agent-infra/connection-core";
import { githubConnectionCatalog } from "@agent-infra/openconnector-adapter";
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
	(databaseUrl ? it : it.skip)(
		"maps only five approved Actions from ten to twelve, retaining validity and original revocation",
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
				await repository.publishProviderCatalog(catalog(8, 12));
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
				] as const) {
					const target = catalog(7, 12);
					target.providerReleaseId += `-${change}`;
					target.actions = target.actions.map((action) => ({
						...action,
						id: `${action.id}-${change}`,
					}));
					if (change === "executor")
						target.executorDigest = `sha256:${"0".repeat(64)}`;
					if (change === "auth")
						target.authProfile = { ...target.authProfile, expanded: true };
					if (change === "deployment")
						target.deploymentProfile = {
							...target.deploymentProfile,
							expanded: true,
						};
					if (change === "missing") target.actions = target.actions.slice(1);
					const first = target.actions[0];
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
