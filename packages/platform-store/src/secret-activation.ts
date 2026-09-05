import { Buffer } from "node:buffer";

import {
	type PlatformSecretRecordV1,
	validatePlatformSecretRecordV1,
} from "@agent-infra/contracts/workload";
import type {
	SecretActivationAuditIntentV1,
	SecretActivationCandidateV1,
	SecretActivationClaimPlanV1,
	SecretActivationClaimStateV1,
	SecretActivationClaimV1,
	SecretActivationFenceV1,
	SecretActivationReferenceV1,
	SecretActivationStorePortV1,
	SecretActivationTransitionPlanV1,
} from "@agent-infra/platform-core";
import { immutableSecretNameV1 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { platformDatabaseUrlFromEnvironment } from "./migrate.ts";

interface SecretActivationRow {
	readonly agent_id: string;
	readonly secret_id: string;
	readonly secret_version: string | number;
	readonly configuration_revision: string | number;
	readonly lifecycle_state: string;
	readonly record: unknown;
	readonly current_configuration_revision: string | number;
	readonly secret_activation_fence: string | number;
	readonly secret_activation_owner: string | null;
	readonly secret_activation_lease_expires_at: Date | null;
}

const lockTimeout = "2000ms";
const lifecycleStates = new Set([
	"pending",
	"applying",
	"observed",
	"active",
	"failed",
]);

export class SecretActivationStoreError extends Error {
	constructor() {
		super("Secret activation persistence failed");
		this.name = "SecretActivationStoreError";
	}
}

function text(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		!String.prototype.isWellFormed.call(value) ||
		Buffer.byteLength(value, "utf8") > 1024
	) {
		throw new SecretActivationStoreError();
	}
	return value;
}

function integer(value: unknown, minimum: number): number {
	const parsed = typeof value === "string" ? Number(value) : value;
	if (
		typeof parsed !== "number" ||
		!Number.isSafeInteger(parsed) ||
		parsed < minimum
	) {
		throw new SecretActivationStoreError();
	}
	return parsed;
}

function date(value: unknown): Date {
	try {
		const milliseconds = Date.prototype.getTime.call(value);
		if (!Number.isFinite(milliseconds)) throw new Error();
		return new Date(milliseconds);
	} catch {
		throw new SecretActivationStoreError();
	}
}

function parseRecord(row: SecretActivationRow): PlatformSecretRecordV1 {
	try {
		const record = validatePlatformSecretRecordV1(row.record);
		if (
			record.agentId !== text(row.agent_id) ||
			record.secretId !== text(row.secret_id) ||
			record.secretVersion !== integer(row.secret_version, 1) ||
			record.configRevision !== integer(row.configuration_revision, 1) ||
			record.lifecycleState !== row.lifecycle_state
		) {
			throw new Error();
		}
		return record;
	} catch (error) {
		if (error instanceof SecretActivationStoreError) throw error;
		throw new SecretActivationStoreError();
	}
}

function candidateFromRecord(
	record: PlatformSecretRecordV1,
): SecretActivationCandidateV1 {
	return {
		schemaVersion: 1,
		agentId: record.agentId,
		secretId: record.secretId,
		secretVersion: record.secretVersion,
		configRevision: record.configRevision,
		ownerType: record.ownerType,
		ownerId: record.ownerId,
		name: record.name,
		wrappingKeyVersion: record.crypto.wrappingKeyVersion,
		lifecycleState: record.lifecycleState,
		failureRetryable:
			record.lifecycleState === "failed" ? record.error.retryable : null,
		encryptedRecord: record,
	};
}

function claimInput(
	input: Parameters<SecretActivationStorePortV1["claimCandidate"]>[0],
) {
	if (
		input.schemaVersion !== 1 ||
		!Number.isSafeInteger(input.leaseDurationMs) ||
		input.leaseDurationMs < 1 ||
		input.leaseDurationMs > 300_000
	) {
		throw new SecretActivationStoreError();
	}
	return {
		agentId: text(input.agentId),
		secretId: text(input.secretId),
		secretVersion: integer(input.secretVersion, 1),
		configRevision: integer(input.configRevision, 1),
		workerId: text(input.workerId),
		leaseDurationMs: input.leaseDurationMs,
	};
}

function claimPlan(
	decide: (state: SecretActivationClaimStateV1) => SecretActivationClaimPlanV1,
	state: SecretActivationClaimStateV1,
): SecretActivationClaimPlanV1 {
	try {
		const plan = decide(state);
		if (
			!plan ||
			typeof plan !== "object" ||
			Object.keys(plan).length !== 1 ||
			!["claim", "stale", "active", "failed"].includes(plan.outcome)
		) {
			throw new Error();
		}
		return plan;
	} catch {
		throw new SecretActivationStoreError();
	}
}

function recordMatchesCandidate(
	record: PlatformSecretRecordV1,
	candidate: SecretActivationCandidateV1,
): boolean {
	return (
		record.agentId === candidate.agentId &&
		record.secretId === candidate.secretId &&
		record.secretVersion === candidate.secretVersion &&
		record.configRevision === candidate.configRevision &&
		record.ownerType === candidate.ownerType &&
		record.ownerId === candidate.ownerId &&
		record.name === candidate.name &&
		record.crypto.wrappingKeyVersion === candidate.wrappingKeyVersion
	);
}

function claimMatchesRow(
	claim: SecretActivationClaimV1,
	row: SecretActivationRow,
	record: PlatformSecretRecordV1,
	decisionAt: Date,
): boolean {
	try {
		return (
			claim.schemaVersion === 1 &&
			claim.workerId === row.secret_activation_owner &&
			claim.fence === integer(row.secret_activation_fence, 1) &&
			date(row.secret_activation_lease_expires_at).getTime() ===
				claim.leaseExpiresAt.getTime() &&
			claim.leaseExpiresAt > decisionAt &&
			recordMatchesCandidate(record, claim.candidate) &&
			integer(row.current_configuration_revision, 1) ===
				claim.candidate.configRevision
		);
	} catch {
		return false;
	}
}

function baseRecord(record: PlatformSecretRecordV1, occurredAt: Date) {
	return {
		schemaVersion: 1 as const,
		secretId: record.secretId,
		ownerType: record.ownerType,
		ownerId: record.ownerId,
		agentId: record.agentId,
		name: record.name,
		secretVersion: record.secretVersion,
		configRevision: record.configRevision,
		crypto: record.crypto,
		createdAt: record.createdAt,
		updatedAt: occurredAt.toISOString(),
	};
}

function transitionRecord(
	record: PlatformSecretRecordV1,
	plan: SecretActivationTransitionPlanV1,
	occurredAt: Date,
): PlatformSecretRecordV1 {
	const next = {
		...baseRecord(record, occurredAt),
		...plan.next,
	};
	try {
		return validatePlatformSecretRecordV1(
			next,
			"activationFence" in plan.next ? plan.next.activationFence : undefined,
		);
	} catch {
		throw new SecretActivationStoreError();
	}
}

function referenceMatchesCandidate(
	reference: SecretActivationReferenceV1,
	candidate: SecretActivationCandidateV1,
): boolean {
	return (
		reference.schemaVersion === 1 &&
		reference.ownerType === candidate.ownerType &&
		reference.ownerId === candidate.ownerId &&
		reference.agentId === candidate.agentId &&
		reference.secretId === candidate.secretId &&
		reference.secretVersion === candidate.secretVersion &&
		reference.configRevision === candidate.configRevision &&
		reference.algorithmVersion === "aes-256-gcm:v1" &&
		reference.wrappingAlgorithmVersion === "rsa-oaep-sha256:v1" &&
		reference.wrappingKeyVersion === candidate.wrappingKeyVersion &&
		reference.name === immutableSecretNameV1(candidate)
	);
}

function validatePlan(
	plan: SecretActivationTransitionPlanV1,
	claim: SecretActivationClaimV1,
): void {
	try {
		if (
			plan.schemaVersion !== 1 ||
			!Array.isArray(plan.expectedLifecycleStates) ||
			plan.expectedLifecycleStates.length === 0 ||
			plan.expectedLifecycleStates.length > lifecycleStates.size ||
			new Set(plan.expectedLifecycleStates).size !==
				plan.expectedLifecycleStates.length ||
			plan.expectedLifecycleStates.some(
				(state) => !lifecycleStates.has(state),
			) ||
			!Array.isArray(plan.auditEvents) ||
			plan.auditEvents.length > 2
		) {
			throw new Error();
		}
		if (
			"kubernetesSecretRef" in plan.next &&
			plan.next.kubernetesSecretRef !== undefined &&
			!referenceMatchesCandidate(plan.next.kubernetesSecretRef, claim.candidate)
		) {
			throw new Error();
		}
		if (
			("activationFence" in plan.next &&
				plan.next.activationFence !== undefined &&
				!fenceMatchesClaim(
					plan.next.activationFence,
					plan.next.kubernetesSecretRef,
					claim,
				)) ||
			(plan.expectedActivationFence !== undefined &&
				!fenceMatchesClaim(
					plan.expectedActivationFence,
					"kubernetesSecretRef" in plan.next
						? plan.next.kubernetesSecretRef
						: undefined,
					claim,
				))
		) {
			throw new Error();
		}
		for (const event of plan.auditEvents) validateAudit(event, claim);
	} catch (error) {
		if (error instanceof SecretActivationStoreError) throw error;
		throw new SecretActivationStoreError();
	}
}

function fenceMatchesClaim(
	fence: SecretActivationFenceV1,
	reference: SecretActivationReferenceV1 | undefined,
	claim: SecretActivationClaimV1,
): boolean {
	return (
		fence.schemaVersion === 1 &&
		fence.agentId === claim.candidate.agentId &&
		fence.secretId === claim.candidate.secretId &&
		fence.secretVersion === claim.candidate.secretVersion &&
		fence.configRevision === claim.candidate.configRevision &&
		fence.fence === claim.fence &&
		reference !== undefined &&
		fence.kubernetesSecretName === reference.name
	);
}

function validateAudit(
	event: SecretActivationAuditIntentV1,
	claim: SecretActivationClaimV1,
): void {
	if (
		event.schemaVersion !== 1 ||
		![event.auditId, event.traceId].every((value) => {
			try {
				text(value);
				return true;
			} catch {
				return false;
			}
		}) ||
		event.actorType !== "system" ||
		event.actorId !== claim.workerId ||
		(event.action !== "secret.decrypt" && event.action !== "secret.activate") ||
		event.targetType !== "secret" ||
		event.targetId !== claim.candidate.secretId ||
		event.agentId !== claim.candidate.agentId ||
		!event.details ||
		typeof event.details !== "object" ||
		Object.keys(event.details).length !== 3 ||
		!Object.hasOwn(event.details, "wrappingKeyVersion") ||
		!Object.hasOwn(event.details, "operation") ||
		!Object.hasOwn(event.details, "result") ||
		event.details.wrappingKeyVersion !== claim.candidate.wrappingKeyVersion ||
		(event.outcome !== "succeeded" &&
			event.outcome !== "rejected" &&
			event.outcome !== "failed") ||
		(event.details.operation !== "decrypt" &&
			event.details.operation !== "activate") ||
		event.details.result !== event.outcome ||
		(event.action === "secret.decrypt") !==
			(event.details.operation === "decrypt")
	) {
		throw new SecretActivationStoreError();
	}
}

function currentRecordMatchesExpectedFence(
	record: PlatformSecretRecordV1,
	plan: SecretActivationTransitionPlanV1,
): boolean {
	if (plan.expectedActivationFence === undefined) return true;
	try {
		validatePlatformSecretRecordV1(record, plan.expectedActivationFence);
		return true;
	} catch {
		return false;
	}
}

async function insertAudit(
	sql: postgres.TransactionSql,
	event: SecretActivationAuditIntentV1,
	occurredAt: Date,
): Promise<void> {
	const rows = await sql<{ id: string }[]>`
		insert into platform.audit_events
			(id, trace_id, actor_type, actor_id, action, target_type, target_id,
			 outcome, occurred_at, agent_id, details)
		values
			(${event.auditId}, ${event.traceId}, ${event.actorType}, ${event.actorId},
			 ${event.action}, ${event.targetType}, ${event.targetId}, ${event.outcome},
			 ${occurredAt}, ${event.agentId}, ${sql.json(event.details)})
		on conflict (id) do update set id = excluded.id
		where audit_events.trace_id = excluded.trace_id
			and audit_events.actor_type = excluded.actor_type
			and audit_events.actor_id = excluded.actor_id
			and audit_events.action = excluded.action
			and audit_events.target_type = excluded.target_type
			and audit_events.target_id = excluded.target_id
			and audit_events.outcome = excluded.outcome
			and audit_events.agent_id = excluded.agent_id
			and audit_events.details = excluded.details
		returning id
	`;
	if (rows.length !== 1) throw new SecretActivationStoreError();
}

export interface PostgresSecretActivationStoreOptionsV1 {
	readonly databaseUrl: string;
}

export class PostgresSecretActivationStoreV1
	implements SecretActivationStorePortV1
{
	readonly #client: ReturnType<typeof postgres>;

	constructor(options: PostgresSecretActivationStoreOptionsV1) {
		const databaseUrl = platformDatabaseUrlFromEnvironment({
			PLATFORM_DATABASE_URL: text(options.databaseUrl),
		});
		this.#client = postgres(databaseUrl, { max: 4 });
	}

	async close(): Promise<void> {
		await this.#client.end();
	}

	async claimCandidate(
		input: Parameters<SecretActivationStorePortV1["claimCandidate"]>[0],
		decide: Parameters<SecretActivationStorePortV1["claimCandidate"]>[1],
	): ReturnType<SecretActivationStorePortV1["claimCandidate"]> {
		try {
			const request = claimInput(input);
			return await this.#client.begin(async (sql) => {
				const row = await this.#lockedRow(sql, request);
				if (!row) return { outcome: "stale" as const };
				const record = parseRecord(row);
				const candidate = candidateFromRecord(record);
				const plan = claimPlan(decide, {
					schemaVersion: 1,
					currentConfigurationRevision: integer(
						row.current_configuration_revision,
						1,
					),
					candidate,
				});
				if (plan.outcome !== "claim") return plan;
				const decisionAt = await this.#decisionAt(sql);
				if (
					row.secret_activation_owner !== null &&
					row.secret_activation_lease_expires_at !== null &&
					date(row.secret_activation_lease_expires_at) > decisionAt
				) {
					return { outcome: "busy" as const };
				}
				const nextFence = integer(row.secret_activation_fence, 0) + 1;
				if (!Number.isSafeInteger(nextFence)) {
					throw new SecretActivationStoreError();
				}
				const claimed = await sql<
					{ secret_activation_lease_expires_at: Date }[]
				>`
					update platform.agents
					set secret_activation_fence = ${nextFence},
						secret_activation_owner = ${request.workerId},
						secret_activation_lease_expires_at = ${decisionAt} +
							(${request.leaseDurationMs}::bigint * interval '1 millisecond')
					where id = ${request.agentId}
					returning secret_activation_lease_expires_at
				`;
				return {
					outcome: "claimed" as const,
					claim: {
						schemaVersion: 1 as const,
						workerId: request.workerId,
						fence: nextFence,
						leaseExpiresAt: date(
							claimed[0]?.secret_activation_lease_expires_at,
						),
						candidate,
					},
				};
			});
		} catch (error) {
			if (error instanceof SecretActivationStoreError) throw error;
			throw new SecretActivationStoreError();
		}
	}

	async recordAudit(
		input: Parameters<SecretActivationStorePortV1["recordAudit"]>[0],
	): Promise<boolean> {
		try {
			validateAudit(input.auditEvent, input.claim);
			return await this.#client.begin(async (sql) => {
				const row = await this.#lockedRow(sql, input.claim.candidate);
				if (!row) return false;
				const record = parseRecord(row);
				const decisionAt = await this.#decisionAt(sql);
				if (!claimMatchesRow(input.claim, row, record, decisionAt))
					return false;
				await insertAudit(sql, input.auditEvent, decisionAt);
				return true;
			});
		} catch (error) {
			if (error instanceof SecretActivationStoreError) throw error;
			throw new SecretActivationStoreError();
		}
	}

	async commitTransition(
		input: Parameters<SecretActivationStorePortV1["commitTransition"]>[0],
	): Promise<boolean> {
		try {
			validatePlan(input.plan, input.claim);
			return await this.#client.begin(async (sql) => {
				const row = await this.#lockedRow(sql, input.claim.candidate);
				if (!row) return false;
				const record = parseRecord(row);
				const decisionAt = await this.#decisionAt(sql);
				if (
					!claimMatchesRow(input.claim, row, record, decisionAt) ||
					!input.plan.expectedLifecycleStates.includes(record.lifecycleState) ||
					!currentRecordMatchesExpectedFence(record, input.plan)
				) {
					return false;
				}
				const next = transitionRecord(record, input.plan, decisionAt);
				for (const event of input.plan.auditEvents) {
					await insertAudit(sql, event, decisionAt);
				}
				await sql`
					update platform.secret_records
					set lifecycle_state = ${input.plan.next.lifecycleState},
						record = ${sql.json(next)}, updated_at = ${decisionAt}
					where agent_id = ${input.claim.candidate.agentId}
						and secret_id = ${input.claim.candidate.secretId}
						and secret_version = ${input.claim.candidate.secretVersion}
						and configuration_revision = ${input.claim.candidate.configRevision}
				`;
				if (
					input.plan.next.lifecycleState === "active" ||
					input.plan.next.lifecycleState === "failed"
				) {
					await sql`
						update platform.agents
						set secret_activation_owner = null,
							secret_activation_lease_expires_at = null
						where id = ${input.claim.candidate.agentId}
					`;
				}
				return true;
			});
		} catch (error) {
			if (error instanceof SecretActivationStoreError) throw error;
			throw new SecretActivationStoreError();
		}
	}

	async #lockedRow(
		sql: postgres.TransactionSql,
		identity: {
			readonly agentId: string;
			readonly secretId: string;
			readonly secretVersion: number;
			readonly configRevision: number;
		},
	): Promise<SecretActivationRow | undefined> {
		await sql`select set_config('lock_timeout', ${lockTimeout}, true)`;
		const rows = await sql<SecretActivationRow[]>`
			select sr.agent_id, sr.secret_id, sr.secret_version,
				sr.configuration_revision, sr.lifecycle_state, sr.record,
				a.current_configuration_revision, a.secret_activation_fence,
				a.secret_activation_owner, a.secret_activation_lease_expires_at
			from platform.agents a
			join platform.secret_records sr on sr.agent_id = a.id
			where sr.agent_id = ${identity.agentId}
				and sr.secret_id = ${identity.secretId}
				and sr.secret_version = ${identity.secretVersion}
				and sr.configuration_revision = ${identity.configRevision}
			for update of a, sr
		`;
		return rows[0];
	}

	async #decisionAt(sql: postgres.TransactionSql): Promise<Date> {
		const rows = await sql<{ decision_at: Date }[]>`
			select clock_timestamp() as decision_at
		`;
		return date(rows[0]?.decision_at);
	}
}

export function openPostgresSecretActivationStoreV1(
	options: PostgresSecretActivationStoreOptionsV1,
): PostgresSecretActivationStoreV1 {
	return new PostgresSecretActivationStoreV1(options);
}
