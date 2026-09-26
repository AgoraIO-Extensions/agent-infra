import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { canonicalHash } from "@agent-infra/connection-core";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresConnectionAccessRequestRepository } from "./access-request-repository";
import {
	type ApprovalPolicyDraft,
	PostgresConnectionApprovalRepository,
} from "./approval-repository";
import { seedApprovedConnectPermit } from "./approved-connect-fixture";
import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionNotificationDispatcher } from "./notification-dispatcher";
import { PostgresConnectionRepository } from "./repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_APPROVAL_TEST_DATABASE_URL;
const materialDatabaseUrl =
	process.env.CONNECTION_POLICY_LIFECYCLE_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
assertIsolatedTestDatabaseUrl(materialDatabaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl) {
	throw new Error("CONNECTION_APPROVAL_TEST_DATABASE_URL is required in CI");
}
if (process.env.CI && !materialDatabaseUrl) {
	throw new Error(
		"CONNECTION_POLICY_LIFECYCLE_TEST_DATABASE_URL is required in CI",
	);
}
const integrationTest = databaseUrl ? it : it.skip;
const materialTest = materialDatabaseUrl ? it : it.skip;

describe("PostgreSQL Connection access approval catalog", () => {
	materialTest(
		"publishes material policy replacement and reapproval atomically",
		async () => {
			if (!materialDatabaseUrl) return;
			await migrateConnectionDatabase(
				materialDatabaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const suffix = randomUUID();
			const adminId = `material-admin-${suffix}`;
			const applicantId = `material-applicant-${suffix}`;
			const disconnectedId = `material-disconnected-${suffix}`;
			const approverId = `material-approver-${suffix}`;
			const releaseId = `material-release-${suffix}`;
			const actionId = `material.read@${suffix}`;
			const connectionId = `material-connection-${suffix}`;
			const authorizationId = `material-access-${suffix}`;
			const disconnectedConnectionId = `material-disconnected-connection-${suffix}`;
			const disconnectedAuthorizationId = `material-disconnected-access-${suffix}`;
			const disconnectedRequestId = `material-disconnected-request-${suffix}`;
			const disclaimerId = `material-disclaimer-${suffix}`;
			const nextPolicyId = `material-policy-${suffix}`;
			const sql = postgres(materialDatabaseUrl);
			const catalog = new PostgresConnectionApprovalRepository(
				materialDatabaseUrl,
			);
			const requests = new PostgresConnectionAccessRequestRepository(
				materialDatabaseUrl,
			);
			try {
				await sql`
				INSERT INTO connection_principals (id, display_name)
				VALUES (${adminId}, 'Admin'), (${applicantId}, 'Applicant'),
					(${disconnectedId}, 'Disconnected owner'), (${approverId}, 'Approver')
			`;
				await sql`
				INSERT INTO connection_principal_roles (principal_id, role, status, grant_source)
				VALUES (${adminId}, 'CONNECTION_ADMIN', 'ACTIVE', 'ADMIN')
			`;
				await sql`
				INSERT INTO connection_provider_releases (
					id, provider, source_commit, deployment_profile, auth_profile,
					executor_digest, catalog_checksum, status
				) VALUES (
					${releaseId}, ${`material-provider-${suffix}`}, ${suffix},
					'{}'::jsonb, '{}'::jsonb, ${`sha256:${"a".repeat(64)}`},
					${`connection-json-v1:${"b".repeat(64)}`}, 'PUBLISHED'
				)
			`;
				await sql`
				INSERT INTO connection_action_versions (
					id, provider_release_id, name, description, effect,
					input_schema, required_scopes, status
				) VALUES (
					${actionId}, ${releaseId}, 'material.read', 'Read', 'READ',
					'{"type":"object","required":[]}'::jsonb,
					'["material.read"]'::jsonb, 'PUBLISHED'
				)
			`;
				const requestId = await seedApprovedConnectPermit(sql, {
					principalId: applicantId,
					providerReleaseId: releaseId,
					scopes: ["material.read"],
				});
				const [original] = await sql<
					{ capability_profile_id: string; policy_version_id: string }[]
				>`
				SELECT capability_profile_id, policy_version_id FROM connection_access_requests
				WHERE id = ${requestId}
			`;
				if (!original) throw new Error("Material policy fixture is missing");
				await sql`
				INSERT INTO connection_accounts (
					id, owner_type, owner_principal_id, provider_release_id,
					provider_id, external_account, display_name, status
				) VALUES (
					${connectionId}, 'PERSONAL', ${applicantId}, ${releaseId},
					${`material-provider-${suffix}`}, 'stable-account', 'Material account', 'ACTIVE'
				)
			`;
				await sql`
				INSERT INTO connection_credential_versions (
					id, connection_id, ciphertext, nonce, tag, scope_json, status
				) VALUES (
					${`material-credential-${suffix}`}, ${connectionId},
					'fixture', 'fixture', 'fixture', '["material.read"]'::jsonb, 'ACTIVE'
				)
			`;
				await requests.consumeConnectPermit({
					accessAuthorizationId: authorizationId,
					connectionId,
					grantedScopes: ["material.read"],
					principalId: applicantId,
					requestId,
				});
				await sql`
					INSERT INTO connection_accounts (
						id, owner_type, owner_principal_id, provider_release_id,
						provider_id, external_account, display_name, status
					) VALUES (
						${disconnectedConnectionId}, 'PERSONAL', ${disconnectedId}, ${releaseId},
						${`material-provider-${suffix}`}, 'disconnected-account', 'Disconnected', 'DISCONNECTED'
					)
				`;
				await sql`
					INSERT INTO connection_access_requests (
						id, applicant_principal_id, provider_release_id, capability_profile_id,
						policy_version_id, purpose, duration_kind, state, expires_at
					) VALUES (
						${disconnectedRequestId}, ${disconnectedId}, ${releaseId},
						${original.capability_profile_id}, ${original.policy_version_id},
						'Previously approved account', 'PERMANENT', 'CONSUMED',
						now() + interval '1 day'
					)
				`;
				await sql`
					INSERT INTO connection_access_authorizations (
						id, principal_id, connection_id, provider_release_id,
						capability_profile_id, source, source_request_id,
						external_account_fingerprint, state, validity_kind
					) VALUES (
						${disconnectedAuthorizationId}, ${disconnectedId}, ${disconnectedConnectionId},
						${releaseId}, ${original.capability_profile_id}, 'APPROVED_REQUEST',
						${disconnectedRequestId}, ${canonicalHash({
							externalAccount: "disconnected-account",
							providerReleaseId: releaseId,
						})}, 'DISCONNECTED', 'PERMANENT'
					)
				`;
				await catalog.createDisclaimerDraft({
					content: "Material data-use change",
					id: disclaimerId,
					kind: "GLOBAL",
					locale: "zh-CN",
					materialChange: true,
					ownerMetadata: { owner: "integration" },
				});
				await catalog.publishDisclaimer({
					actorPrincipalId: adminId,
					disclaimerVersionId: disclaimerId,
				});
				await catalog.createPolicyDraft({
					allowPermanent: true,
					capabilityProfileId: original.capability_profile_id,
					connectTtlSeconds: 604_800,
					createdByPrincipalId: adminId,
					defaultDurationDays: 90,
					disclaimerVersionIds: [disclaimerId],
					durations: [
						{ days: 90, id: `material-duration-${suffix}`, kind: "FINITE" },
						{ id: `material-permanent-${suffix}`, kind: "PERMANENT" },
					],
					id: nextPolicyId,
					priority: 100,
					providerReleaseId: releaseId,
					renewalLeadSeconds: 1_209_600,
					requestTtlSeconds: 1_209_600,
					stages: [
						{
							approvers: [
								{
									principalId: approverId,
									displaySnapshot: { displayName: "Approver" },
								},
							],
							id: `material-stage-${suffix}`,
							name: "Security",
							quorumType: "ANY",
							timeoutSeconds: 259_200,
						},
					],
				});
				await expect(
					catalog.publishPolicy({
						actorPrincipalId: adminId,
						policyVersionId: nextPolicyId,
						materialChange: false,
					}),
				).rejects.toThrow("Material disclaimer requires reapproval");
				await expect(
					catalog.publishPolicy({
						actorPrincipalId: adminId,
						policyVersionId: nextPolicyId,
						materialChange: true,
						reason: "Data-use change",
						reapprovalDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
					}),
				).rejects.toThrow("Reapproval trigger is unavailable");
				const [before] = await sql<
					{
						access_state: string;
						current_status: string;
						draft_status: string;
					}[]
				>`
				SELECT access.state AS access_state, current.status AS current_status,
					draft.status AS draft_status
				FROM connection_access_authorizations access
				JOIN connection_access_policy_versions current ON current.id = ${original.policy_version_id}
				JOIN connection_access_policy_versions draft ON draft.id = ${nextPolicyId}
				WHERE access.id = ${authorizationId}
			`;
				expect(before).toEqual({
					access_state: "ACTIVE",
					current_status: "PUBLISHED",
					draft_status: "DRAFT",
				});
				const deadline = new Date(Date.now() + 2 * 86_400_000).toISOString();
				await catalog.publishPolicy({
					actorPrincipalId: adminId,
					policyVersionId: nextPolicyId,
					materialChange: true,
					reason: "Data-use change",
					reapprovalDeadlineAt: deadline,
				});
				const [after] = await sql<
					{
						access_state: string;
						campaign_count: number;
						current_status: string;
						draft_status: string;
						material_change: boolean;
						work_count: number;
					}[]
				>`
				SELECT access.state AS access_state, current.status AS current_status,
					draft.status AS draft_status, draft.material_change,
					(SELECT count(*)::int FROM connection_access_reapproval_campaigns
					 WHERE trigger_version_id = ${nextPolicyId}) AS campaign_count,
					(SELECT count(*)::int FROM connection_work_items
					 WHERE business_id = ${authorizationId} AND status = 'OPEN') AS work_count
				FROM connection_access_authorizations access
				JOIN connection_access_policy_versions current ON current.id = ${original.policy_version_id}
				JOIN connection_access_policy_versions draft ON draft.id = ${nextPolicyId}
				WHERE access.id = ${authorizationId}
			`;
				expect(after).toEqual({
					access_state: "REAPPROVAL_REQUIRED",
					campaign_count: 1,
					current_status: "SUPERSEDED",
					draft_status: "PUBLISHED",
					material_change: true,
					work_count: 1,
				});
				const [disconnectedReapproval] = await sql<
					{
						state: string;
						work_count: number;
					}[]
				>`
					SELECT access.state,
						(SELECT count(*)::int FROM connection_work_items item
						 WHERE item.business_id = access.id AND item.status = 'OPEN') AS work_count
					FROM connection_access_authorizations access
					WHERE access.id = ${disconnectedAuthorizationId}
				`;
				expect(disconnectedReapproval).toEqual({
					state: "REAPPROVAL_REQUIRED",
					work_count: 1,
				});
				const minorPolicyId = `minor-policy-${suffix}`;
				await catalog.createPolicyDraft({
					allowPermanent: true,
					capabilityProfileId: original.capability_profile_id,
					connectTtlSeconds: 604_800,
					createdByPrincipalId: adminId,
					defaultDurationDays: 90,
					disclaimerVersionIds: [disclaimerId],
					durations: [
						{ days: 90, id: `minor-duration-${suffix}`, kind: "FINITE" },
						{ id: `minor-permanent-${suffix}`, kind: "PERMANENT" },
					],
					id: minorPolicyId,
					priority: 101,
					providerReleaseId: releaseId,
					renewalLeadSeconds: 1_209_600,
					requestTtlSeconds: 1_209_600,
					stages: [
						{
							approvers: [
								{
									principalId: approverId,
									displaySnapshot: { displayName: "Approver" },
								},
							],
							id: `minor-stage-${suffix}`,
							name: "Security label correction",
							quorumType: "ANY",
							timeoutSeconds: 259_200,
						},
					],
				});
				await expect(
					catalog.publishPolicy({
						actorPrincipalId: adminId,
						policyVersionId: minorPolicyId,
						materialChange: false,
					}),
				).rejects.toThrow("Policy authorization semantics require reapproval");
				await sql`
					UPDATE connection_access_policy_versions SET priority = 100
					WHERE id = ${minorPolicyId} AND status = 'DRAFT'
				`;
				await catalog.publishPolicy({
					actorPrincipalId: adminId,
					policyVersionId: minorPolicyId,
					materialChange: false,
				});
				const [minor] = await sql<
					{
						access_state: string;
						campaign_count: number;
						material_change: boolean;
					}[]
				>`
					SELECT access.state AS access_state, policy.material_change,
						(SELECT count(*)::int FROM connection_access_reapproval_campaigns
						 WHERE trigger_version_id = ${minorPolicyId}) AS campaign_count
					FROM connection_access_authorizations access
					JOIN connection_access_policy_versions policy ON policy.id = ${minorPolicyId}
					WHERE access.id = ${authorizationId}
				`;
				expect(minor).toEqual({
					access_state: "REAPPROVAL_REQUIRED",
					campaign_count: 0,
					material_change: false,
				});
				const nextOption = (await requests.listAccessOptions(applicantId)).find(
					(option) => option.policyVersionId === minorPolicyId,
				);
				if (!nextOption)
					throw new Error("Replacement policy option is missing");
				const pendingRequestId = `material-pending-${suffix}`;
				await requests.createRequest({
					applicantPrincipalId: applicantId,
					capabilityProfileId: original.capability_profile_id,
					disclaimerConfirmations: [
						{
							contentSha256: createHash("sha256")
								.update("Material data-use change")
								.digest("hex"),
							disclaimerVersionId: disclaimerId,
							locale: "zh-CN",
						},
					],
					duration: { days: 90, kind: "FINITE" },
					id: pendingRequestId,
					policyVersionId: minorPolicyId,
					presentationId: nextOption.presentationId,
					providerReleaseId: releaseId,
					purpose: "Reapproval under replacement policy",
				});
				const [nextPolicy] = await sql<{ revision: string }[]>`
					SELECT revision::text FROM connection_access_policy_versions WHERE id = ${minorPolicyId}
				`;
				if (!nextPolicy)
					throw new Error("Replacement policy revision is missing");
				expect(
					await catalog.revokePolicy({
						actorPrincipalId: adminId,
						expectedRevision: nextPolicy.revision,
						policyVersionId: minorPolicyId,
						reason: "Emergency security withdrawal",
					}),
				).toEqual({
					policyVersionId: minorPolicyId,
					canceledRequests: 1,
					suspendedConnections: 2,
				});
				const [withdrawn] = await sql<
					{
						access_state: string;
						old_status: string;
						material_status: string;
						new_status: string;
						request_state: string;
					}[]
				>`
					SELECT access.state AS access_state, old_policy.status AS old_status,
						material_policy.status AS material_status,
						new_policy.status AS new_status, request.state AS request_state
					FROM connection_access_authorizations access
					JOIN connection_access_policy_versions old_policy ON old_policy.id = ${original.policy_version_id}
					JOIN connection_access_policy_versions material_policy ON material_policy.id = ${nextPolicyId}
					JOIN connection_access_policy_versions new_policy ON new_policy.id = ${minorPolicyId}
					JOIN connection_access_requests request ON request.id = ${pendingRequestId}
					WHERE access.id = ${authorizationId}
				`;
				expect(withdrawn).toEqual({
					access_state: "SUSPENDED",
					old_status: "REVOKED",
					material_status: "REVOKED",
					new_status: "REVOKED",
					request_state: "CANCELED",
				});
				const [disconnectedSuspended] = await sql<{ state: string }[]>`
					SELECT state FROM connection_access_authorizations
					WHERE id = ${disconnectedAuthorizationId}
				`;
				expect(disconnectedSuspended?.state).toBe("SUSPENDED");
				const [revokeEvidence] = await sql<
					{ audit_count: number; outbox_count: number }[]
				>`
					SELECT
						(SELECT count(*)::int FROM connection_audit_records
						 WHERE event = 'connection.access-policy.revoked'
							AND detail->>'reason' = 'Emergency security withdrawal') AS audit_count,
						(SELECT count(*)::int FROM connection_outbox_events
						 WHERE topic = 'connection.access-policy.revoked') AS outbox_count
				`;
				expect(revokeEvidence).toEqual({ audit_count: 3, outbox_count: 3 });
			} finally {
				await requests.close();
				await catalog.close();
				await sql.end();
			}
		},
		30_000,
	);

	integrationTest(
		"publishes an immutable policy with audit and outbox evidence",
		async () => {
			if (!databaseUrl) return;
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const suffix = randomUUID();
			const adminId = `principal-approval-admin-${suffix}`;
			const approverId = `principal-approval-reviewer-${suffix}`;
			const delegateId = `principal-approval-delegate-${suffix}`;
			const applicantId = `principal-approval-applicant-${suffix}`;
			const releaseId = `approval-provider-release-${suffix}`;
			const actionId = `approval-provider.read@${suffix}`;
			const writeActionId = `approval-provider.write@${suffix}`;
			const consumerId = `approval-consumer-${suffix}`;
			const profileId = `approval-profile-${suffix}`;
			const disclaimerId = `approval-disclaimer-${suffix}`;
			const policyId = `approval-policy-${suffix}`;
			const sql = postgres(databaseUrl, { max: 1 });
			const repository = new PostgresConnectionApprovalRepository(databaseUrl);
			const requestRepository = new PostgresConnectionAccessRequestRepository(
				databaseUrl,
			);
			const dispatcher = new PostgresConnectionNotificationDispatcher(
				databaseUrl,
			);
			const connections = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 17),
			);
			try {
				await sql`
					INSERT INTO connection_principals (id, display_name)
					VALUES (${adminId}, 'Approval Admin'),
						(${approverId}, 'Approval Reviewer'),
						(${delegateId}, 'Approval Delegate'),
						(${applicantId}, 'Approval Applicant')
				`;
				await sql`
					INSERT INTO connection_principal_roles (
						principal_id, role, status, grant_source
					) VALUES (${adminId}, 'CONNECTION_ADMIN', 'ACTIVE', 'BOOTSTRAP')
				`;
				await sql`
					INSERT INTO connection_provider_releases (
						id, provider, source_commit, deployment_profile, auth_profile,
						executor_digest, catalog_checksum, status
					) VALUES (
						${releaseId}, ${`approval-provider-${suffix}`}, ${suffix},
						'{}'::jsonb, '{}'::jsonb, ${`sha256:${"a".repeat(64)}`},
						${`connection-json-v1:${"b".repeat(64)}`}, 'PUBLISHED'
					)
				`;
				await sql`
					INSERT INTO connection_action_versions (
						id, provider_release_id, name, description, effect,
						input_schema, required_scopes, status
					) VALUES (
						${actionId}, ${releaseId}, 'approval-provider.read',
						'Approval integration read', 'READ',
						'{"type":"object","required":[]}'::jsonb,
						'["approval.read"]'::jsonb, 'PUBLISHED'
					)
				`;
				await sql`
					INSERT INTO connection_action_versions (
						id, provider_release_id, name, description, effect,
						input_schema, required_scopes, status
					) VALUES (
						${writeActionId}, ${releaseId}, 'approval-provider.write',
						'Approval integration write', 'WRITE',
						'{"type":"object","required":[]}'::jsonb,
						'["approval.read"]'::jsonb, 'PUBLISHED'
					)
				`;
				await repository.createCapabilityProfileDraft({
					actionVersionIds: [actionId],
					id: profileId,
					name: "Approval read",
					providerReleaseId: releaseId,
				});
				await repository.publishCapabilityProfile({
					actorPrincipalId: adminId,
					capabilityProfileId: profileId,
				});
				const disclaimerDigest = createHash("sha256")
					.update("Approval integration disclaimer", "utf8")
					.digest("hex");
				await repository.createDisclaimerDraft({
					content: "Approval integration disclaimer",
					id: disclaimerId,
					kind: "GLOBAL",
					locale: "zh-CN",
					materialChange: false,
					ownerMetadata: { owner: "integration" },
				});
				await repository.publishDisclaimer({
					actorPrincipalId: adminId,
					disclaimerVersionId: disclaimerId,
				});
				for (const missing of ["disclaimer", "approvers"] as const) {
					const incompleteId = `incomplete-${missing}-${suffix}`;
					const incompleteDraft: ApprovalPolicyDraft = {
						allowPermanent: false,
						capabilityProfileId: profileId,
						connectTtlSeconds: 604_800,
						createdByPrincipalId: adminId,
						defaultDurationDays: 90,
						disclaimerVersionIds:
							missing === "disclaimer" ? [] : [disclaimerId],
						durations: [
							{ days: 90, id: `duration-${incompleteId}`, kind: "FINITE" },
						],
						id: incompleteId,
						priority: 100,
						providerReleaseId: releaseId,
						renewalLeadSeconds: 1_209_600,
						requestTtlSeconds: 1_209_600,
						stages: [
							{
								approvers:
									missing === "approvers"
										? []
										: [
												{
													principalId: approverId,
													displaySnapshot: { displayName: "Reviewer" },
												},
											],
								id: `stage-${incompleteId}`,
								name: "Review",
								quorumType: "ANY",
								timeoutSeconds: 259_200,
							},
						],
					};
					await repository.createPolicyDraft(incompleteDraft);
					expect(await repository.getPolicyDraft(incompleteId)).toMatchObject({
						...incompleteDraft,
						revision: "1",
					});
					await expect(
						repository.publishPolicy({
							actorPrincipalId: adminId,
							policyVersionId: incompleteId,
						}),
					).rejects.toThrow("Approval policy dependencies are not publishable");
					const [incomplete] = await sql<{ status: string }[]>`
						SELECT status FROM connection_access_policy_versions WHERE id = ${incompleteId}
					`;
					expect(incomplete?.status).toBe("DRAFT");
					await expect(
						repository.updatePolicyDraft({
							...incompleteDraft,
							expectedRevision: "1",
							createdByPrincipalId: approverId,
						}),
					).rejects.toThrow(
						"Draft actor is not an active Connection administrator",
					);
					const edited = {
						...incompleteDraft,
						expectedRevision: "1",
						priority: 101,
					};
					const writes = await Promise.allSettled([
						repository.updatePolicyDraft(edited),
						repository.updatePolicyDraft(edited),
					]);
					expect(
						writes.filter((result) => result.status === "fulfilled"),
					).toHaveLength(1);
					expect(
						writes.filter((result) => result.status === "rejected"),
					).toHaveLength(1);
					const [updated] = await sql<
						{ priority: number; revision: string; status: string }[]
					>`
						SELECT priority, revision::text, status FROM connection_access_policy_versions WHERE id = ${incompleteId}
					`;
					expect(updated).toEqual({
						priority: 101,
						revision: "2",
						status: "DRAFT",
					});
					await expect(
						repository.updatePolicyDraft({
							...incompleteDraft,
							expectedRevision: "2",
							priority: 102,
							disclaimerVersionIds: [`missing-disclaimer-${suffix}`],
						}),
					).rejects.toThrow();
					const [rolledBack] = await sql<
						{ priority: number; revision: string; stage_count: number }[]
					>`
						SELECT priority, revision::text,
							(SELECT count(*)::int FROM connection_approval_stages WHERE policy_version_id = ${incompleteId}) AS stage_count
						FROM connection_access_policy_versions WHERE id = ${incompleteId}
					`;
					expect(rolledBack).toEqual({
						priority: 101,
						revision: "2",
						stage_count: 1,
					});
				}
				await repository.createPolicyDraft({
					allowPermanent: true,
					capabilityProfileId: profileId,
					connectTtlSeconds: 604_800,
					createdByPrincipalId: adminId,
					defaultDurationDays: 90,
					disclaimerVersionIds: [disclaimerId],
					durations: [
						{ days: 90, id: `duration-90-${suffix}`, kind: "FINITE" },
						{ id: `duration-permanent-${suffix}`, kind: "PERMANENT" },
					],
					id: policyId,
					priority: 100,
					providerReleaseId: releaseId,
					renewalLeadSeconds: 1_209_600,
					requestTtlSeconds: 1_209_600,
					stages: [
						{
							approvers: [
								{
									displaySnapshot: { displayName: "Approval Reviewer" },
									principalId: approverId,
								},
							],
							id: `approval-stage-${suffix}`,
							name: "Security",
							quorumType: "ANY",
							timeoutSeconds: 259_200,
						},
					],
				});
				await repository.publishPolicy({
					actorPrincipalId: adminId,
					policyVersionId: policyId,
				});

				const [policy] = await sql<{ revision: string; status: string }[]>`
					SELECT revision::text, status
					FROM connection_access_policy_versions WHERE id = ${policyId}
				`;
				expect(policy).toEqual({ revision: "2", status: "PUBLISHED" });
				await expect(repository.getPolicyDraft(policyId)).rejects.toThrow(
					"Policy draft is unavailable",
				);
				const [evidence] = await sql<
					{ audit_count: number; outbox_count: number }[]
				>`
					SELECT
						(SELECT count(*)::int FROM connection_audit_records
						 WHERE detail->>'aggregateId' = ${policyId}) AS audit_count,
						(SELECT count(*)::int FROM connection_outbox_events
						 WHERE aggregate_id = ${policyId}) AS outbox_count
				`;
				expect(evidence).toEqual({ audit_count: 1, outbox_count: 1 });
				const selfReviewOption = (
					await requestRepository.listAccessOptions(approverId)
				).find((item) => item.policyVersionId === policyId);
				if (!selfReviewOption) throw new Error("Self-review option is missing");
				const blockedRequestId = `approval-blocked-${suffix}`;
				await requestRepository.createRequest({
					applicantPrincipalId: approverId,
					capabilityProfileId: profileId,
					disclaimerConfirmations: [
						{
							contentSha256: disclaimerDigest,
							disclaimerVersionId: disclaimerId,
							locale: "zh-CN",
						},
					],
					duration: { days: 90, kind: "FINITE" },
					id: blockedRequestId,
					policyVersionId: policyId,
					presentationId: selfReviewOption.presentationId,
					providerReleaseId: releaseId,
					purpose: "Self-review must be rerouted",
				});
				const [blocked] = await requestRepository.listRoutingBlocked(adminId);
				expect(blocked).toMatchObject({
					id: blockedRequestId,
					state: "ROUTING_BLOCKED",
				});
				expect(
					(await requestRepository.listNotifications(adminId)).adminWorkItems,
				).toBe(1);
				expect(
					(await requestRepository.listNotifications(adminId)).unreadCount,
				).toBe(0);
				expect(
					(await requestRepository.listNotifications(adminId)).items,
				).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							businessId: blockedRequestId,
							eventType: "ROUTING_BLOCKED",
						}),
					]),
				);
				const blockedNotice = (
					await requestRepository.listNotifications(adminId)
				).items.find(
					(item) =>
						item.businessId === blockedRequestId &&
						item.eventType === "ROUTING_BLOCKED",
				);
				if (!blockedNotice) throw new Error("Admin routing notice is missing");
				await sql`
					UPDATE connection_principal_roles
					SET status = 'REVOKED', revoked_at = now(), revision = revision + 1
					WHERE principal_id = ${adminId} AND role = 'CONNECTION_ADMIN'
				`;
				expect(
					(await requestRepository.listNotifications(adminId)).adminWorkItems,
				).toBe(0);
				expect(
					(await requestRepository.listNotifications(adminId)).items.some(
						(item) => item.id === blockedNotice.id,
					),
				).toBe(false);
				expect(
					(await requestRepository.listWorkItems(adminId)).some(
						(item) => item.actionType === "REROUTE",
					),
				).toBe(false);
				await expect(
					requestRepository.markNotifications(
						adminId,
						[blockedNotice.id],
						true,
					),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await sql`
					UPDATE connection_principal_roles
					SET status = 'ACTIVE', revoked_at = NULL, revision = revision + 1
					WHERE principal_id = ${adminId} AND role = 'CONNECTION_ADMIN'
				`;
				await requestRepository.markNotifications(
					adminId,
					[blockedNotice.id],
					true,
				);
				expect(
					(await requestRepository.listNotifications(adminId)).adminWorkItems,
				).toBe(1);
				expect(
					(await requestRepository.listApprovalQueue(approverId)).some(
						(item) => item.id === blockedRequestId,
					),
				).toBe(false);
				const blockedStage = blocked?.stages[0];
				if (!blocked || !blockedStage)
					throw new Error("Blocked stage is missing");
				await requestRepository.reroute({
					actorPrincipalId: adminId,
					approvers: [
						{
							principalId: adminId,
							displaySnapshot: { displayName: "Approval Admin" },
						},
					],
					expectedRequestRevision: blocked.revision,
					expectedRoutingRevision: blockedStage.routingRevision,
					expectedStageRevision: blockedStage.revision,
					reason: "Prevent applicant self-review",
					requestId: blockedRequestId,
				});
				expect(
					(await requestRepository.getRequest(approverId, blockedRequestId))
						.state,
				).toBe("IN_REVIEW");
				expect(
					(await requestRepository.listRoutingBlocked(adminId)).length,
				).toBe(0);
				expect(
					(await requestRepository.listNotifications(adminId)).adminWorkItems,
				).toBe(0);
				const priorApproverUnread = (
					await requestRepository.listNotifications(approverId)
				).unreadCount;
				const requestId = `approval-request-${suffix}`;
				const option = (
					await requestRepository.listAccessOptions(applicantId)
				).find((item) => item.policyVersionId === policyId);
				if (!option) throw new Error("Approval option is missing");
				await requestRepository.createRequest({
					applicantPrincipalId: applicantId,
					capabilityProfileId: profileId,
					disclaimerConfirmations: [
						{
							contentSha256: disclaimerDigest,
							disclaimerVersionId: disclaimerId,
							locale: "zh-CN",
						},
					],
					duration: { days: 90, kind: "FINITE" },
					id: requestId,
					policyVersionId: policyId,
					presentationId: option.presentationId,
					providerReleaseId: releaseId,
					purpose: "Approval integration request",
				});
				const [submittedProjection] = await sql<
					{
						notifications: number;
						open_work_items: number;
						receipts: number;
					}[]
				>`
					SELECT
						(SELECT count(*)::int FROM connection_work_items
						 WHERE business_id = ${requestId} AND status = 'OPEN') AS open_work_items,
						(SELECT count(*)::int FROM connection_notifications
						 WHERE business_id = ${requestId}) AS notifications,
						(SELECT count(*)::int FROM connection_notification_receipts receipt
						 JOIN connection_notifications notification
							ON notification.id = receipt.notification_id
						 WHERE notification.business_id = ${requestId}) AS receipts
				`;
				expect(submittedProjection).toEqual({
					notifications: 2,
					open_work_items: 1,
					receipts: 2,
				});
				const applicantNotifications =
					await requestRepository.listNotifications(applicantId);
				expect(applicantNotifications.unreadCount).toBe(1);
				const applicantNotificationId = applicantNotifications.items[0]?.id;
				if (!applicantNotificationId)
					throw new Error("Applicant notification is missing");
				await expect(
					requestRepository.markNotification(
						approverId,
						applicantNotificationId,
						true,
					),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const approverNotificationId = (
					await requestRepository.listNotifications(approverId)
				).items[0]?.id;
				if (!approverNotificationId)
					throw new Error("Approver notification is missing");
				await expect(
					requestRepository.markNotifications(
						applicantId,
						[applicantNotificationId, approverNotificationId],
						false,
					),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				expect(
					(await requestRepository.listNotifications(applicantId)).unreadCount,
				).toBe(1);
				await requestRepository.markNotification(
					applicantId,
					applicantNotificationId,
					false,
				);
				expect(
					(await requestRepository.listNotifications(applicantId)).unreadCount,
				).toBe(0);
				expect(
					(await requestRepository.listNotifications(approverId)).openWorkItems,
				).toBe(1);
				expect(
					(await requestRepository.listNotifications(approverId)).unreadCount,
				).toBe(priorApproverUnread);
				await requestRepository.markNotification(
					applicantId,
					applicantNotificationId,
					true,
				);
				expect(
					(await requestRepository.listNotifications(applicantId)).items,
				).toHaveLength(0);
				const [request] = await sql<
					{
						request_revision: string;
						routing_revision: string;
						stage_revision: string;
					}[]
				>`
					SELECT request.revision::text AS request_revision,
						stage.revision::text AS stage_revision,
						stage.routing_revision::text AS routing_revision
					FROM connection_access_requests request
					JOIN connection_request_stages stage
						ON stage.request_id = request.id AND stage.ordinal = 1
					WHERE request.id = ${requestId}
				`;
				if (!request) throw new Error("approval request fixture is missing");
				const delegation = {
					actorPrincipalId: adminId,
					principalId: approverId,
					delegatePrincipalId: delegateId,
					startsAt: new Date(Date.now() - 60_000).toISOString(),
					endsAt: new Date(Date.now() + 86_400_000).toISOString(),
					id: `approval-delegation-${suffix}`,
				};
				await expect(
					requestRepository.createDelegation({
						...delegation,
						actorPrincipalId: applicantId,
						id: `${delegation.id}-unauthorized`,
					}),
				).rejects.toThrow();
				await expect(
					requestRepository.createDelegation({
						...delegation,
						delegatePrincipalId: approverId,
						id: `${delegation.id}-self`,
					}),
				).rejects.toThrow();
				expect(await requestRepository.createDelegation(delegation)).toEqual({
					delegationId: delegation.id,
				});
				await expect(
					requestRepository.createDelegation({
						...delegation,
						id: `${delegation.id}-overlap`,
					}),
				).rejects.toThrow();
				expect(
					(await requestRepository.listApprovalQueue(delegateId)).some(
						(item) => item.id === requestId,
					),
				).toBe(true);
				await sql`UPDATE connection_principals SET status = 'DISABLED' WHERE id = ${approverId}`;
				expect(
					(await requestRepository.listApprovalQueue(delegateId)).some(
						(item) => item.id === requestId,
					),
				).toBe(false);
				await sql`UPDATE connection_principals SET status = 'ACTIVE' WHERE id = ${approverId}`;
				await sql`UPDATE connection_principals SET status = 'DISABLED' WHERE id = ${delegateId}`;
				expect(
					(await requestRepository.listApprovalQueue(delegateId)).some(
						(item) => item.id === requestId,
					),
				).toBe(false);
				await sql`UPDATE connection_principals SET status = 'ACTIVE' WHERE id = ${delegateId}`;
				const listedDelegation = (
					await requestRepository.listDelegations(adminId)
				).find((item) => item.id === delegation.id);
				expect(listedDelegation?.status).toBe("ACTIVE");
				expect(await requestRepository.listDelegations(applicantId)).toEqual(
					[],
				);
				await expect(
					requestRepository.revokeDelegation({
						actorPrincipalId: applicantId,
						delegationId: delegation.id,
						expectedRevision: "1",
					}),
				).rejects.toThrow();
				expect(
					await requestRepository.revokeDelegation({
						actorPrincipalId: adminId,
						delegationId: delegation.id,
						expectedRevision: "1",
					}),
				).toEqual({ delegationId: delegation.id });
				await expect(
					requestRepository.revokeDelegation({
						actorPrincipalId: adminId,
						delegationId: delegation.id,
						expectedRevision: "1",
					}),
				).rejects.toThrow();
				expect(
					(await requestRepository.listApprovalQueue(delegateId)).some(
						(item) => item.id === requestId,
					),
				).toBe(false);
				await expect(
					requestRepository.decide({
						actorPrincipalId: delegateId,
						approverPrincipalId: approverId,
						decision: "APPROVE",
						expectedRequestRevision: request.request_revision,
						expectedRoutingRevision: request.routing_revision,
						expectedStageRevision: request.stage_revision,
						id: `${delegation.id}-decision`,
						requestId,
					}),
				).rejects.toThrow();
				const replacementDelegationId = `${delegation.id}-replacement`;
				await requestRepository.createDelegation({
					...delegation,
					id: replacementDelegationId,
				});
				const decisionId = `approval-decision-${suffix}`;
				const decision = {
					actorPrincipalId: delegateId,
					approverPrincipalId: approverId,
					decision: "APPROVE" as const,
					expectedRequestRevision: request.request_revision,
					expectedRoutingRevision: request.routing_revision,
					expectedStageRevision: request.stage_revision,
					id: decisionId,
					requestId,
				};
				expect(await requestRepository.decide(decision)).toEqual({
					replayed: false,
					requestId,
				});
				expect(await requestRepository.decide(decision)).toEqual({
					replayed: true,
					requestId,
				});
				expect(
					(await requestRepository.getRequest(applicantId, requestId)).stages[0]
						?.decisions,
				).toMatchObject([
					{
						approverName: "Approval Reviewer",
						actorName: "Approval Delegate",
						decision: "APPROVE",
					},
				]);
				const [delegatedDecision] = await sql<{ delegation_id: string }[]>`
					SELECT delegation_id FROM connection_approval_decisions WHERE id = ${decisionId}
				`;
				expect(delegatedDecision?.delegation_id).toBe(replacementDelegationId);
				const [decidedProjection] = await sql<
					{
						applicant_notifications: number;
						completed_work_items: number;
					}[]
				>`
					SELECT
						(SELECT count(*)::int FROM connection_work_items
						 WHERE business_id = ${requestId} AND status = 'COMPLETED')
							AS completed_work_items,
						(SELECT count(*)::int FROM connection_notifications
						 WHERE business_id = ${requestId}
							AND recipient_principal_id = ${applicantId})
							AS applicant_notifications
				`;
				expect(decidedProjection).toEqual({
					applicant_notifications: 2,
					completed_work_items: 1,
				});
				let drained = 0;
				while (drained < 30 && (await dispatcher.runOnce())) drained++;
				expect(drained).toBeGreaterThan(0);
				const approvedEventId = `${decisionId}:connection.access-request.approve`;
				const [delivered] = await sql<{ status: string }[]>`
					SELECT status FROM connection_outbox_events WHERE id = ${approvedEventId}
				`;
				expect(delivered?.status).toBe("DELIVERED");
				await sql`
					UPDATE connection_outbox_events SET status = 'PENDING', delivered_at = NULL
					WHERE id = ${approvedEventId}
				`;
				expect(await dispatcher.runOnce()).toBe(true);
				const [afterReplay] = await sql<{ count: number }[]>`
					SELECT count(*)::int AS count FROM connection_notifications
					WHERE business_id = ${requestId} AND recipient_principal_id = ${applicantId}
				`;
				expect(afterReplay?.count).toBe(2);
				const [approved] = await sql<{ permit_count: number; state: string }[]>`
					SELECT request.state,
						(SELECT count(*)::int FROM connection_connect_permits permit
						 WHERE permit.request_id = request.id) AS permit_count
					FROM connection_access_requests request WHERE request.id = ${requestId}
				`;
				expect(approved).toEqual({
					permit_count: 1,
					state: "APPROVED_PENDING_CONNECTION",
				});
				const connectExpiresAt = (
					await requestRepository.getRequest(applicantId, requestId)
				).connectExpiresAt;
				expect(Date.parse(connectExpiresAt ?? "")).toBeGreaterThan(Date.now());
				expect(
					await requestRepository.prepareConnect(applicantId, requestId),
				).toMatchObject({
					requestId,
					providerId: `approval-provider-${suffix}`,
				});
				await expect(
					requestRepository.prepareConnect(approverId, requestId),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				const connectionId = `approval-connection-${suffix}`;
				await sql`
					INSERT INTO connection_accounts (
						id, owner_type, owner_principal_id, shared_scope_id,
						provider_release_id, provider_id, external_account,
						display_name, status
					) VALUES (
						${connectionId}, 'PERSONAL', ${applicantId}, NULL,
						${releaseId}, ${`approval-provider-${suffix}`},
						'approval-external-account', 'Approval Account', 'ACTIVE'
					)
				`;
				await sql`
					INSERT INTO connection_credential_versions (
						id, connection_id, ciphertext, nonce, tag, scope_json, status
					) VALUES (
						${`approval-credential-${suffix}`}, ${connectionId},
						'fixture', 'fixture', 'fixture', '["approval.read"]'::jsonb, 'ACTIVE'
					)
				`;
				const accessAuthorizationId = `access-authorization-${suffix}`;
				expect(
					await requestRepository.consumeConnectPermit({
						accessAuthorizationId,
						connectionId,
						grantedScopes: ["approval.read"],
						principalId: applicantId,
						requestId,
					}),
				).toEqual({ accessAuthorizationId, connectionId });
				const [consumed] = await sql<
					{ authorization_state: string; request_state: string }[]
				>`
					SELECT request.state AS request_state,
						access.state AS authorization_state
					FROM connection_access_requests request
					JOIN connection_access_authorizations access
						ON access.source_request_id = request.id
					WHERE request.id = ${requestId}
				`;
				expect(consumed).toEqual({
					authorization_state: "ACTIVE",
					request_state: "CONSUMED",
				});
				await sql`
					INSERT INTO connection_consumers (id, display_name, status)
					VALUES (${consumerId}, 'Approval test Consumer', 'ACTIVE')
				`;
				await sql`
					INSERT INTO connection_consumer_instances (
						id, consumer_id, kind, auth_subject, status, principal_id
					) VALUES (
						${`approval-instance-${suffix}`}, ${consumerId}, 'DEVICE',
						${`subject-${suffix}`}, 'ACTIVE', ${applicantId}
					)
				`;
				await connections.publishConsumerDeclaration({
					actionVersionIds: [actionId, writeActionId],
					consumer: { id: consumerId, name: "Approval test Consumer" },
					providerReleaseId: releaseId,
				});
				const preview =
					await connections.createCurrentConsumerAuthorizationPreview({
						connectionId,
						consumerId,
						principalId: applicantId,
					});
				expect(preview.actions.map((action) => action.id)).toEqual([actionId]);
				await expect(
					connections.createCurrentConsumerAuthorizationPreview({
						connectionId,
						consumerId,
						principalId: applicantId,
						actionVersionIds: [writeActionId],
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				await sql`
					UPDATE connection_access_authorizations
					SET state = 'REAPPROVAL_REQUIRED',
						reapproval_deadline_at = now() - interval '1 second', revision = revision + 1
					WHERE id = ${accessAuthorizationId}
				`;
				await expect(
					connections.confirmCurrentConsumerAuthorization({
						confirmationToken: preview.confirmationToken,
						idempotencyKey: `stale-access-${suffix}`,
						previewId: preview.previewId,
						principalId: applicantId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await sql`
					UPDATE connection_access_authorizations
					SET state = 'ACTIVE', reapproval_deadline_at = NULL, revision = revision + 1
					WHERE id = ${accessAuthorizationId}
				`;
				expect(await repository.activatePreLaunchBaseline(adminId)).toEqual({
					baselinedConnections: 0,
				});
				const [approvedCutover] = await sql<
					{ source: string; state: string }[]
				>`
					SELECT access.source, enforcement.state
					FROM connection_access_authorizations access
					JOIN connection_access_enforcement enforcement ON enforcement.id = 'personal'
					WHERE access.id = ${accessAuthorizationId}
				`;
				expect(approvedCutover).toEqual({
					source: "APPROVED_REQUEST",
					state: "ENFORCED",
				});
				await expect(
					requestRepository.prepareConnect(applicantId, requestId),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				expect(
					await requestRepository.createReapprovalCampaign({
						actorPrincipalId: adminId,
						capabilityProfileId: profileId,
						deadlineAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
						id: `same-policy-campaign-${suffix}`,
						providerReleaseId: releaseId,
						reason: "Already approved under this exact policy",
						triggerKind: "POLICY",
						triggerVersionId: policyId,
					}),
				).toEqual({
					campaignId: `same-policy-campaign-${suffix}`,
					affectedConnections: 0,
				});
				const tooEarlyOption = (
					await requestRepository.listAccessOptions(applicantId)
				).find((item) => item.policyVersionId === policyId);
				if (!tooEarlyOption) throw new Error("Early renewal option is missing");
				await expect(
					requestRepository.createRenewalRequest({
						applicantPrincipalId: applicantId,
						authorizationId: accessAuthorizationId,
						capabilityProfileId: profileId,
						disclaimerConfirmations: [
							{
								contentSha256: disclaimerDigest,
								disclaimerVersionId: disclaimerId,
								locale: "zh-CN",
							},
						],
						duration: { days: 90, kind: "FINITE" },
						id: `early-renewal-${suffix}`,
						policyVersionId: policyId,
						presentationId: tooEarlyOption.presentationId,
						providerReleaseId: releaseId,
						purpose: "Too early",
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await sql`
					UPDATE connection_access_authorizations
					SET valid_until = now() + interval '10 days'
					WHERE id = ${accessAuthorizationId}
				`;
				const authorizationRenewalOption = (
					await requestRepository.listAccessOptions(applicantId)
				).find((item) => item.policyVersionId === policyId);
				if (!authorizationRenewalOption)
					throw new Error("Renewal option is missing");
				const renewalRequestId = `renewal-request-${suffix}`;
				await requestRepository.createRenewalRequest({
					applicantPrincipalId: applicantId,
					authorizationId: accessAuthorizationId,
					capabilityProfileId: profileId,
					disclaimerConfirmations: [
						{
							contentSha256: disclaimerDigest,
							disclaimerVersionId: disclaimerId,
							locale: "zh-CN",
						},
					],
					duration: { days: 90, kind: "FINITE" },
					id: renewalRequestId,
					policyVersionId: policyId,
					presentationId: authorizationRenewalOption.presentationId,
					providerReleaseId: releaseId,
					purpose: "Renew existing approval",
				});
				const duplicateOption = (
					await requestRepository.listAccessOptions(applicantId)
				).find((item) => item.policyVersionId === policyId);
				if (!duplicateOption)
					throw new Error("Duplicate renewal option is missing");
				await expect(
					requestRepository.createRenewalRequest({
						applicantPrincipalId: applicantId,
						authorizationId: accessAuthorizationId,
						capabilityProfileId: profileId,
						disclaimerConfirmations: [
							{
								contentSha256: disclaimerDigest,
								disclaimerVersionId: disclaimerId,
								locale: "zh-CN",
							},
						],
						duration: { days: 90, kind: "FINITE" },
						id: `duplicate-renewal-${suffix}`,
						policyVersionId: policyId,
						presentationId: duplicateOption.presentationId,
						providerReleaseId: releaseId,
						purpose: "Duplicate renewal",
					}),
				).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
				const renewalRequest = await requestRepository.getRequest(
					applicantId,
					renewalRequestId,
				);
				const renewalStage = renewalRequest.stages[0];
				if (!renewalStage) throw new Error("Renewal stage is missing");
				await requestRepository.decide({
					actorPrincipalId: approverId,
					approverPrincipalId: approverId,
					decision: "APPROVE",
					expectedRequestRevision: renewalRequest.revision,
					expectedRoutingRevision: renewalStage.routingRevision,
					expectedStageRevision: renewalStage.revision,
					id: `renewal-decision-${suffix}`,
					requestId: renewalRequestId,
				});
				const [renewed] = await sql<
					{
						permit_count: number;
						request_state: string;
						renewal_status: string;
						valid_until: Date;
					}[]
				>`
					SELECT request.state AS request_state,
						renewal.status AS renewal_status, access.valid_until,
						(SELECT count(*)::int FROM connection_connect_permits permit
						 WHERE permit.request_id = request.id) AS permit_count
					FROM connection_access_requests request
					JOIN connection_authorization_renewals renewal ON renewal.request_id = request.id
					JOIN connection_access_authorizations access ON access.id = renewal.access_authorization_id
					WHERE request.id = ${renewalRequestId}
				`;
				expect(renewed).toMatchObject({
					permit_count: 0,
					request_state: "CONSUMED",
					renewal_status: "APPROVED",
				});
				expect(renewed?.valid_until.getTime()).toBeGreaterThan(
					Date.now() + 99 * 86_400_000,
				);
				expect(renewed?.valid_until.getTime()).toBeLessThan(
					Date.now() + 101 * 86_400_000,
				);
				await sql`
					UPDATE connection_access_authorizations
					SET valid_until = now() + interval '4 seconds'
					WHERE id = ${accessAuthorizationId}
				`;
				const lateOption = (
					await requestRepository.listAccessOptions(applicantId)
				).find((item) => item.policyVersionId === policyId);
				if (!lateOption) throw new Error("Late renewal option is missing");
				const lateRequestId = `late-renewal-${suffix}`;
				await requestRepository.createRenewalRequest({
					applicantPrincipalId: applicantId,
					authorizationId: accessAuthorizationId,
					capabilityProfileId: profileId,
					disclaimerConfirmations: [
						{
							contentSha256: disclaimerDigest,
							disclaimerVersionId: disclaimerId,
							locale: "zh-CN",
						},
					],
					duration: { days: 90, kind: "FINITE" },
					id: lateRequestId,
					policyVersionId: policyId,
					presentationId: lateOption.presentationId,
					providerReleaseId: releaseId,
					purpose: "Pending across original expiry",
				});
				const lateRequest = await requestRepository.getRequest(
					applicantId,
					lateRequestId,
				);
				const lateStage = lateRequest.stages[0];
				if (!lateStage) throw new Error("Late renewal stage is missing");
				const [beforeExpiry] = await sql<{ execution_fence: string }[]>`
				SELECT execution_fence::text FROM connection_accounts
				WHERE id = ${connectionId}
			`;
				await new Promise((resolve) => setTimeout(resolve, 4_100));
				expect(await requestRepository.expireDueAuthorizations()).toBe(1);
				expect(await requestRepository.expireDueAuthorizations()).toBe(0);
				const [afterExpiry] = await sql<
					{
						execution_fence: string;
						state: string;
					}[]
				>`
				SELECT account.execution_fence::text,
					access.state
				FROM connection_accounts account
				JOIN connection_access_authorizations access
					ON access.connection_id = account.id
				WHERE access.id = ${accessAuthorizationId}
			`;
				expect(afterExpiry).toEqual({
					execution_fence: String(Number(beforeExpiry?.execution_fence) + 1),
					state: "EXPIRED",
				});
				expect(
					(await requestRepository.listNotifications(applicantId)).items.some(
						(item) =>
							item.businessType === "CONNECTION_ACCESS_AUTHORIZATION" &&
							item.state === "EXPIRED",
					),
				).toBe(true);
				const expiredOption = (
					await requestRepository.listAccessOptions(applicantId)
				).find((item) => item.policyVersionId === policyId);
				if (!expiredOption)
					throw new Error("Expired renewal option is missing");
				await expect(
					requestRepository.createRenewalRequest({
						applicantPrincipalId: applicantId,
						authorizationId: accessAuthorizationId,
						capabilityProfileId: profileId,
						disclaimerConfirmations: [
							{
								contentSha256: disclaimerDigest,
								disclaimerVersionId: disclaimerId,
								locale: "zh-CN",
							},
						],
						duration: { days: 90, kind: "FINITE" },
						id: `expired-renewal-${suffix}`,
						policyVersionId: policyId,
						presentationId: expiredOption.presentationId,
						providerReleaseId: releaseId,
						purpose: "Expired renewal cannot start",
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await requestRepository.decide({
					actorPrincipalId: approverId,
					approverPrincipalId: approverId,
					decision: "APPROVE",
					expectedRequestRevision: lateRequest.revision,
					expectedRoutingRevision: lateStage.routingRevision,
					expectedStageRevision: lateStage.revision,
					id: `late-renewal-decision-${suffix}`,
					requestId: lateRequestId,
				});
				const [resumed] = await sql<
					{ request_state: string; state: string; valid_until: Date }[]
				>`
					SELECT request.state AS request_state, access.state, access.valid_until
					FROM connection_access_requests request
					JOIN connection_authorization_renewals renewal ON renewal.request_id = request.id
					JOIN connection_access_authorizations access ON access.id = renewal.access_authorization_id
					WHERE request.id = ${lateRequestId}
				`;
				expect(resumed).toMatchObject({
					request_state: "CONSUMED",
					state: "ACTIVE",
				});
				expect(resumed?.valid_until.getTime()).toBeGreaterThan(
					Date.now() + 89 * 86_400_000,
				);
				const expiringRequestId = `approval-expiring-${suffix}`;
				const renewalOption = (
					await requestRepository.listAccessOptions(applicantId)
				).find((item) => item.policyVersionId === policyId);
				if (!renewalOption) throw new Error("Renewal option is missing");
				await requestRepository.createRequest({
					applicantPrincipalId: applicantId,
					capabilityProfileId: profileId,
					disclaimerConfirmations: [
						{
							contentSha256: disclaimerDigest,
							disclaimerVersionId: disclaimerId,
							locale: "zh-CN",
						},
					],
					duration: { days: 90, kind: "FINITE" },
					id: expiringRequestId,
					policyVersionId: policyId,
					presentationId: renewalOption.presentationId,
					providerReleaseId: releaseId,
					purpose: "Expiry test",
				});
				const beforeReroute = await requestRepository.getRequest(
					applicantId,
					expiringRequestId,
				);
				const activeStage = beforeReroute.stages.find(
					(stage) => stage.ordinal === 1,
				);
				if (!activeStage) throw new Error("Active approval stage is missing");
				expect(
					await requestRepository.reroute({
						actorPrincipalId: adminId,
						approvers: [
							{
								principalId: adminId,
								displaySnapshot: { displayName: "Approval Admin" },
							},
						],
						expectedRequestRevision: beforeReroute.revision,
						expectedRoutingRevision: activeStage.routingRevision,
						expectedStageRevision: activeStage.revision,
						reason: "Administrator reroute",
						requestId: expiringRequestId,
					}),
				).toEqual({ requestId: expiringRequestId });
				await sql`
				UPDATE connection_access_requests
				SET expires_at = now() - interval '1 second'
				WHERE id = ${expiringRequestId}
			`;
				expect(await requestRepository.expireDueRequests()).toBe(1);
				expect(await requestRepository.expireDueRequests()).toBe(0);
				const [requestExpiry] = await sql<
					{ open_work_items: number; state: string }[]
				>`
				SELECT request.state,
					(SELECT count(*)::int FROM connection_work_items item
					 WHERE item.business_id = request.id AND item.status = 'OPEN')
						AS open_work_items
				FROM connection_access_requests request
				WHERE request.id = ${expiringRequestId}
			`;
				expect(requestExpiry).toEqual({ open_work_items: 0, state: "EXPIRED" });
				await expect(
					requestRepository.reroute({
						actorPrincipalId: adminId,
						approvers: [
							{
								principalId: adminId,
								displaySnapshot: { displayName: "Approval Admin" },
							},
						],
						expectedRequestRevision: beforeReroute.revision,
						expectedRoutingRevision: activeStage.routingRevision,
						expectedStageRevision: activeStage.revision,
						reason: "Stale reroute",
						requestId: expiringRequestId,
					}),
				).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
				await expect(
					requestRepository.createRequest({
						applicantPrincipalId: applicantId,
						capabilityProfileId: profileId,
						disclaimerConfirmations: [
							{
								contentSha256: disclaimerDigest,
								disclaimerVersionId: disclaimerId,
								locale: "zh-CN",
							},
						],
						duration: { days: 90, kind: "FINITE" },
						id: `replayed-presentation-${suffix}`,
						policyVersionId: policyId,
						presentationId: option.presentationId,
						providerReleaseId: releaseId,
						purpose: "Replayed disclaimer presentation",
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				const revokedPolicyOption = (
					await requestRepository.listAccessOptions(applicantId)
				).find((item) => item.policyVersionId === policyId);
				if (!revokedPolicyOption)
					throw new Error("Revocation option is missing");
				const revokedRequestId = `revoked-policy-request-${suffix}`;
				await requestRepository.createRequest({
					applicantPrincipalId: applicantId,
					capabilityProfileId: profileId,
					disclaimerConfirmations: [
						{
							contentSha256: disclaimerDigest,
							disclaimerVersionId: disclaimerId,
							locale: "zh-CN",
						},
					],
					duration: { days: 90, kind: "FINITE" },
					id: revokedRequestId,
					policyVersionId: policyId,
					presentationId: revokedPolicyOption.presentationId,
					providerReleaseId: releaseId,
					purpose: "Policy revoked before connection",
				});
				const revokedRequest = await requestRepository.getRequest(
					applicantId,
					revokedRequestId,
				);
				const revokedStage = revokedRequest.stages[0];
				if (!revokedStage) throw new Error("Revocation stage is missing");
				await requestRepository.decide({
					actorPrincipalId: approverId,
					approverPrincipalId: approverId,
					decision: "APPROVE",
					expectedRequestRevision: revokedRequest.revision,
					expectedRoutingRevision: revokedStage.routingRevision,
					expectedStageRevision: revokedStage.revision,
					id: `revoked-policy-decision-${suffix}`,
					requestId: revokedRequestId,
				});
				const grantPreview =
					await connections.createCurrentConsumerAuthorizationPreview({
						connectionId,
						consumerId,
						principalId: applicantId,
					});
				await connections.confirmCurrentConsumerAuthorization({
					confirmationToken: grantPreview.confirmationToken,
					idempotencyKey: `revoke-grant-${suffix}`,
					previewId: grantPreview.previewId,
					principalId: applicantId,
				});
				const [beforeRevoke] = await sql<
					{ execution_fence: string; revision: string }[]
				>`
					SELECT account.execution_fence::text,
						(SELECT revision::text FROM connection_access_policy_versions WHERE id = ${policyId}) AS revision
					FROM connection_accounts account WHERE account.id = ${connectionId}
				`;
				if (!beforeRevoke)
					throw new Error("Policy revocation fixture is missing");
				await expect(
					repository.revokePolicy({
						actorPrincipalId: applicantId,
						expectedRevision: beforeRevoke.revision,
						policyVersionId: policyId,
						reason: "Security incident",
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(
					repository.revokePolicy({
						actorPrincipalId: adminId,
						expectedRevision: "0",
						policyVersionId: policyId,
						reason: "Security incident",
					}),
				).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
				expect(
					await repository.revokePolicy({
						actorPrincipalId: adminId,
						expectedRevision: beforeRevoke.revision,
						policyVersionId: policyId,
						reason: "Security incident",
					}),
				).toEqual({
					policyVersionId: policyId,
					canceledRequests: 2,
					suspendedConnections: 1,
				});
				const [revokedState] = await sql<
					{
						access_state: string;
						execution_fence: string;
						grant_status: string;
						permit_expired: boolean;
						request_state: string;
					}[]
				>`
					SELECT access.state AS access_state, account.execution_fence::text,
						grant_version.status AS grant_status, request.state AS request_state,
						permit.expires_at <= now() AS permit_expired
					FROM connection_accounts account
					JOIN connection_access_authorizations access ON access.connection_id = account.id
					JOIN connection_grants grant_version ON grant_version.connection_id = account.id
					JOIN connection_access_requests request ON request.id = ${revokedRequestId}
					JOIN connection_connect_permits permit ON permit.request_id = request.id
					WHERE account.id = ${connectionId}
					ORDER BY grant_version.id DESC LIMIT 1
				`;
				expect(revokedState).toEqual({
					access_state: "SUSPENDED",
					execution_fence: String(BigInt(beforeRevoke.execution_fence) + 1n),
					grant_status: "PAUSED_CONNECTION",
					permit_expired: true,
					request_state: "CANCELED",
				});
				await expect(
					connections.resolveDirectIdentity({
						consumerId,
						instanceId: `approval-instance-${suffix}`,
						principalId: applicantId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(
					repository.revokePolicy({
						actorPrincipalId: adminId,
						expectedRevision: beforeRevoke.revision,
						policyVersionId: policyId,
						reason: "Security incident",
					}),
				).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
				await expect(
					requestRepository.prepareConnect(applicantId, revokedRequestId),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(
					requestRepository.consumeConnectPermit({
						accessAuthorizationId: `invalid-after-revoke-${suffix}`,
						connectionId,
						grantedScopes: ["approval.read"],
						principalId: applicantId,
						requestId: revokedRequestId,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(
					sql`
						UPDATE connection_access_policy_versions
						SET priority = 200 WHERE id = ${policyId}
					`,
				).rejects.toMatchObject({ code: "23514" });
				await expect(
					sql`
						DELETE FROM connection_capability_profile_actions
						WHERE capability_profile_id = ${profileId}
					`,
				).rejects.toMatchObject({ code: "23514" });
				await expect(
					sql`
						DELETE FROM connection_approval_stage_approvers
						WHERE policy_version_id = ${policyId}
					`,
				).rejects.toMatchObject({ code: "23514" });
				await expect(
					sql`
						UPDATE connection_approval_decisions
						SET comment = 'tampered' WHERE id = ${decisionId}
					`,
				).rejects.toMatchObject({ code: "23514" });
			} finally {
				await connections.close();
				await dispatcher.close();
				await requestRepository.close();
				await repository.close();
				await sql.end();
			}
		},
		30_000,
	);
});
