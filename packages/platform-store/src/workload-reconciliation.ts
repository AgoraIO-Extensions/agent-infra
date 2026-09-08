import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import {
	type WorkloadReconciliationInputV1,
	type WorkloadReconciliationStateV1,
	type WorkloadReconciliationStorePortV1,
	type WorkloadSecretBindingV1,
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

const defaultWorkloadLeaseMs = 300_000;

function secretReferenceKey(input: {
	readonly name: string;
	readonly secretId: string;
	readonly secretVersion: number;
}) {
	return `${input.name}\0${input.secretId}\0${input.secretVersion}`;
}

function expectedSecretReferences(configuration: {
	readonly secrets: readonly {
		readonly name: string;
		readonly secretId: string;
		readonly version: number;
		readonly isSet: boolean;
	}[];
	readonly modelConfiguration: {
		readonly options: readonly {
			readonly optionId: string;
			readonly credential: {
				readonly secretId: string;
				readonly version: number;
				readonly isSet: boolean;
			};
		}[];
	} | null;
}) {
	const references = [
		...configuration.secrets
			.filter(({ isSet }) => isSet)
			.map(({ name, secretId, version }) => ({
				name,
				secretId,
				secretVersion: version,
			})),
		...(configuration.modelConfiguration?.options
			.filter(({ credential }) => credential.isSet)
			.map(({ optionId, credential }) => ({
				name: `model:${optionId}`,
				secretId: credential.secretId,
				secretVersion: credential.version,
			})) ?? []),
	];
	if (
		references.length > 160 ||
		new Set(references.map(secretReferenceKey)).size !== references.length
	)
		throw new Error();
	return references;
}

function resolveSecretBindings(
	records: readonly ReturnType<typeof validatePlatformSecretRecordV1>[],
	configuration: {
		readonly revision: number;
		readonly secrets: readonly {
			readonly name: string;
			readonly secretId: string;
			readonly version: number;
			readonly isSet: boolean;
		}[];
		readonly modelConfiguration: {
			readonly options: readonly {
				readonly optionId: string;
				readonly credential: {
					readonly secretId: string;
					readonly version: number;
					readonly isSet: boolean;
				};
			}[];
		} | null;
	},
	ownerIds: readonly string[],
	retiredWrappingKeys: ReadonlySet<string>,
): readonly WorkloadSecretBindingV1[] {
	return expectedSecretReferences(configuration).map((reference) => {
		const matches = records.filter(
			(record) =>
				record.secretId === reference.secretId &&
				record.secretVersion === reference.secretVersion,
		);
		if (matches.length !== 1) throw new Error();
		const record = matches[0];
		if (
			!record ||
			record.name !== reference.name ||
			record.ownerType !== "agent-owner" ||
			!ownerIds.includes(record.ownerId) ||
			retiredWrappingKeys.has(record.crypto.wrappingKeyVersion) ||
			record.configRevision > configuration.revision
		)
			throw new Error();
		if (record.configRevision < configuration.revision) {
			if (record.lifecycleState !== "active") throw new Error();
			return { materialization: "active-origin", record } as const;
		}
		return { materialization: "current", record } as const;
	});
}

export function openPostgresWorkloadReconciliationStoreV1(options: {
	readonly databaseUrl: string;
	readonly retryDelayMs?: number;
	readonly monitorDelayMs?: number;
	readonly workloadLeaseMs?: number;
}): WorkloadReconciliationStorePortV1 & { close(): Promise<void> } {
	const client = postgres(
		platformDatabaseUrlFromEnvironment({
			PLATFORM_DATABASE_URL: options.databaseUrl,
		}),
		{ max: 2 },
	);
	const retryDelayMs = options.retryDelayMs ?? 1000;
	const monitorDelayMs = options.monitorDelayMs ?? 30_000;
	const workloadLeaseMs = options.workloadLeaseMs ?? defaultWorkloadLeaseMs;
	if (
		![retryDelayMs, monitorDelayMs].every(
			(n) => Number.isSafeInteger(n) && n >= 0 && n <= 300_000,
		) ||
		!Number.isSafeInteger(workloadLeaseMs) ||
		workloadLeaseMs < 1 ||
		workloadLeaseMs > 300_000
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
							or exists (select 1 from platform.outbox_items o where o.scope_type = 'agent'
								and o.scope_id = a.id
								and o.operation in ('agent.workload.reconcile.v1', 'agent.configuration.revised.v1')
								and ((o.status in ('pending', 'retry_scheduled') and o.available_at <= clock_timestamp())
									or (o.status = 'processing' and o.lease_expires_at <= clock_timestamp())))
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
					const [candidate] = await sql<
						{ id: string; delivery_fence: string }[]
					>`
							select id, delivery_fence::text from platform.outbox_items where scope_type = 'agent'
							and scope_id = ${agent.id}
							and operation in ('agent.workload.reconcile.v1', 'agent.configuration.revised.v1')
							and ((status in ('pending', 'retry_scheduled') and available_at <= clock_timestamp())
								or (status = 'processing' and lease_expires_at <= clock_timestamp()))
							order by created_at, id limit 1 for update
						`;
					let task:
						| {
								id: string;
								trace_id: string;
								request_id: string | null;
								delivery_fence: string;
						  }
						| undefined;
					if (candidate) {
						const [claimed] = await sql<
							{
								id: string;
								trace_id: string;
								request_id: string | null;
								delivery_fence: string;
							}[]
						>`
								with decision_time as materialized (
									select clock_timestamp() as decision_at
								)
								update platform.outbox_items
								set status = 'processing', attempt_count = attempt_count + 1,
									lease_owner = ${workerId}, lease_expires_at = decision_time.decision_at +
										${workloadLeaseMs} * interval '1 millisecond',
									delivery_fence = delivery_fence + 1, updated_at = decision_time.decision_at
								from decision_time
								where id = ${candidate.id} and delivery_fence = ${candidate.delivery_fence}
									and ((status in ('pending', 'retry_scheduled') and available_at <= decision_time.decision_at)
										or (status = 'processing' and lease_expires_at <= decision_time.decision_at))
								returning id, trace_id, request_id, delivery_fence::text
							`;
						if (!claimed) throw new Error();
						task = claimed;
					}
					const requestId = task?.request_id ?? `workload-${agent.id}`;
					const traceId = task?.trace_id ?? requestId;
					let secretConfiguration = configuration;
					if (state?.rollback) {
						if (
							!state.verified ||
							state.candidate.configuration.revision !==
								state.verified.configuration.revision
						)
							throw new Error();
						const [rollbackConfigurationRow] = await sql<
							{ configuration: unknown }[]
						>`select configuration from platform.agent_configuration_revisions where agent_id = ${agent.id} and revision = ${state.candidate.configuration.revision}`;
						const rollbackConfiguration = decodeAgentConfigurationRecord(
							rollbackConfigurationRow?.configuration,
						);
						if (
							!isDeepStrictEqual(
								rollbackConfiguration,
								state.candidate.configuration,
							)
						)
							throw new Error();
						secretConfiguration = rollbackConfiguration;
					}
					const rows = await sql<
						{ record: unknown }[]
					>`select record from platform.secret_records where agent_id = ${agent.id}`;
					const records = rows.map((row) =>
						validatePlatformSecretRecordV1(row.record),
					);
					const wrappingKeyVersions = [
						...new Set(
							records.map((record) => record.crypto.wrappingKeyVersion),
						),
					];
					const retired = wrappingKeyVersions.length
						? await sql<{ key_version: string }[]>`
								select key_version from platform.retired_secret_wrapping_keys
								where key_version = any(${sql.array(wrappingKeyVersions)})
							`
						: [];
					const bindings = resolveSecretBindings(
						records,
						secretConfiguration,
						management.ownerIds,
						new Set(retired.map(({ key_version }) => key_version)),
					);
					const input: WorkloadReconciliationInputV1 = {
						management,
						configuration,
						state,
						requestId,
						traceId,
						secrets: {
							bindings,
							store: new PostgresSecretActivationStoreV1({ transaction: sql }),
							async auditDecryption(secretId, wrappingKeyVersion, outcome) {
								if (
									!bindings.some(({ record }) => {
										const binding = validatePlatformSecretRecordV1(record);
										return (
											binding.agentId === agent.id &&
											binding.secretId === secretId &&
											binding.crypto.wrappingKeyVersion === wrappingKeyVersion
										);
									})
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
						const [completed] = await sql<
							{
								id: string;
								trace_id: string;
								attempt_count: number;
								delivery_fence: string;
							}[]
						>`
								update platform.outbox_items
								set status = 'succeeded', lease_owner = null, lease_expires_at = null,
									updated_at = clock_timestamp()
								where id = ${task.id} and status = 'processing'
									and lease_owner = ${workerId} and delivery_fence = ${task.delivery_fence}
								returning id, trace_id, attempt_count, delivery_fence::text
							`;
						if (!completed) throw new Error();
						await sql`insert into platform.persisted_events (event_id, stream_id, sequence, stream_cursor, event_type, payload, trace_id) values (${`outbox:${completed.id}:${completed.delivery_fence}`}, ${`outbox:${completed.id}`}, ${completed.delivery_fence}, ${completed.delivery_fence}, 'outbox.succeeded', ${sql.json({ attemptCount: completed.attempt_count, deliveryFence: completed.delivery_fence })}, ${completed.trace_id})`;
					}
					return "advanced" as const;
				});
			} catch {
				throw new Error("Workload reconciliation persistence failed");
			}
		},
	};
}
