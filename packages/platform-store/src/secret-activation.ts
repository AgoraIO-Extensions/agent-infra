import { Buffer } from "node:buffer";

import {
	type PlatformSecretRecordV1,
	validatePlatformSecretRecordV1,
} from "@agent-infra/contracts/workload";
import type {
	SecretActivationCandidateV1,
	SecretActivationClaimV1,
	SecretActivationFailureV1,
	SecretActivationFenceV1,
	SecretActivationStorePortV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { platformDatabaseUrlFromEnvironment } from "./migrate.ts";

interface SecretActivationRow {
	readonly agent_id: string;
	readonly secret_id: string;
	readonly secret_version: string | number;
	readonly configuration_revision: string | number;
	readonly lifecycle_state: string;
	readonly activation_fence: string | number;
	readonly activation_owner: string | null;
	readonly activation_lease_expires_at: Date | null;
	readonly record: unknown;
	readonly current_configuration_revision: string | number;
}

type TransitionKind = "applying" | "observed" | "active" | "failed";
const lockTimeout = "2000ms";

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
	record: Exclude<PlatformSecretRecordV1, { lifecycleState: "active" }>,
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
		encryptedRecord: record,
	};
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

function kubernetesSecretReference(
	record: PlatformSecretRecordV1,
	name: string,
) {
	return {
		schemaVersion: 1 as const,
		ownerType: record.ownerType,
		ownerId: record.ownerId,
		agentId: record.agentId,
		secretId: record.secretId,
		secretVersion: record.secretVersion,
		configRevision: record.configRevision,
		algorithmVersion: record.crypto.algorithmVersion,
		wrappingAlgorithmVersion: record.crypto.wrappingAlgorithmVersion,
		wrappingKeyVersion: record.crypto.wrappingKeyVersion,
		name,
	};
}

function transitionRecord(input: {
	readonly kind: TransitionKind;
	readonly record: PlatformSecretRecordV1;
	readonly kubernetesSecretName?: string;
	readonly activationFence?: SecretActivationFenceV1;
	readonly error?: SecretActivationFailureV1;
	readonly occurredAt: Date;
}): PlatformSecretRecordV1 {
	const base = baseRecord(input.record, input.occurredAt);
	const secretRef =
		input.kubernetesSecretName === undefined
			? undefined
			: kubernetesSecretReference(input.record, input.kubernetesSecretName);
	let next: unknown;
	if (input.kind === "failed") {
		if (!input.error) throw new SecretActivationStoreError();
		next = {
			...base,
			lifecycleState: "failed",
			...(secretRef ? { kubernetesSecretRef: secretRef } : {}),
			...(input.activationFence
				? { activationFence: input.activationFence }
				: {}),
			error: input.error,
		};
	} else {
		if (!secretRef || !input.activationFence) {
			throw new SecretActivationStoreError();
		}
		next = {
			...base,
			lifecycleState: input.kind,
			kubernetesSecretRef: secretRef,
			activationFence: input.activationFence,
		};
	}
	try {
		return validatePlatformSecretRecordV1(next, input.activationFence);
	} catch {
		throw new SecretActivationStoreError();
	}
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

function claimMatchesRow(
	claim: SecretActivationClaimV1,
	row: SecretActivationRow,
	record: PlatformSecretRecordV1,
	decisionAt: Date,
): boolean {
	try {
		return (
			claim.schemaVersion === 1 &&
			claim.workerId === row.activation_owner &&
			claim.fence === integer(row.activation_fence, 1) &&
			date(row.activation_lease_expires_at).getTime() ===
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

function currentRecordMatchesFence(
	record: PlatformSecretRecordV1,
	fence: SecretActivationFenceV1,
): boolean {
	if (!("activationFence" in record) || !record.activationFence) return false;
	try {
		validatePlatformSecretRecordV1(record, fence);
		return true;
	} catch {
		return false;
	}
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
	): ReturnType<SecretActivationStorePortV1["claimCandidate"]> {
		try {
			const request = claimInput(input);
			return await this.#client.begin(async (sql) => {
				await sql`select set_config('lock_timeout', ${lockTimeout}, true)`;
				const rows = await sql<SecretActivationRow[]>`
					select sr.agent_id, sr.secret_id, sr.secret_version,
						sr.configuration_revision, sr.lifecycle_state,
						sr.activation_fence, sr.activation_owner,
						sr.activation_lease_expires_at, sr.record,
						a.current_configuration_revision
					from platform.secret_records sr
					join platform.agents a on a.id = sr.agent_id
					where sr.agent_id = ${request.agentId}
						and sr.secret_id = ${request.secretId}
						and sr.secret_version = ${request.secretVersion}
						and sr.configuration_revision = ${request.configRevision}
					for update of sr, a
				`;
				const row = rows[0];
				if (!row) return { outcome: "stale" as const };
				const record = parseRecord(row);
				if (record.lifecycleState === "active") {
					return { outcome: "active" as const };
				}
				if (
					record.lifecycleState === "failed" &&
					record.error.retryable === false
				) {
					return { outcome: "failed" as const };
				}
				if (
					integer(row.current_configuration_revision, 1) !==
					request.configRevision
				) {
					return { outcome: "stale" as const };
				}
				const decisionRows = await sql<{ decision_at: Date }[]>`
					select clock_timestamp() as decision_at
				`;
				const decisionAt = date(decisionRows[0]?.decision_at);
				if (
					row.activation_owner !== null &&
					row.activation_lease_expires_at !== null &&
					date(row.activation_lease_expires_at) > decisionAt
				) {
					return { outcome: "busy" as const };
				}
				const nextFence = integer(row.activation_fence, 0) + 1;
				if (!Number.isSafeInteger(nextFence)) {
					throw new SecretActivationStoreError();
				}
				const claimedRows = await sql<{ activation_lease_expires_at: Date }[]>`
					update platform.secret_records
					set activation_fence = ${nextFence},
						activation_owner = ${request.workerId},
						activation_lease_expires_at = ${decisionAt} +
							(${request.leaseDurationMs}::bigint * interval '1 millisecond')
					where agent_id = ${request.agentId}
						and secret_id = ${request.secretId}
						and secret_version = ${request.secretVersion}
						and configuration_revision = ${request.configRevision}
					returning activation_lease_expires_at
				`;
				const leaseExpiresAt = date(
					claimedRows[0]?.activation_lease_expires_at,
				);
				return {
					outcome: "claimed" as const,
					claim: {
						schemaVersion: 1 as const,
						workerId: request.workerId,
						fence: nextFence,
						leaseExpiresAt,
						candidate: candidateFromRecord(record),
					},
				};
			});
		} catch (error) {
			if (error instanceof SecretActivationStoreError) throw error;
			throw new SecretActivationStoreError();
		}
	}

	async markApplying(
		input: Parameters<SecretActivationStorePortV1["markApplying"]>[0],
	): Promise<boolean> {
		return this.#transition({ ...input, kind: "applying" });
	}

	async markObserved(
		input: Parameters<SecretActivationStorePortV1["markObserved"]>[0],
	): Promise<boolean> {
		return this.#transition({ ...input, kind: "observed" });
	}

	async markActive(
		input: Parameters<SecretActivationStorePortV1["markActive"]>[0],
	): Promise<boolean> {
		return this.#transition({ ...input, kind: "active" });
	}

	async markFailed(
		input: Parameters<SecretActivationStorePortV1["markFailed"]>[0],
	): Promise<boolean> {
		return this.#transition({ ...input, kind: "failed" });
	}

	async #transition(input: {
		readonly kind: TransitionKind;
		readonly claim: SecretActivationClaimV1;
		readonly kubernetesSecretName?: string;
		readonly activationFence?: SecretActivationFenceV1;
		readonly error?: SecretActivationFailureV1;
	}): Promise<boolean> {
		try {
			return await this.#client.begin(async (sql) => {
				await sql`select set_config('lock_timeout', ${lockTimeout}, true)`;
				const candidate = input.claim.candidate;
				const rows = await sql<SecretActivationRow[]>`
					select sr.agent_id, sr.secret_id, sr.secret_version,
						sr.configuration_revision, sr.lifecycle_state,
						sr.activation_fence, sr.activation_owner,
						sr.activation_lease_expires_at, sr.record,
						a.current_configuration_revision
					from platform.secret_records sr
					join platform.agents a on a.id = sr.agent_id
					where sr.agent_id = ${candidate.agentId}
						and sr.secret_id = ${candidate.secretId}
						and sr.secret_version = ${candidate.secretVersion}
						and sr.configuration_revision = ${candidate.configRevision}
					for update of sr, a
				`;
				const row = rows[0];
				if (!row) return false;
				const record = parseRecord(row);
				const decisionRows = await sql<{ decision_at: Date }[]>`
					select clock_timestamp() as decision_at
				`;
				const decisionAt = date(decisionRows[0]?.decision_at);
				if (!claimMatchesRow(input.claim, row, record, decisionAt))
					return false;
				if (
					(input.kind === "observed" &&
						(record.lifecycleState !== "applying" ||
							!input.activationFence ||
							!currentRecordMatchesFence(record, input.activationFence))) ||
					(input.kind === "active" &&
						(record.lifecycleState !== "observed" ||
							!input.activationFence ||
							!currentRecordMatchesFence(record, input.activationFence))) ||
					(input.kind === "failed" && record.lifecycleState === "active")
				) {
					return false;
				}
				const next = transitionRecord({
					kind: input.kind,
					record,
					kubernetesSecretName: input.kubernetesSecretName,
					activationFence: input.activationFence,
					error: input.error,
					occurredAt: decisionAt,
				});
				const terminal = input.kind === "active" || input.kind === "failed";
				await sql`
					update platform.secret_records
					set lifecycle_state = ${input.kind},
						record = ${sql.json(next)},
						updated_at = ${decisionAt},
						activation_owner = ${terminal ? null : input.claim.workerId},
						activation_lease_expires_at = ${terminal ? null : input.claim.leaseExpiresAt}
					where agent_id = ${candidate.agentId}
						and secret_id = ${candidate.secretId}
						and secret_version = ${candidate.secretVersion}
						and configuration_revision = ${candidate.configRevision}
				`;
				return true;
			});
		} catch (error) {
			if (error instanceof SecretActivationStoreError) throw error;
			throw new SecretActivationStoreError();
		}
	}
}

export function openPostgresSecretActivationStoreV1(
	options: PostgresSecretActivationStoreOptionsV1,
): PostgresSecretActivationStoreV1 {
	return new PostgresSecretActivationStoreV1(options);
}
