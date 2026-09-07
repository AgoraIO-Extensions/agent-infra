import { randomUUID } from "node:crypto";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import {
	type WorkloadReconciliationInputV1,
	type WorkloadReconciliationStateV1,
	type WorkloadReconciliationStorePortV1,
	workloadManagementObservationV1,
} from "@agent-infra/platform-core";
import { PgDialect } from "drizzle-orm/pg-core";
import { PostgresJsDatabase, PostgresJsSession } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import {
	persistAcceptedAgentManagement,
	readAgentManagementState,
} from "./agent-management.js";
import { platformDatabaseUrlFromEnvironment } from "./migrate.js";
import { PostgresSecretActivationStoreV1 } from "./secret-activation.js";

export function openPostgresWorkloadReconciliationStoreV1(options: {
	readonly databaseUrl: string;
	readonly retryDelayMs?: number;
	readonly monitorDelayMs?: number;
}): WorkloadReconciliationStorePortV1 & { close(): Promise<void> } {
	const client = postgres(
		platformDatabaseUrlFromEnvironment({
			PLATFORM_DATABASE_URL: options.databaseUrl,
		}),
		{ max: 2 },
	);
	const retryDelayMs = options.retryDelayMs ?? 1000;
	const monitorDelayMs = options.monitorDelayMs ?? 30_000;
	if (
		![retryDelayMs, monitorDelayMs].every(
			(n) => Number.isSafeInteger(n) && n >= 0 && n <= 300_000,
		)
	)
		throw new TypeError("Invalid Workload poll interval");
	return {
		async close() {
			await client.end();
		},
		async runNext(workerId, step) {
			try {
				return await client.begin(async (sql) => {
					// The same Agent row is locked by management, configuration and
					// Secret activation. SKIP LOCKED lets other Workers progress.
					const [agent] = await sql<
						{ id: string; current_configuration_revision: string }[]
					>`
						select a.id, a.current_configuration_revision from platform.agents a
						join platform.agent_applications ap on ap.agent_id = a.id
						left join platform.workload_reconciliations w on w.agent_id = a.id
						where ap.approval_revision is not null and (
							(w.agent_id is null and ap.status <> 'creation_failed')
							or w.next_attempt_at <= clock_timestamp()
							or exists (select 1 from platform.outbox_items o where o.scope_id = a.id
								and o.operation in ('agent.workload.reconcile.v1', 'agent.configuration.revised.v1')
								and o.status in ('pending', 'retry_scheduled'))
						) order by w.next_attempt_at nulls first, a.id
						limit 1 for update of a skip locked
					`;
					if (!agent) return "idle" as const;
					const dialect = new PgDialect();
					// Drizzle's session uses the transaction's query API; its public
					// generic incorrectly requires pool-only methods as well.
					const database = new PostgresJsDatabase(
						dialect,
						new PostgresJsSession(
							sql as unknown as postgres.Sql,
							dialect,
							undefined,
						),
						undefined,
					);
					const management = await readAgentManagementState(database, agent.id);
					if (!management) throw new Error();
					const [configurationRow] = await sql<
						{ configuration: unknown }[]
					>`select configuration from platform.agent_configuration_revisions where agent_id = ${agent.id} and revision = ${agent.current_configuration_revision}`;
					const configuration = decodeAgentConfigurationRecord(
						configurationRow?.configuration,
					);
					const [persisted] = await sql<
						{ state: WorkloadReconciliationStateV1 }[]
					>`select state from platform.workload_reconciliations where agent_id = ${agent.id}`;
					const state = persisted?.state ?? null;
					if (
						state &&
						(state.schemaVersion !== 1 ||
							state.agentId !== agent.id ||
							!Number.isSafeInteger(state.revision))
					)
						throw new Error();
					const [task] = await sql<
						{ id: string; trace_id: string; request_id: string | null }[]
					>`
						select id, trace_id, request_id from platform.outbox_items where scope_id = ${agent.id}
						and operation in ('agent.workload.reconcile.v1', 'agent.configuration.revised.v1')
						and status in ('pending', 'retry_scheduled', 'processing') order by created_at, id limit 1 for update
					`;
					const requestId = task?.request_id ?? `workload-${agent.id}`;
					const traceId = task?.trace_id ?? requestId;
					const rows = await sql<
						{ record: unknown }[]
					>`select record from platform.secret_records where agent_id = ${agent.id}`;
					const records = rows.map((row) =>
						validatePlatformSecretRecordV1(row.record),
					);
					const input: WorkloadReconciliationInputV1 = {
						management,
						configuration,
						state,
						requestId,
						traceId,
						secrets: {
							records,
							store: new PostgresSecretActivationStoreV1({ transaction: sql }),
							async auditDecryption(secretId, wrappingKeyVersion, outcome) {
								if (
									!records.some(
										(record) =>
											record.agentId === agent.id &&
											record.secretId === secretId &&
											record.crypto.wrappingKeyVersion === wrappingKeyVersion,
									)
								)
									throw new Error();
								await sql`insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details) values (${randomUUID()}, ${traceId}, 'system', ${workerId}, 'secret.decrypt', 'secret', ${secretId}, ${outcome}, ${requestId}, ${agent.id}, ${sql.json({ wrappingKeyVersion, operation: "decrypt", result: outcome })})`;
							},
						},
					};
					const next = await step(input);
					if (
						next.agentId !== agent.id ||
						next.sourceConfigurationRevision !== configuration.revision ||
						next.sourceLifecycleRevision !== management.workloadRevision ||
						next.revision < (state?.revision ?? 1)
					)
						throw new Error();
					const observation = await workloadManagementObservationV1(
						input,
						next,
					);
					if (observation) {
						if (observation.decision.outcome !== "accepted") throw new Error();
						await persistAcceptedAgentManagement(
							database,
							observation.request,
							management,
							observation.decision,
						);
					}
					const delay = ["ready", "rejected", "stopped", "failed"].includes(
						next.phase,
					)
						? monitorDelayMs
						: retryDelayMs;
					await sql`insert into platform.workload_reconciliations (agent_id, revision, state, next_attempt_at) values (${agent.id}, ${next.revision}, ${sql.json(next as unknown as postgres.JSONValue)}, clock_timestamp() + ${delay} * interval '1 millisecond') on conflict (agent_id) do update set revision = excluded.revision, state = excluded.state, next_attempt_at = excluded.next_attempt_at, updated_at = clock_timestamp()`;
					// Outbox deliveries only wake reconciliation. The durable Workload
					// row owns subsequent recovery steps and periodic observations.
					if (task) {
						await sql`update platform.outbox_items set status = 'succeeded', attempt_count = attempt_count + 1, delivery_fence = delivery_fence + 1, lease_owner = null, lease_expires_at = null, updated_at = clock_timestamp() where id = ${task.id}`;
						await sql`insert into platform.persisted_events (event_id, stream_id, sequence, stream_cursor, event_type, payload, trace_id) select concat('outbox:', id, ':', delivery_fence), concat('outbox:', id), delivery_fence, delivery_fence, 'outbox.succeeded', jsonb_build_object('attemptCount', attempt_count, 'deliveryFence', delivery_fence::text), trace_id from platform.outbox_items where id = ${task.id}`;
					}
					return "advanced" as const;
				});
			} catch {
				throw new Error("Workload reconciliation persistence failed");
			}
		},
	};
}
