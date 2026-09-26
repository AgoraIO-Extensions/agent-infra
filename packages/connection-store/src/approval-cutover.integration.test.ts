import { randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresConnectionAccessRequestRepository } from "./access-request-repository";
import { PostgresConnectionApprovalRepository } from "./approval-repository";
import { migrateConnectionDatabase } from "./migrations";
import { PostgresConnectionNotificationDispatcher } from "./notification-dispatcher";
import { PostgresConnectionRepository } from "./repository";
import { assertIsolatedTestDatabaseUrl } from "./test-database";

const databaseUrl = process.env.CONNECTION_CUTOVER_TEST_DATABASE_URL;
assertIsolatedTestDatabaseUrl(databaseUrl, process.env.DATABASE_URL);
if (process.env.CI && !databaseUrl) {
	throw new Error("CONNECTION_CUTOVER_TEST_DATABASE_URL is required in CI");
}
const integrationTest = databaseUrl ? it : it.skip;

describe("personal Connection approval cutover", () => {
	integrationTest(
		"baselines only the existing account and atomically enforces approval",
		async () => {
			if (!databaseUrl) return;
			const migrationsDirectory = resolve(
				import.meta.dirname,
				"../../../migrations/connection",
			);
			const baselineDirectory = await mkdtemp(
				resolve(tmpdir(), "connection-audit-baseline-"),
			);
			const probe = postgres(databaseUrl);
			try {
				const journal = JSON.parse(
					await readFile(
						resolve(migrationsDirectory, "meta/_journal.json"),
						"utf8",
					),
				);
				journal.entries = journal.entries.filter(
					(entry: { tag: string }) =>
						entry.tag !== "0032_connection_access_approval",
				);
				await mkdir(resolve(baselineDirectory, "meta"));
				await writeFile(
					resolve(baselineDirectory, "meta/_journal.json"),
					JSON.stringify(journal),
				);
				for (const entry of journal.entries) {
					await copyFile(
						resolve(migrationsDirectory, `${entry.tag}.sql`),
						resolve(baselineDirectory, `${entry.tag}.sql`),
					);
				}
				await migrateConnectionDatabase(databaseUrl, baselineDirectory);
				const [before] =
					await probe`SELECT to_regclass('public.connection_access_enforcement') AS approval_table`;
				expect(before?.approval_table).toBeNull();
				await migrateConnectionDatabase(databaseUrl, migrationsDirectory);
				await migrateConnectionDatabase(databaseUrl, migrationsDirectory);
				const [after] =
					await probe`SELECT to_regclass('public.connection_access_enforcement') AS approval_table, (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations`;
				expect(after).toEqual({
					approval_table: "connection_access_enforcement",
					migrations: journal.entries.length + 1,
				});
			} finally {
				await probe.end();
				await rm(baselineDirectory, { recursive: true, force: true });
			}
			await migrateConnectionDatabase(
				databaseUrl,
				resolve(import.meta.dirname, "../../../migrations/connection"),
			);
			const suffix = randomUUID();
			const principalId = `cutover-principal-${suffix}`;
			const releaseId = `cutover-release-${suffix}`;
			const connectionId = `cutover-connection-${suffix}`;
			const actionId = `cutover.read@${suffix}`;
			const writeActionId = `cutover.write@${suffix}`;
			const consumerId = `cutover-consumer-${suffix}`;
			const rootId = `cutover-root-${suffix}`;
			const grantId = `cutover-grant-${suffix}`;
			const repository = new PostgresConnectionApprovalRepository(databaseUrl);
			const access = new PostgresConnectionAccessRequestRepository(databaseUrl);
			const dispatcher = new PostgresConnectionNotificationDispatcher(
				databaseUrl,
			);
			const connections = new PostgresConnectionRepository(
				databaseUrl,
				Buffer.alloc(32, 7),
			);
			const sql = postgres(databaseUrl);
			try {
				await sql`INSERT INTO connection_principals (id, display_name) VALUES (${principalId}, 'Cutover owner')`;
				await sql`
				INSERT INTO connection_provider_releases (
					id, provider, source_commit, deployment_profile, auth_profile,
					executor_digest, catalog_checksum, status
				) VALUES (
					${releaseId}, ${`cutover-provider-${suffix}`}, ${suffix},
					'{}'::jsonb, '{}'::jsonb, ${`sha256:${"a".repeat(64)}`},
					${`connection-json-v1:${"b".repeat(64)}`}, 'PUBLISHED'
				)
			`;
				await sql`
				INSERT INTO connection_principal_roles (
					principal_id, role, status, grant_source
				) VALUES (${principalId}, 'CONNECTION_ADMIN', 'ACTIVE', 'BOOTSTRAP')
			`;
				await sql`
				INSERT INTO connection_accounts (
					id, owner_type, owner_principal_id, shared_scope_id, provider_release_id,
					provider_id, external_account, display_name, status
				) VALUES (
					${connectionId}, 'PERSONAL', ${principalId}, NULL, ${releaseId},
					${`cutover-provider-${suffix}`}, 'existing-account', 'Existing', 'ACTIVE'
				)
			`;
				await expect(
					connections.validatePersonalConnectRequest({
						principalId,
						providerId: `cutover-provider-${suffix}`,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(sql`
					INSERT INTO connection_pre_launch_accounts (connection_id) VALUES (${connectionId})
				`).rejects.toThrow("Pre-launch account inventory is immutable");
				// Seed a pre-migration account in the isolated fixture, then restore its guard.
				await sql`ALTER TABLE connection_pre_launch_accounts DISABLE TRIGGER connection_pre_launch_inventory_immutable`;
				await sql`INSERT INTO connection_pre_launch_accounts (connection_id) VALUES (${connectionId})`;
				await sql`ALTER TABLE connection_pre_launch_accounts ENABLE TRIGGER connection_pre_launch_inventory_immutable`;
				await sql`
				INSERT INTO connection_credential_versions (
					id, connection_id, ciphertext, nonce, tag, scope_json, status
				) VALUES (
					${`cutover-credential-${suffix}`}, ${connectionId},
					'fixture', 'fixture', 'fixture', '["existing.read"]'::jsonb, 'ACTIVE'
				)
			`;
				await sql`
				INSERT INTO connection_action_versions (
					id, provider_release_id, name, description, effect,
					input_schema, required_scopes, status
				) VALUES (
					${actionId}, ${releaseId}, 'cutover.read', 'Existing READ', 'READ',
					'{"type":"object","required":[]}'::jsonb, '["existing.read"]'::jsonb, 'PUBLISHED'
				)
			`;
				await sql`
					INSERT INTO connection_action_versions (
						id, provider_release_id, name, description, effect,
						input_schema, required_scopes, status
					) VALUES (
						${writeActionId}, ${releaseId}, 'cutover.write', 'Unapproved WRITE', 'WRITE',
						'{"type":"object","required":[]}'::jsonb, '["existing.read"]'::jsonb, 'PUBLISHED'
					)
				`;
				await sql`
				INSERT INTO connection_consumers (id, display_name, status)
				VALUES (${consumerId}, 'Existing consumer', 'ACTIVE')
			`;
				await sql`
					INSERT INTO connection_consumer_instances (
						id, consumer_id, kind, auth_subject, status, principal_id
					) VALUES (
						${`cutover-instance-${suffix}`}, ${consumerId}, 'DEVICE',
						${`subject-${suffix}`}, 'ACTIVE', ${principalId}
					)
				`;
				await sql`
				INSERT INTO connection_authorization_roots (
					id, principal_id, consumer_id, provider_id, status
				) VALUES (
					${rootId}, ${principalId}, ${consumerId},
					${`cutover-provider-${suffix}`}, 'ACTIVE'
				)
			`;
				await sql`
				INSERT INTO connection_grants (
					id, principal_id, consumer_id, connection_id, status,
					root_id, provider_id
				) VALUES (
					${grantId}, ${principalId}, ${consumerId}, ${connectionId},
					'ACTIVE', ${rootId}, ${`cutover-provider-${suffix}`}
				)
			`;
				await sql`
				INSERT INTO connection_grant_actions (grant_id, action_version_id)
				VALUES (${grantId}, ${actionId})
			`;
				await sql`
				UPDATE connection_authorization_roots
				SET current_grant_id = ${grantId} WHERE id = ${rootId}
			`;
				await connections.publishConsumerDeclaration({
					actionVersionIds: [actionId, writeActionId],
					consumer: { id: consumerId, name: "Existing consumer" },
					providerReleaseId: releaseId,
				});
				const legacyPreview =
					await connections.createCurrentConsumerAuthorizationPreview({
						connectionId,
						consumerId,
						principalId,
					});
				expect(legacyPreview.actions.map((action) => action.id)).toEqual([
					actionId,
				]);
				await expect(
					connections.createCurrentConsumerAuthorizationPreview({
						connectionId,
						consumerId,
						principalId,
						actionVersionIds: [writeActionId],
					}),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				const newUnapprovedId = `cutover-unapproved-${suffix}`;
				await sql`
					INSERT INTO connection_accounts (
						id, owner_type, owner_principal_id, provider_release_id,
						provider_id, external_account, display_name, status
					) VALUES (
						${newUnapprovedId}, 'PERSONAL', ${principalId}, ${releaseId},
						${`cutover-provider-${suffix}`}, 'unapproved-new-account', 'New', 'ACTIVE'
					)
				`;
				await expect(
					repository.activatePreLaunchBaseline(principalId),
				).rejects.toThrow(
					"Unapproved personal Connection was created after the pre-launch inventory",
				);
				await sql`DELETE FROM connection_accounts WHERE id = ${newUnapprovedId}`;
				expect(await repository.activatePreLaunchBaseline(principalId)).toEqual(
					{ baselinedConnections: 1 },
				);
				expect(await repository.activatePreLaunchBaseline(principalId)).toEqual(
					{ baselinedConnections: 1 },
				);
				const [result] = await sql<
					{
						cutoff_at: string;
						profile_scopes: unknown;
						profile_actions: number;
						profile_id: string;
						source: string;
						state: string;
					}[]
				>`
				SELECT enforcement.state, enforcement.cutoff_at,
					access.source, profile.id AS profile_id,
					profile.required_scopes AS profile_scopes,
					(SELECT count(*)::int FROM connection_capability_profile_actions action
					 WHERE action.capability_profile_id = profile.id) AS profile_actions
				FROM connection_access_enforcement enforcement
				JOIN connection_access_authorizations access
					ON access.connection_id = ${connectionId}
				JOIN connection_capability_profiles profile
					ON profile.id = access.capability_profile_id
				WHERE enforcement.id = 'personal'
			`;
				expect(result).toMatchObject({
					profile_actions: 1,
					profile_scopes: ["existing.read"],
					source: "PRE_LAUNCH_BASELINE",
					state: "ENFORCED",
				});
				expect(Date.parse(result?.cutoff_at ?? "")).not.toBeNaN();
				const [evidence] = await sql<
					{ audit_count: number; outbox_count: number }[]
				>`
				SELECT
					(SELECT count(*)::int FROM connection_audit_records
					 WHERE event = 'connection.access-baseline.created') AS audit_count,
					(SELECT count(*)::int FROM connection_outbox_events
					 WHERE topic = 'connection.access-baseline.created') AS outbox_count
			`;
				expect(evidence).toEqual({ audit_count: 1, outbox_count: 1 });
				expect(await dispatcher.runOnce()).toBe(true);
				expect(await dispatcher.runOnce()).toBe(true);
				const [deliveredApproval] = await sql<{ count: number }[]>`
					SELECT count(*)::int AS count FROM connection_outbox_events
					WHERE topic IN ('connection.access-baseline.created',
						'connection.access-enforcement.activated') AND status = 'DELIVERED'
				`;
				expect(deliveredApproval?.count).toBe(2);
				await sql`
					UPDATE connection_outbox_events SET status = 'PENDING', delivered_at = NULL
					WHERE topic = 'connection.access-baseline.created'
				`;
				expect(await dispatcher.runOnce()).toBe(true);
				const [replayedApproval] = await sql<{ count: number }[]>`
					SELECT count(*)::int AS count FROM connection_access_authorizations
					WHERE source = 'PRE_LAUNCH_BASELINE'
				`;
				expect(replayedApproval?.count).toBe(1);
				const overview = await connections.getOverview(principalId, {
					includeActivity: false,
				});
				expect(
					overview.connections.find((item) => item.id === connectionId)
						?.accessAuthorization,
				).toMatchObject({
					state: "ACTIVE",
					validityKind: "PERMANENT",
					validUntil: null,
				});
				const targetReleaseId = `cutover-target-${suffix}`;
				const campaignId = `cutover-campaign-${suffix}`;
				const taskId = `cutover-task-${suffix}`;
				const requiredEventId = `cutover-outbox-required-${suffix}`;
				await sql`
					INSERT INTO connection_provider_releases (
						id, provider, source_commit, deployment_profile, auth_profile,
						executor_digest, catalog_checksum, status
					) VALUES (
						${targetReleaseId}, ${`cutover-provider-${suffix}`}, ${`target-${suffix}`},
						'{}'::jsonb, '{}'::jsonb, ${`sha256:${"c".repeat(64)}`},
						${`connection-json-v1:${"d".repeat(64)}`}, 'PUBLISHED'
					)
				`;
				await sql`
					INSERT INTO connection_provider_upgrade_campaigns (
						id, provider_id, source_provider_release_id,
						target_provider_release_id, reason
					) VALUES (
						${campaignId}, ${`cutover-provider-${suffix}`},
						${releaseId}, ${targetReleaseId}, 'Approved test upgrade'
					)
				`;
				await sql`
					INSERT INTO connection_provider_upgrade_tasks (
						id, campaign_id, principal_id, connection_id,
						authorization_root_id, consumer_id, provider_id, actor_key, status
					) VALUES (
						${taskId}, ${campaignId}, ${principalId}, ${connectionId},
						${rootId}, ${consumerId}, ${`cutover-provider-${suffix}`}, '', 'PENDING_CONNECTION'
					)
				`;
				await sql`
					INSERT INTO connection_outbox_events (id, topic, aggregate_id, payload)
					VALUES (${requiredEventId}, 'connection.provider-upgrade.required',
						${taskId}, '{}'::jsonb)
				`;
				expect(await dispatcher.runOnce()).toBe(true);
				expect(
					(await access.listNotifications(principalId)).upgradeWorkItems,
				).toBe(1);
				await sql`
					UPDATE connection_outbox_events
					SET status = 'PENDING', delivered_at = NULL
					WHERE id = ${requiredEventId}
				`;
				expect(await dispatcher.runOnce()).toBe(true);
				const [delivery] = await sql<
					{ notifications: number; status: string }[]
				>`
					SELECT event.status,
						(SELECT count(*)::int FROM connection_notifications notification
						 WHERE notification.business_id = ${taskId}) AS notifications
					FROM connection_outbox_events event WHERE event.id = ${requiredEventId}
				`;
				expect(delivery).toEqual({ notifications: 1, status: "DELIVERED" });
				await sql`UPDATE connection_provider_upgrade_tasks SET status = 'EXPIRED' WHERE id = ${taskId}`;
				await sql`
					INSERT INTO connection_outbox_events (id, topic, aggregate_id, payload)
					VALUES (${`cutover-outbox-expired-${suffix}`}, 'connection.provider-upgrade.expired',
						${taskId}, '{}'::jsonb)
				`;
				expect(await dispatcher.runOnce()).toBe(true);
				expect(
					(await access.listNotifications(principalId)).upgradeWorkItems,
				).toBe(0);
				const missingEventId = `cutover-outbox-missing-${suffix}`;
				await sql`
					INSERT INTO connection_outbox_events (id, topic, aggregate_id, payload)
					VALUES (${missingEventId}, 'connection.provider-upgrade.required',
						${`missing-task-${suffix}`}, '{}'::jsonb)
				`;
				await expect(dispatcher.runOnce()).rejects.toThrow("target is missing");
				const [retry] = await sql<{ attempt_count: number; status: string }[]>`
					SELECT attempt_count, status FROM connection_outbox_events
					WHERE id = ${missingEventId}
				`;
				expect(retry).toEqual({ attempt_count: 1, status: "PENDING" });
				const missingAuditEventId = `cutover-outbox-missing-audit-${suffix}`;
				await sql`
					INSERT INTO connection_outbox_events (id, topic, aggregate_id, payload)
					VALUES (${missingAuditEventId}, 'connection.access-request.created',
						${`missing-request-${suffix}`}, '{}'::jsonb)
				`;
				await expect(dispatcher.runOnce()).rejects.toThrow(
					"audit fact is missing",
				);
				const [auditRetry] = await sql<
					{ attempt_count: number; status: string }[]
				>`
					SELECT attempt_count, status FROM connection_outbox_events
					WHERE id = ${missingAuditEventId}
				`;
				expect(auditRetry).toEqual({ attempt_count: 1, status: "PENDING" });
				const priorUnread = (await access.listNotifications(principalId))
					.unreadCount;
				await sql`
					UPDATE connection_outbox_events
					SET attempt_count = 9, available_at = now()
					WHERE id = ${missingAuditEventId}
				`;
				await expect(dispatcher.runOnce()).rejects.toThrow(
					"audit fact is missing",
				);
				const [failedEvent] = await sql<
					{ attempt_count: number; status: string }[]
				>`
					SELECT attempt_count, status FROM connection_outbox_events
					WHERE id = ${missingAuditEventId}
				`;
				expect(failedEvent).toEqual({ attempt_count: 10, status: "FAILED" });
				expect(await dispatcher.listFailures("not-an-admin")).toEqual([]);
				expect(await dispatcher.listFailures(principalId)).toEqual([
					expect.objectContaining({
						id: missingAuditEventId,
						attemptCount: 10,
					}),
				]);
				const failedNotifications = await access.listNotifications(principalId);
				expect(failedNotifications.adminWorkItems).toBe(1);
				expect(failedNotifications.unreadCount).toBe(priorUnread);
				const failedNotice = failedNotifications.items.find(
					(item) =>
						item.businessId === missingAuditEventId &&
						item.eventType === "DISPATCH_FAILED",
				);
				if (!failedNotice)
					throw new Error("Admin dispatch failure notice is missing");
				await access.markNotifications(principalId, [failedNotice.id], true);
				expect(
					(await access.listNotifications(principalId)).adminWorkItems,
				).toBe(1);
				await expect(
					dispatcher.retryFailure("not-an-admin", missingAuditEventId, 10),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(
					dispatcher.retryFailure(principalId, missingAuditEventId, 9),
				).rejects.toMatchObject({ code: "INVALID_REQUEST" });
				await sql`
					INSERT INTO connection_audit_records (principal_id, event, detail)
					VALUES (${principalId}, 'connection.access-request.created',
						${sql.json({ aggregateId: `missing-request-${suffix}` })})
				`;
				expect(
					await dispatcher.retryFailure(principalId, missingAuditEventId, 10),
				).toEqual({ eventId: missingAuditEventId });
				await expect(
					dispatcher.retryFailure(principalId, missingAuditEventId, 10),
				).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
				expect(await dispatcher.runOnce()).toBe(true);
				expect(await dispatcher.listFailures(principalId)).toEqual([]);
				expect(
					(await access.listNotifications(principalId)).adminWorkItems,
				).toBe(0);
				const unknownEventId = `cutover-outbox-unknown-${suffix}`;
				await sql`
					INSERT INTO connection_outbox_events (id, topic, aggregate_id, payload)
					VALUES (${unknownEventId}, 'connection.unrecognized-topic',
						${connectionId}, '{}'::jsonb)
				`;
				expect(await dispatcher.runOnce()).toBe(false);
				const [unknown] = await sql<{ status: string }[]>`
					SELECT status FROM connection_outbox_events WHERE id = ${unknownEventId}
				`;
				expect(unknown?.status).toBe("PENDING");
				if (!result?.profile_id) throw new Error("Baseline profile is missing");
				expect(
					await access.createReapprovalCampaign({
						actorPrincipalId: principalId,
						capabilityProfileId: result.profile_id,
						deadlineAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
						id: `cutover-reapproval-${suffix}`,
						providerReleaseId: releaseId,
						reason: "Provider authorization semantics changed",
						triggerKind: "PROVIDER_RELEASE",
						triggerVersionId: targetReleaseId,
					}),
				).toEqual({
					campaignId: `cutover-reapproval-${suffix}`,
					affectedConnections: 1,
				});
				expect(
					(await access.listNotifications(principalId)).reapprovalWorkItems,
				).toBe(1);
				await sql`
					UPDATE connection_access_authorizations
					SET reapproval_deadline_at = now() - interval '1 second'
					WHERE connection_id = ${connectionId}
				`;
				expect(await access.expireDueAuthorizations()).toBe(1);
				const [suspended] = await sql<
					{ grant_status: string; state: string }[]
				>`
					SELECT access.state, grant_version.status AS grant_status
					FROM connection_access_authorizations access
					JOIN connection_grants grant_version
						ON grant_version.connection_id = access.connection_id
					WHERE access.connection_id = ${connectionId}
				`;
				expect(suspended).toEqual({
					state: "SUSPENDED",
					grant_status: "PAUSED_CONNECTION",
				});
				expect(
					(await access.listNotifications(principalId)).reapprovalWorkItems,
				).toBe(0);
				const [expiredWork] = await sql<
					{ work_status: string; target_status: string }[]
				>`
					SELECT item.status AS work_status, target.status AS target_status
					FROM connection_access_authorizations access
					JOIN connection_work_items item ON item.business_id = access.id AND item.action_type = 'REAPPROVE'
					JOIN connection_access_reapproval_targets target ON target.access_authorization_id = access.id
					WHERE access.connection_id = ${connectionId}
				`;
				expect(expiredWork).toEqual({
					work_status: "EXPIRED",
					target_status: "CANCELED",
				});
				expect(await access.expireDueAuthorizations()).toBe(0);
				const [authorization] = await sql<{ id: string; revision: string }[]>`
					SELECT id, revision::text FROM connection_access_authorizations
					WHERE connection_id = ${connectionId}
				`;
				if (!authorization)
					throw new Error("Baseline authorization is missing");
				expect(
					(await access.listCurrentAuthorizations(principalId))[0]?.id,
				).toBe(authorization.id);
				await expect(
					access.revokeAuthorization({
						actorPrincipalId: "not-an-admin",
						authorizationId: authorization.id,
						expectedRevision: authorization.revision,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(
					access.revokeAuthorization({
						actorPrincipalId: principalId,
						authorizationId: authorization.id,
						expectedRevision: "0",
					}),
				).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
				expect(
					await access.revokeAuthorization({
						actorPrincipalId: principalId,
						authorizationId: authorization.id,
						expectedRevision: authorization.revision,
					}),
				).toEqual({ authorizationId: authorization.id });
				const [revoked] = await sql<{ state: string; notifications: number }[]>`
				SELECT access.state,
					(SELECT count(*)::int FROM connection_notifications notification
					 WHERE notification.business_id = access.id AND notification.event_type = 'REVOKED')
						AS notifications
				FROM connection_access_authorizations access WHERE access.id = ${authorization.id}
			`;
				expect(revoked).toEqual({ state: "REVOKED", notifications: 1 });
				const [targetState] = await sql<{ status: string }[]>`
				SELECT status FROM connection_access_reapproval_targets
				WHERE access_authorization_id = ${authorization.id}
			`;
				expect(targetState?.status).toBe("CANCELED");
			} finally {
				await dispatcher.close();
				await access.close();
				await connections.close();
				await repository.close();
				await sql.end();
			}
		},
		30_000,
	);
});
