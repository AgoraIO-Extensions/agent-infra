import { ConnectionError } from "@agent-infra/connection-core";
import postgres, { type Sql } from "postgres";

const topics = [
	"connection.provider-upgrade.required",
	"connection.provider-upgrade.authorization-required",
	"connection.provider-upgrade.completed",
	"connection.provider-upgrade.expired",
	"connection.provider-upgrade.superseded",
] as const;

const approvalTopics = [
	"connection.access-authorization.created",
	"connection.access-authorization.expired",
	"connection.access-authorization.reapproval-required",
	"connection.access-authorization.renewed",
	"connection.access-authorization.revoked",
	"connection.access-authorization.policy-suspended",
	"connection.access-authorization.suspended",
	"connection.access-baseline.created",
	"connection.access-enforcement.activated",
	"connection.access-policy.published",
	"connection.access-policy.draft-updated",
	"connection.access-policy.revoked",
	"connection.access-request.approve",
	"connection.access-request.canceled",
	"connection.access-request.created",
	"connection.access-request.expired",
	"connection.access-request.policy-revoked",
	"connection.access-request.reject",
	"connection.access-request.rerouted",
	"connection.approval-delegation.created",
	"connection.approval-delegation.revoked",
	"connection.capability-profile.published",
	"connection.disclaimer.published",
	"connection.reapproval-campaign.created",
] as const;

export class PostgresConnectionNotificationDispatcher {
	private readonly sql: Sql;

	constructor(databaseUrl: string) {
		this.sql = postgres(databaseUrl, { max: 2 });
	}

	close() {
		return this.sql.end();
	}

	async listFailures(principalId: string) {
		const rows = await this.sql<
			{
				attempt_count: number;
				created_at: Date;
				id: string;
				topic: string;
			}[]
		>`
			SELECT event.id, event.topic, event.attempt_count, event.created_at
			FROM connection_outbox_events event
			WHERE event.status = 'FAILED'
				AND event.topic IN ${this.sql([...topics, ...approvalTopics])}
				AND EXISTS (
					SELECT 1 FROM connection_principal_roles role_binding
					JOIN connection_principals principal ON principal.id = role_binding.principal_id
					WHERE principal.id = ${principalId} AND principal.status = 'ACTIVE'
						AND role_binding.role = 'CONNECTION_ADMIN'
						AND role_binding.status = 'ACTIVE'
				)
			ORDER BY event.created_at, event.id LIMIT 100
		`;
		return rows.map((row) => ({
			attemptCount: row.attempt_count,
			createdAt: row.created_at.toISOString(),
			id: row.id,
			topic: row.topic,
		}));
	}

	async retryFailure(
		principalId: string,
		eventId: string,
		expectedAttempts: number,
	) {
		if (!Number.isSafeInteger(expectedAttempts) || expectedAttempts < 10)
			throw new ConnectionError(
				"INVALID_REQUEST",
				"Outbox attempt count is invalid",
			);
		return this.sql.begin(async (sql) => {
			const [admin] = await sql<{ id: string }[]>`
				SELECT principal.id FROM connection_principal_roles role_binding
				JOIN connection_principals principal ON principal.id = role_binding.principal_id
				WHERE principal.id = ${principalId} AND principal.status = 'ACTIVE'
					AND role_binding.role = 'CONNECTION_ADMIN'
					AND role_binding.status = 'ACTIVE'
				FOR SHARE OF principal, role_binding
			`;
			if (!admin)
				throw new ConnectionError("FORBIDDEN", "Administrator required");
			const [event] = await sql<{ id: string }[]>`
				UPDATE connection_outbox_events
				SET status = 'PENDING', attempt_count = 0, available_at = now(), delivered_at = NULL
				WHERE id = ${eventId} AND status = 'FAILED'
					AND attempt_count = ${expectedAttempts}
					AND topic IN ${sql([...topics, ...approvalTopics])}
				RETURNING id
			`;
			if (!event)
				throw new ConnectionError(
					"IDEMPOTENCY_CONFLICT",
					"Outbox event changed",
				);
			await sql`
				INSERT INTO connection_audit_records (principal_id, event, detail)
				VALUES (${principalId}, 'connection.outbox.retry-requested',
					${sql.json({ aggregateId: eventId })})
			`;
			return { eventId };
		});
	}

	private async completeFailureWorkItems(
		sql: postgres.TransactionSql,
		eventId: string,
	) {
		await sql`
			UPDATE connection_work_items
			SET status = 'COMPLETED', completed_at = now(), updated_at = now(),
				business_revision = business_revision + 1
			WHERE business_type = 'CONNECTION_DISPATCH_FAILURE'
				AND business_id = ${eventId} AND status = 'OPEN'
		`;
	}

	async runOnce() {
		let eventId: string | undefined;
		try {
			return await this.sql.begin(async (sql) => {
				const [event] = await sql<
					{
						aggregate_id: string;
						id: string;
						topic: string;
						source_aggregate_id: string | null;
						aggregate_revision: string | null;
					}[]
				>`
					SELECT id, topic, aggregate_id, payload->>'aggregateId' AS source_aggregate_id,
						payload->>'aggregateRevision' AS aggregate_revision FROM connection_outbox_events
					WHERE status = 'PENDING' AND available_at <= now()
						AND topic IN ${sql([...topics, ...approvalTopics])}
					ORDER BY available_at, id LIMIT 1
					FOR UPDATE SKIP LOCKED
				`;
				if (!event) return false;
				eventId = event.id;
				if (approvalTopics.some((topic) => topic === event.topic)) {
					const versionedEvent =
						event.topic === "connection.access-policy.draft-updated" ||
						event.aggregate_revision !== null;
					if (
						versionedEvent &&
						(!event.source_aggregate_id ||
							!event.aggregate_revision ||
							event.aggregate_id !==
								`${event.source_aggregate_id}:${event.aggregate_revision}`)
					)
						throw new Error("Versioned approval outbox identity is invalid");
					const [audit] = await sql<{ id: string }[]>`
						SELECT id FROM connection_audit_records
						WHERE event = ${event.topic}
							AND detail->>'aggregateId' = ${versionedEvent ? event.source_aggregate_id : event.aggregate_id}
							AND (NOT ${versionedEvent} OR detail->>'aggregateRevision' = ${event.aggregate_revision})
						LIMIT 1
					`;
					if (!audit) throw new Error("Approval outbox audit fact is missing");
					await sql`
						UPDATE connection_outbox_events
						SET status = 'DELIVERED', delivered_at = now(),
							attempt_count = attempt_count + 1
						WHERE id = ${event.id} AND status = 'PENDING'
					`;
					await this.completeFailureWorkItems(sql, event.id);
					return true;
				}
				const [task] = await sql<
					{
						deadline_at: Date | null;
						principal_id: string;
						provider_id: string;
						status: string;
					}[]
				>`
					SELECT task.principal_id, task.provider_id, task.status,
						campaign.deadline_at
					FROM connection_provider_upgrade_tasks task
					JOIN connection_provider_upgrade_campaigns campaign
						ON campaign.id = task.campaign_id
					WHERE task.id = ${event.aggregate_id}
				`;
				if (!task) throw new Error("Provider upgrade outbox target is missing");
				const eventType = event.topic
					.slice("connection.provider-upgrade.".length)
					.toUpperCase()
					.replaceAll("-", "_");
				const terminal =
					task.status === "COMPLETED" || task.status === "EXPIRED";
				const revision = terminal
					? 3
					: task.status === "PENDING_AUTHORIZATION"
						? 2
						: 1;
				const workStatus =
					eventType === "SUPERSEDED"
						? "CANCELED"
						: task.status === "COMPLETED"
							? "COMPLETED"
							: task.status === "EXPIRED"
								? "EXPIRED"
								: "OPEN";
				await sql`
					INSERT INTO connection_work_items (
						id, recipient_principal_id, business_type, business_id,
						business_revision, action_type, status, due_at, completed_at
					) VALUES (
						${`upgrade-work-${event.aggregate_id}`}, ${task.principal_id},
						'PROVIDER_UPGRADE_TASK', ${event.aggregate_id}, ${revision},
						'UPGRADE', ${workStatus}, ${task.deadline_at},
						${terminal ? sql`now()` : null}
					)
					ON CONFLICT (recipient_principal_id, business_type, business_id, action_type)
					DO UPDATE SET status = EXCLUDED.status, due_at = EXCLUDED.due_at,
						completed_at = EXCLUDED.completed_at, updated_at = now(),
						business_revision = EXCLUDED.business_revision
					WHERE connection_work_items.business_revision <= EXCLUDED.business_revision
				`;
				const stale =
					terminal &&
					(eventType === "REQUIRED" || eventType === "AUTHORIZATION_REQUIRED");
				if (!stale) {
					await sql`
						WITH created AS (
							INSERT INTO connection_notifications (
								id, recipient_principal_id, business_type, business_id,
								business_revision, event_type, summary
							) VALUES (
								${`upgrade-notification-${event.id}`}, ${task.principal_id},
								'PROVIDER_UPGRADE_TASK', ${event.aggregate_id}, ${revision},
								${eventType}, ${sql.json({ providerId: task.provider_id, state: task.status })}
							)
							ON CONFLICT DO NOTHING
							RETURNING id, recipient_principal_id
						)
						INSERT INTO connection_notification_receipts (
							notification_id, recipient_principal_id
						)
						SELECT id, recipient_principal_id FROM created
					`;
				}
				await sql`
					UPDATE connection_outbox_events
					SET status = 'DELIVERED', delivered_at = now(),
						attempt_count = attempt_count + 1
					WHERE id = ${event.id} AND status = 'PENDING'
				`;
				await this.completeFailureWorkItems(sql, event.id);
				return true;
			});
		} catch (error) {
			const failedEventId = eventId;
			if (failedEventId) {
				await this.sql.begin(async (sql) => {
					const [failed] = await sql<
						{ attempt_count: number; status: string }[]
					>`
						UPDATE connection_outbox_events
						SET attempt_count = attempt_count + 1,
							status = CASE WHEN attempt_count + 1 >= 10 THEN 'FAILED' ELSE 'PENDING' END,
							available_at = now() + LEAST(600, 10 * (attempt_count + 1)) * interval '1 second'
						WHERE id = ${failedEventId} AND status = 'PENDING'
						RETURNING attempt_count, status
					`;
					if (failed?.status !== "FAILED") return;
					const admins = await sql<{ id: string }[]>`
						SELECT principal.id FROM connection_principal_roles role_binding
						JOIN connection_principals principal ON principal.id = role_binding.principal_id
						WHERE principal.status = 'ACTIVE'
							AND role_binding.role = 'CONNECTION_ADMIN'
							AND role_binding.status = 'ACTIVE'
					`;
					for (const admin of admins) {
						const [work] = await sql<{ business_revision: number }[]>`
							INSERT INTO connection_work_items (
								id, recipient_principal_id, business_type, business_id,
								business_revision, action_type, status
							) VALUES (
								${`dispatch-failure-work-${failedEventId}-${admin.id}`}, ${admin.id},
								'CONNECTION_DISPATCH_FAILURE', ${failedEventId}, 1, 'RETRY', 'OPEN'
							)
							ON CONFLICT (recipient_principal_id, business_type, business_id, action_type)
							DO UPDATE SET status = 'OPEN', completed_at = NULL, updated_at = now(),
								business_revision = connection_work_items.business_revision + 1
							RETURNING business_revision
						`;
						await sql`
							WITH created AS (
								INSERT INTO connection_notifications (
									id, recipient_principal_id, business_type, business_id,
									business_revision, event_type, summary
								) VALUES (
									${`dispatch-failure-notice-${failedEventId}-${admin.id}-${work?.business_revision}`},
									${admin.id}, 'CONNECTION_DISPATCH_FAILURE', ${failedEventId},
									${work?.business_revision ?? 1}, 'DISPATCH_FAILED',
									${sql.json({ providerId: "Connection", state: "FAILED" })}
								)
								ON CONFLICT DO NOTHING RETURNING id, recipient_principal_id
							)
							INSERT INTO connection_notification_receipts (
								notification_id, recipient_principal_id
							) SELECT id, recipient_principal_id FROM created
						`;
					}
				});
			}
			throw error;
		}
	}
}
