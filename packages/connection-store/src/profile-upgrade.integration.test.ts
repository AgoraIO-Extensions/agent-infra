import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ConnectionError, canonicalHash } from "@agent-infra/connection-core";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { PostgresConnectionAccessRequestRepository } from "./access-request-repository";
import { PostgresConnectionApprovalRepository } from "./approval-repository";
import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionNotificationDispatcher } from "./notification-dispatcher";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_APPROVAL_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
const integrationTest = databaseUrl ? it : it.skip;

describe("capability profile follows the current runtime", () => {
	for (const scenario of [
		"compatible",
		"added",
		"effect",
		"scope",
		"schema",
		"unproven",
		"reviewed-fix",
		"removed",
		"description",
		"auth",
		"deployment",
		"directory-disabled",
		"directory-denied",
	] as const) {
		integrationTest(
			scenario,
			async () => {
				if (!databaseUrl) return;
				await migrateConnectionDatabase(
					databaseUrl,
					resolve(import.meta.dirname, "../../../migrations/connection"),
				);
				const suffix = randomUUID();
				const provider = `profile-test-${suffix}`;
				const admin = `admin-${suffix}`;
				const user = `user-${suffix}`;
				const sourceId = `source-${suffix}`;
				const targetId = `target-${suffix}`;
				const profileId = `profile-${suffix}`;
				const policyId = `policy-${suffix}`;
				const oldAction = `old-${suffix}`;
				const newAction = `new-${suffix}`;
				const addedAction = `extra-${suffix}`;
				const disclaimerId = `terms-${suffix}`;
				const requestId = `request-${suffix}`;
				const sql = postgres(databaseUrl);
				const plain = new PostgresConnectionApprovalRepository(databaseUrl);
				const verify = vi.fn(async (_id: string) => {
					if (scenario === "directory-denied")
						throw new ConnectionError(
							"FORBIDDEN",
							"Directory identity unavailable",
						);
				});
				const evidence =
					scenario === "reviewed-fix"
						? [
								{
									provider,
									fromReleaseId: sourceId,
									toReleaseId: targetId,
									fromExecutorDigest: `sha256:${"a".repeat(64)}`,
									toExecutorDigest: `sha256:${"b".repeat(64)}`,
									rationale: "Authorization-preserving implementation repair",
									reviewReference:
										"https://github.com/AgoraIO-Extensions/agent-infra/issues/1902",
								},
							]
						: [];
				const runtime = {
					providerReleases: new Map([[provider, targetId]]),
					authorizationCompatibility: new Map([[targetId, evidence]]),
					approvalDirectoryEnabled: scenario !== "directory-disabled",
					verifyPrincipal: verify,
				};
				const catalog = new PostgresConnectionApprovalRepository(
					databaseUrl,
					runtime,
				);
				const requests = new PostgresConnectionAccessRequestRepository(
					databaseUrl,
				);
				const dispatcher = new PostgresConnectionNotificationDispatcher(
					databaseUrl,
				);
				try {
					await sql`INSERT INTO connection_principals (id, display_name) VALUES (${admin}, 'Admin'), (${user}, 'User')`;
					await sql`INSERT INTO connection_principal_roles (principal_id, role, status, grant_source) VALUES (${admin}, 'CONNECTION_ADMIN', 'ACTIVE', 'ADMIN')`;
					for (const release of [sourceId, targetId])
						await sql`INSERT INTO connection_provider_releases
 (id, provider, source_commit, deployment_profile, auth_profile, executor_digest, catalog_checksum, status)
 VALUES (${release}, ${provider}, ${suffix}, ${sql.json(release === targetId && scenario === "deployment" ? { region: "changed" } : {})}, ${sql.json(release === targetId && scenario === "auth" ? { type: "changed" } : {})},
 ${`sha256:${(release === targetId && scenario === "unproven" ? "b" : "a").repeat(64)}`}, ${`connection-json-v1:${"c".repeat(64)}`}, 'PUBLISHED')`;
					await sql`INSERT INTO connection_action_versions (id, provider_release_id, name, description, effect, input_schema, required_scopes, status)
 VALUES (${oldAction}, ${sourceId}, 'test.read', 'Read', 'READ', '{}'::jsonb, '[]'::jsonb, 'PUBLISHED'),
 (${newAction}, ${targetId}, ${scenario === "removed" ? "test.other" : "test.read"}, ${scenario === "description" ? "Changed meaning" : "Read"}, ${scenario === "effect" ? "WRITE" : "READ"}, ${sql.json(scenario === "schema" ? { type: "object" } : {})}, ${sql.json(scenario === "scope" ? ["write"] : [])}, 'PUBLISHED')`;
					if (scenario === "added")
						await sql`INSERT INTO connection_action_versions (id, provider_release_id, name, description, effect, input_schema, required_scopes, status)
 VALUES (${addedAction}, ${targetId}, 'test.write', 'Write', 'WRITE', '{}'::jsonb, '[]'::jsonb, 'PUBLISHED')`;
					await plain.createCapabilityProfileDraft({
						id: profileId,
						providerReleaseId: sourceId,
						name: "Stable package",
						actionVersionIds: [oldAction],
					});
					await plain.publishCapabilityProfile({
						actorPrincipalId: admin,
						capabilityProfileId: profileId,
					});
					await plain.createDisclaimerDraft({
						id: disclaimerId,
						kind: "GLOBAL",
						locale: "zh-CN",
						content: "Terms",
						materialChange: false,
						ownerMetadata: {},
					});
					await plain.publishDisclaimer({
						actorPrincipalId: admin,
						disclaimerVersionId: disclaimerId,
					});
					await plain.createPolicyDraft({
						id: policyId,
						createdByPrincipalId: admin,
						providerReleaseId: sourceId,
						capabilityProfileId: profileId,
						priority: 100,
						allowPermanent: true,
						requestTtlSeconds: 86400,
						connectTtlSeconds: 3600,
						renewalLeadSeconds: 0,
						durations: [{ id: `duration-${suffix}`, kind: "PERMANENT" }],
						disclaimerVersionIds: [disclaimerId],
						stages: [
							{
								id: `stage-${suffix}`,
								name: "Review",
								quorumType: "ANY",
								timeoutSeconds: 86400,
								approvers: [{ principalId: admin, displaySnapshot: {} }],
							},
						],
					});
					await plain.publishPolicy({
						actorPrincipalId: admin,
						policyVersionId: policyId,
						materialChange: false,
					});
					await sql`INSERT INTO connection_access_requests (id, applicant_principal_id, provider_release_id, capability_profile_id, policy_version_id, purpose, duration_kind, state, expires_at)
 VALUES (${requestId}, ${user}, ${sourceId}, ${profileId}, ${policyId}, 'Work', 'PERMANENT', 'CONSUMED', now() + interval '1 day')`;
					const accountId = `account-${suffix}`;
					await sql`INSERT INTO connection_accounts (id, owner_type, owner_principal_id, provider_release_id, provider_id, external_account, display_name, status)
 VALUES (${accountId}, 'PERSONAL', ${user}, ${sourceId}, ${provider}, 'stable-account', 'Account', 'ACTIVE')`;
					await sql`INSERT INTO connection_credential_versions (id, connection_id, ciphertext, nonce, tag, scope_json, status)
 VALUES (${`credential-${suffix}`}, ${accountId}, 'fixture', 'fixture', 'fixture', '[]'::jsonb, 'ACTIVE')`;
					await sql`INSERT INTO connection_access_authorizations (id, principal_id, connection_id, provider_release_id, capability_profile_id, source, source_request_id, external_account_fingerprint, state, validity_kind)
 VALUES (${`authorization-${suffix}`}, ${user}, ${accountId}, ${sourceId}, ${profileId}, 'APPROVED_REQUEST', ${requestId}, ${canonicalHash({ externalAccount: "stable-account", providerReleaseId: sourceId })}, 'ACTIVE', 'PERMANENT')`;
					const snapshot = async () =>
						(
							await sql`SELECT to_jsonb(request) AS request, to_jsonb(access) AS access, to_jsonb(account) AS account, to_jsonb(credential) AS credential FROM connection_access_requests request
 JOIN connection_access_authorizations access ON access.source_request_id = request.id JOIN connection_accounts account ON account.id = access.connection_id JOIN connection_credential_versions credential ON credential.connection_id = account.id WHERE request.id = ${requestId}`
						)[0];
					const before = await snapshot();
					// Two runtime starts must serialize on the source and never duplicate current packages or notices.
					await Promise.all([
						catalog.reconcileCapabilityProfiles(),
						catalog.reconcileCapabilityProfiles(),
					]);
					await catalog.reconcileCapabilityProfiles();
					expect(await snapshot()).toEqual(before);
					const result = await catalog.listCatalog();
					const profiles = result.profiles.filter(
						(item) => item.providerId === provider,
					);
					const automatic =
						scenario === "compatible" ||
						scenario === "added" ||
						scenario === "reviewed-fix";
					const current = profiles.find((item) => item.status === "PUBLISHED");
					expect(current?.providerReleaseId).toBe(
						automatic ? targetId : sourceId,
					);
					expect(
						profiles.filter((item) => item.status === "PUBLISHED"),
					).toHaveLength(1);
					expect(profiles).toHaveLength(automatic ? 2 : 1);
					const members =
						await sql`SELECT action_version_id FROM connection_capability_profile_actions WHERE capability_profile_id = ${current?.id ?? ""}`;
					expect(members.map((item) => item.action_version_id)).toEqual([
						automatic ? newAction : oldAction,
					]);
					const policies = result.policies.filter(
						(item) =>
							item.id === policyId || item.capabilityProfileId === current?.id,
					);
					expect(
						policies.filter((item) => item.status === "PUBLISHED"),
					).toHaveLength(1);
					expect(
						policies.find((item) => item.status === "PUBLISHED")
							?.providerReleaseId,
					).toBe(automatic ? targetId : sourceId);
					if (automatic) {
						expect(verify).toHaveBeenCalledWith(admin);
						const [audit] =
							await sql`SELECT principal_id, detail FROM connection_audit_records WHERE event = 'connection.capability-profile.compatible-upgrade' AND detail->>'sourceProfileId' = ${profileId}`;
						expect(audit?.principal_id).toBeNull();
						await expect(
							sql`INSERT INTO connection_audit_records (actor_kind, event) VALUES ('SYSTEM', 'CALL_AUTHORIZED')`,
						).rejects.toMatchObject({ code: "23514" });
						expect(audit?.detail.mapping).toEqual([
							{ source_id: oldAction, target_id: newAction },
						]);
					}
					if (scenario === "compatible" || scenario === "reviewed-fix")
						expect(current?.upgrade).toBeUndefined();
					else {
						expect(current?.upgrade?.targetProviderReleaseId).toBe(targetId);
						const pending =
							await sql`SELECT id FROM connection_outbox_events WHERE topic = 'connection.capability-profile.update-required' AND payload->>'sourceProfileId' = ${current?.id ?? ""}`;
						expect(pending).toHaveLength(1);
						while (await dispatcher.runOnce()) {
							/* drain this isolated database */
						}
						const notifications = await requests.listNotifications(admin);
						expect(
							notifications.items.filter(
								(item) =>
									item.businessType === "CAPABILITY_PROFILE_UPDATE" &&
									item.businessId === pending[0]?.id,
							),
						).toHaveLength(1);
						expect(
							(await requests.listNotifications(user)).items.some(
								(item) => item.businessId === pending[0]?.id,
							),
						).toBe(false);
						const notice = notifications.items.find(
							(item) => item.businessId === pending[0]?.id,
						);
						if (!notice || !current) throw new Error("Missing admin update");
						await expect(
							requests.markNotification(user, notice.id, false),
						).rejects.toMatchObject({ code: "FORBIDDEN" });
						await requests.markNotification(admin, notice.id, false);
						await sql`UPDATE connection_principal_roles SET status = 'REVOKED', revoked_at = now() WHERE principal_id = ${admin} AND role = 'CONNECTION_ADMIN'`;
						expect(
							(await requests.listNotifications(admin)).items.some(
								(item) => item.id === notice.id,
							),
						).toBe(false);
						await expect(
							requests.markNotification(admin, notice.id, false),
						).rejects.toMatchObject({ code: "FORBIDDEN" });
						await sql`UPDATE connection_principal_roles SET status = 'ACTIVE', revoked_at = NULL WHERE principal_id = ${admin} AND role = 'CONNECTION_ADMIN'`;
						let manualTarget = targetId;
						let manualAction = newAction;
						if (scenario === "directory-disabled") {
							manualTarget = `next-target-${suffix}`;
							manualAction = `next-action-${suffix}`;
							await sql`INSERT INTO connection_provider_releases (id, provider, source_commit, deployment_profile, auth_profile, executor_digest, catalog_checksum, status)
 VALUES (${manualTarget}, ${provider}, ${suffix}, '{}'::jsonb, '{}'::jsonb, ${`sha256:${"a".repeat(64)}`}, ${`connection-json-v1:${"d".repeat(64)}`}, 'PUBLISHED')`;
							await sql`INSERT INTO connection_action_versions (id, provider_release_id, name, description, effect, input_schema, required_scopes, status)
 VALUES (${manualAction}, ${manualTarget}, 'test.read', 'Read', 'READ', '{}'::jsonb, '[]'::jsonb, 'PUBLISHED')`;
							runtime.providerReleases.set(provider, manualTarget);
							await catalog.reconcileCapabilityProfiles();
							while (await dispatcher.runOnce()) {
								/* drain updated target projection */
							}
							expect(
								(await requests.listNotifications(admin)).items.some(
									(item) => item.id === notice.id,
								),
							).toBe(false);
							expect(
								(await requests.listWorkItems(admin)).find(
									(item) => item.businessId === notice.businessId,
								)?.status,
							).toBe("CANCELED");
							expect(
								(await catalog.listCatalog()).profiles.find(
									(item) => item.id === current.id,
								)?.upgrade?.targetProviderReleaseId,
							).toBe(manualTarget);
						}
						const revisionInput = {
							id: "unused",
							sourceId: current.id,
							expectedRevision: current.revision,
							name: "Stable package",
							providerReleaseId: manualTarget,
							actionVersionIds: [manualAction],
						};
						await expect(
							catalog.revisePublishedCapabilityProfile({
								...revisionInput,
								actorPrincipalId: user,
							}),
						).rejects.toMatchObject({ code: "FORBIDDEN" });
						await catalog.revisePublishedCapabilityProfile({
							...revisionInput,
							actorPrincipalId: admin,
						});
						expect(
							(await requests.listWorkItems(admin)).filter(
								(item) =>
									item.businessId === notice.businessId &&
									item.status === "OPEN",
							),
						).toHaveLength(0);
						await expect(
							catalog.revisePublishedCapabilityProfile({
								...revisionInput,
								actorPrincipalId: admin,
							}),
						).rejects.toMatchObject({ code: "INVALID_REQUEST" });
						expect(await snapshot()).toEqual(before);
					}
				} finally {
					await Promise.all([
						sql.end(),
						plain.close(),
						catalog.close(),
						requests.close(),
						dispatcher.close(),
					]);
				}
			},
			30000,
		);
	}
});
