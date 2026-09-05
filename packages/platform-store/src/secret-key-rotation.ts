import { Buffer } from "node:buffer";
import { isDeepStrictEqual, types } from "node:util";

import {
	type PlatformSecretRecordV1,
	validatePlatformSecretRecordV1,
} from "@agent-infra/contracts/workload";
import type {
	RetireSecretKeyCommandV1,
	RotateSecretKeyCommandV1,
	SecretKeyRotationAuditIntentV1,
	SecretKeyRotationCandidateV1,
	SecretKeyRotationProgressV1,
	SecretKeyRotationStorePortV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";

import { platformDatabaseUrlFromEnvironment } from "./migrate.js";

interface RotationRow {
	readonly rotation_id: unknown;
	readonly source_key_versions: unknown;
	readonly target_key_version: unknown;
	readonly state: unknown;
	readonly processed_secrets: unknown;
	readonly remaining_secrets: unknown;
	readonly updated_at: unknown;
}

interface SecretRecordRow {
	readonly agent_id: unknown;
	readonly secret_id: unknown;
	readonly secret_version: unknown;
	readonly configuration_revision: unknown;
	readonly lifecycle_state: unknown;
	readonly dek_fingerprint: unknown;
	readonly wrapping_key_version: unknown;
	readonly record: unknown;
}

const rotationStates = new Set([
	"pending",
	"rewrapping",
	"verifying",
	"completed",
	"failed",
]);
const lifecycleStates = new Set([
	"pending",
	"applying",
	"observed",
	"active",
	"failed",
]);

export class SecretKeyRotationStoreError extends Error {
	constructor() {
		super("Secret key rotation persistence failed");
		this.name = "SecretKeyRotationStoreError";
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
		throw new SecretKeyRotationStoreError();
	}
	return value;
}

function integer(value: unknown): number {
	const parsed = typeof value === "string" ? Number(value) : value;
	if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
		throw new SecretKeyRotationStoreError();
	}
	return parsed as number;
}

function date(value: unknown): Date {
	try {
		const milliseconds = Date.prototype.getTime.call(value);
		if (!Number.isFinite(milliseconds)) throw new Error();
		return new Date(milliseconds);
	} catch {
		throw new SecretKeyRotationStoreError();
	}
}

function snapshotKeyVersions(value: unknown): readonly string[] {
	if (
		!Array.isArray(value) ||
		types.isProxy(value) ||
		value.length === 0 ||
		value.length > 128 ||
		!value.every((entry) => {
			try {
				text(entry);
				return true;
			} catch {
				return false;
			}
		}) ||
		new Set(value).size !== value.length
	) {
		throw new SecretKeyRotationStoreError();
	}
	return Object.freeze([...value]);
}

function rotationCommand(
	input: RotateSecretKeyCommandV1,
): RotateSecretKeyCommandV1 {
	try {
		const sourceKeyVersions = snapshotKeyVersions(input.sourceKeyVersions);
		if (
			input.schemaVersion !== 1 ||
			![
				input.rotationId,
				input.targetKeyVersion,
				input.workerId,
				input.traceId,
			].every((value) => {
				try {
					text(value);
					return true;
				} catch {
					return false;
				}
			}) ||
			sourceKeyVersions.includes(input.targetKeyVersion)
		) {
			throw new Error();
		}
		return {
			schemaVersion: 1,
			rotationId: input.rotationId,
			sourceKeyVersions,
			targetKeyVersion: input.targetKeyVersion,
			workerId: input.workerId,
			traceId: input.traceId,
		};
	} catch (error) {
		if (error instanceof SecretKeyRotationStoreError) throw error;
		throw new SecretKeyRotationStoreError();
	}
}

function retirementCommand(
	input: RetireSecretKeyCommandV1,
): RetireSecretKeyCommandV1 {
	try {
		if (
			input.schemaVersion !== 1 ||
			![input.keyVersion, input.workerId, input.traceId].every((value) => {
				try {
					text(value);
					return true;
				} catch {
					return false;
				}
			})
		) {
			throw new Error();
		}
		return input;
	} catch (error) {
		if (error instanceof SecretKeyRotationStoreError) throw error;
		throw new SecretKeyRotationStoreError();
	}
}

function progress(
	row: RotationRow,
	command: RotateSecretKeyCommandV1,
): SecretKeyRotationProgressV1 {
	const sourceKeyVersions = snapshotKeyVersions(row.source_key_versions);
	const state = text(row.state);
	if (
		text(row.rotation_id) !== command.rotationId ||
		text(row.target_key_version) !== command.targetKeyVersion ||
		!isDeepStrictEqual(sourceKeyVersions, command.sourceKeyVersions) ||
		!rotationStates.has(state)
	) {
		throw new SecretKeyRotationStoreError();
	}
	const remainingSecrets = integer(row.remaining_secrets);
	if (state === "completed" && remainingSecrets !== 0) {
		throw new SecretKeyRotationStoreError();
	}
	return {
		schemaVersion: 1,
		rotationId: command.rotationId,
		sourceKeyVersions,
		targetKeyVersion: command.targetKeyVersion,
		state: state as SecretKeyRotationProgressV1["state"],
		processedSecrets: integer(row.processed_secrets),
		remainingSecrets,
		updatedAt: date(row.updated_at),
	};
}

function parseRecord(row: SecretRecordRow): PlatformSecretRecordV1 {
	try {
		const record = validatePlatformSecretRecordV1(row.record);
		if (
			record.agentId !== text(row.agent_id) ||
			record.secretId !== text(row.secret_id) ||
			record.secretVersion !== integer(row.secret_version) ||
			record.configRevision !== integer(row.configuration_revision) ||
			record.lifecycleState !== row.lifecycle_state ||
			record.crypto.dekFingerprint !== row.dek_fingerprint ||
			record.crypto.wrappingKeyVersion !== row.wrapping_key_version
		) {
			throw new Error();
		}
		return record;
	} catch (error) {
		if (error instanceof SecretKeyRotationStoreError) throw error;
		throw new SecretKeyRotationStoreError();
	}
}

function candidate(row: SecretRecordRow): SecretKeyRotationCandidateV1 {
	const lifecycleState = text(row.lifecycle_state);
	const secretVersion = integer(row.secret_version);
	const configRevision = integer(row.configuration_revision);
	const dekFingerprint = text(row.dek_fingerprint);
	if (
		!lifecycleStates.has(lifecycleState) ||
		secretVersion < 1 ||
		configRevision < 1 ||
		!/^[a-f0-9]{64}$/.test(dekFingerprint)
	) {
		throw new SecretKeyRotationStoreError();
	}
	return {
		schemaVersion: 1,
		agentId: text(row.agent_id),
		secretId: text(row.secret_id),
		secretVersion,
		configRevision,
		lifecycleState:
			lifecycleState as SecretKeyRotationCandidateV1["lifecycleState"],
		wrappingKeyVersion: text(row.wrapping_key_version),
		dekFingerprint,
		encryptedRecord: row.record,
	};
}

function rowMatchesCandidate(
	row: SecretRecordRow,
	expected: SecretKeyRotationCandidateV1,
): boolean {
	try {
		const current = candidate(row);
		return (
			current.agentId === expected.agentId &&
			current.secretId === expected.secretId &&
			current.secretVersion === expected.secretVersion &&
			current.configRevision === expected.configRevision &&
			current.lifecycleState === expected.lifecycleState &&
			current.wrappingKeyVersion === expected.wrappingKeyVersion &&
			current.dekFingerprint === expected.dekFingerprint
		);
	} catch {
		return false;
	}
}

function recordMatchesCandidate(
	record: PlatformSecretRecordV1,
	expected: SecretKeyRotationCandidateV1,
): boolean {
	return (
		record.agentId === expected.agentId &&
		record.secretId === expected.secretId &&
		record.secretVersion === expected.secretVersion &&
		record.configRevision === expected.configRevision &&
		record.lifecycleState === expected.lifecycleState &&
		record.crypto.wrappingKeyVersion === expected.wrappingKeyVersion &&
		record.crypto.dekFingerprint === expected.dekFingerprint
	);
}

function withoutRotatedFields(record: PlatformSecretRecordV1): unknown {
	const snapshot = structuredClone(record) as Record<string, unknown>;
	delete snapshot.crypto;
	delete snapshot.updatedAt;
	const reference = snapshot.kubernetesSecretRef as
		| Record<string, unknown>
		| undefined;
	if (reference) delete reference.wrappingKeyVersion;
	return snapshot;
}

function rotatedRecord(
	input: unknown,
	current: PlatformSecretRecordV1,
	command: RotateSecretKeyCommandV1,
): PlatformSecretRecordV1 {
	try {
		const next = validatePlatformSecretRecordV1(input);
		if (
			!recordMatchesCandidate(current, {
				schemaVersion: 1,
				agentId: next.agentId,
				secretId: next.secretId,
				secretVersion: next.secretVersion,
				configRevision: next.configRevision,
				lifecycleState: next.lifecycleState,
				wrappingKeyVersion: current.crypto.wrappingKeyVersion,
				dekFingerprint: current.crypto.dekFingerprint,
				encryptedRecord: current,
			}) ||
			next.crypto.wrappingKeyVersion !== command.targetKeyVersion ||
			next.crypto.dekFingerprint === current.crypto.dekFingerprint ||
			next.createdAt !== current.createdAt ||
			!isDeepStrictEqual(
				withoutRotatedFields(next),
				withoutRotatedFields(current),
			)
		) {
			throw new Error();
		}
		return next;
	} catch (error) {
		if (error instanceof SecretKeyRotationStoreError) throw error;
		throw new SecretKeyRotationStoreError();
	}
}

function validateAudit(
	event: SecretKeyRotationAuditIntentV1,
	input:
		| {
				readonly kind: "decrypt" | "rewrap";
				readonly candidate: SecretKeyRotationCandidateV1;
		  }
		| { readonly kind: "retire-key"; readonly keyVersion: string },
	expected: { readonly workerId: string; readonly traceId: string },
): void {
	try {
		const operation = input.kind;
		const targetId =
			input.kind === "retire-key" ? input.keyVersion : input.candidate.secretId;
		const agentId =
			input.kind === "retire-key" ? null : input.candidate.agentId;
		const keyVersion =
			input.kind === "retire-key"
				? input.keyVersion
				: input.candidate.wrappingKeyVersion;
		if (
			event.schemaVersion !== 1 ||
			![event.auditId, event.traceId, event.actorId].every((value) => {
				try {
					text(value);
					return true;
				} catch {
					return false;
				}
			}) ||
			event.actorType !== "system" ||
			event.actorId !== expected.workerId ||
			event.traceId !== expected.traceId ||
			event.action !== `secret.${operation}` ||
			event.targetType !==
				(operation === "retire-key" ? "secret_key" : "secret") ||
			event.targetId !== targetId ||
			event.agentId !== agentId ||
			(event.outcome !== "succeeded" &&
				event.outcome !== "rejected" &&
				event.outcome !== "failed") ||
			!event.details ||
			types.isProxy(event.details) ||
			Object.keys(event.details).length !== 3 ||
			event.details.wrappingKeyVersion !== keyVersion ||
			event.details.operation !== operation ||
			event.details.result !== event.outcome
		) {
			throw new Error();
		}
	} catch (error) {
		if (error instanceof SecretKeyRotationStoreError) throw error;
		throw new SecretKeyRotationStoreError();
	}
}

async function decisionAt(sql: postgres.TransactionSql): Promise<Date> {
	const rows = await sql<{ decision_at: Date }[]>`
		select clock_timestamp() as decision_at
	`;
	return date(rows[0]?.decision_at);
}

async function lock(
	sql: postgres.TransactionSql,
	kind: "rotation" | "key",
	value: string,
): Promise<void> {
	await sql`
		select pg_catalog.pg_advisory_xact_lock(
			pg_catalog.hashtextextended(${`agent-infra:secret-${kind}:${value}`}, 0)
		)
	`;
}

async function lockKeys(
	sql: postgres.TransactionSql,
	keyVersions: readonly string[],
): Promise<void> {
	for (const keyVersion of [...new Set(keyVersions)].toSorted()) {
		await lock(sql, "key", keyVersion);
	}
}

async function isRetired(
	sql: postgres.TransactionSql,
	keyVersion: string,
): Promise<boolean> {
	const rows = await sql<{ exists: boolean }[]>`
		select exists(
			select 1 from platform.retired_secret_wrapping_keys
			where key_version = ${keyVersion}
		) as exists
	`;
	return rows[0]?.exists === true;
}

async function referenceCount(
	sql: postgres.TransactionSql,
	keyVersions: readonly string[],
): Promise<number> {
	const rows = await sql<{ count: string }[]>`
		select count(*)::text as count from platform.secret_records
		where record -> 'crypto' ->> 'wrappingKeyVersion'
			= any(${sql.array([...keyVersions])})
	`;
	return integer(rows[0]?.count);
}

async function rotationRow(
	sql: postgres.TransactionSql,
	rotationId: string,
): Promise<RotationRow | undefined> {
	const rows = await sql<RotationRow[]>`
		select rotation_id, source_key_versions, target_key_version, state,
			processed_secrets, remaining_secrets, updated_at
		from platform.secret_key_rotations
		where rotation_id = ${rotationId}
		for update
	`;
	return rows[0];
}

async function secretRow(
	sql: postgres.TransactionSql,
	identity: Pick<
		SecretKeyRotationCandidateV1,
		"agentId" | "secretId" | "secretVersion" | "configRevision"
	>,
): Promise<SecretRecordRow | undefined> {
	const rows = await sql<SecretRecordRow[]>`
		select agent_id, secret_id, secret_version, configuration_revision,
			lifecycle_state, dek_fingerprint,
			record -> 'crypto' ->> 'wrappingKeyVersion' as wrapping_key_version,
			record
		from platform.secret_records
		where agent_id = ${identity.agentId}
			and secret_id = ${identity.secretId}
			and secret_version = ${identity.secretVersion}
			and configuration_revision = ${identity.configRevision}
		for update
	`;
	return rows[0];
}

async function insertAudit(
	sql: postgres.TransactionSql,
	event: SecretKeyRotationAuditIntentV1,
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
			and audit_events.agent_id is not distinct from excluded.agent_id
			and audit_events.details = excluded.details
		returning id
	`;
	if (rows.length !== 1) throw new SecretKeyRotationStoreError();
}

function isDuplicateFingerprint(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "23505" &&
		"constraint_name" in error &&
		error.constraint_name === "secret_record_dek_fingerprint_unique"
	);
}

export interface PostgresSecretKeyRotationStoreOptionsV1 {
	readonly databaseUrl: string;
}

export class PostgresSecretKeyRotationStoreV1
	implements SecretKeyRotationStorePortV1
{
	readonly #client: ReturnType<typeof postgres>;

	constructor(options: PostgresSecretKeyRotationStoreOptionsV1) {
		this.#client = postgres(
			platformDatabaseUrlFromEnvironment({
				PLATFORM_DATABASE_URL: text(options.databaseUrl),
			}),
			{ max: 4 },
		);
	}

	async close(): Promise<void> {
		await this.#client.end();
	}

	async nextCandidate(
		input: RotateSecretKeyCommandV1,
	): ReturnType<SecretKeyRotationStorePortV1["nextCandidate"]> {
		try {
			const command = rotationCommand(input);
			return await this.#client.begin(async (sql) => {
				await lock(sql, "rotation", command.rotationId);
				await lockKeys(sql, [
					...command.sourceKeyVersions,
					command.targetKeyVersion,
				]);
				if (await isRetired(sql, command.targetKeyVersion)) {
					throw new SecretKeyRotationStoreError();
				}
				let row = await rotationRow(sql, command.rotationId);
				if (!row) {
					const remaining = await referenceCount(
						sql,
						command.sourceKeyVersions,
					);
					const now = await decisionAt(sql);
					const state = remaining === 0 ? "completed" : "rewrapping";
					const inserted = await sql<RotationRow[]>`
						insert into platform.secret_key_rotations
							(rotation_id, source_key_versions, target_key_version, state,
							 processed_secrets, remaining_secrets, created_at, updated_at)
						values
							(${command.rotationId}, ${sql.array([...command.sourceKeyVersions])},
							 ${command.targetKeyVersion}, ${state}, 0, ${remaining}, ${now}, ${now})
						returning rotation_id, source_key_versions, target_key_version, state,
							processed_secrets, remaining_secrets, updated_at
					`;
					row = inserted[0];
				}
				if (!row) throw new SecretKeyRotationStoreError();
				let currentProgress = progress(row, command);
				if (
					currentProgress.state === "completed" ||
					currentProgress.state === "failed"
				) {
					return { outcome: currentProgress.state, progress: currentProgress };
				}
				const remaining = await referenceCount(sql, command.sourceKeyVersions);
				if (remaining === 0) {
					const now = await decisionAt(sql);
					const completed = await sql<RotationRow[]>`
						update platform.secret_key_rotations
						set state = 'completed', remaining_secrets = 0, updated_at = ${now}
						where rotation_id = ${command.rotationId}
						returning rotation_id, source_key_versions, target_key_version, state,
							processed_secrets, remaining_secrets, updated_at
					`;
					currentProgress = progress(completed[0] as RotationRow, command);
					return { outcome: "completed", progress: currentProgress };
				}
				const candidates = await sql<SecretRecordRow[]>`
					select agent_id, secret_id, secret_version, configuration_revision,
						lifecycle_state, dek_fingerprint,
						record -> 'crypto' ->> 'wrappingKeyVersion' as wrapping_key_version,
						record
					from platform.secret_records
					where record -> 'crypto' ->> 'wrappingKeyVersion'
						= any(${sql.array([...command.sourceKeyVersions])})
					order by agent_id, secret_id, secret_version, configuration_revision
					limit 1
				`;
				const next = candidates[0];
				if (!next) throw new SecretKeyRotationStoreError();
				return {
					outcome: "candidate",
					progress: {
						...currentProgress,
						state: "rewrapping",
						remainingSecrets: remaining,
					},
					candidate: candidate(next),
				};
			});
		} catch (error) {
			if (error instanceof SecretKeyRotationStoreError) throw error;
			throw new SecretKeyRotationStoreError();
		}
	}

	async commitReencryption(
		input: Parameters<SecretKeyRotationStorePortV1["commitReencryption"]>[0],
	): ReturnType<SecretKeyRotationStorePortV1["commitReencryption"]> {
		try {
			const command = rotationCommand(input.command);
			if (input.auditEvents.length !== 2) {
				throw new SecretKeyRotationStoreError();
			}
			validateAudit(
				input.auditEvents[0] as SecretKeyRotationAuditIntentV1,
				{
					kind: "decrypt",
					candidate: input.candidate,
				},
				command,
			);
			validateAudit(
				input.auditEvents[1] as SecretKeyRotationAuditIntentV1,
				{
					kind: "rewrap",
					candidate: input.candidate,
				},
				command,
			);
			if (input.auditEvents.some(({ outcome }) => outcome !== "succeeded")) {
				throw new SecretKeyRotationStoreError();
			}
			return await this.#client.begin(async (sql) => {
				await lock(sql, "rotation", command.rotationId);
				await lockKeys(sql, [
					input.candidate.wrappingKeyVersion,
					command.targetKeyVersion,
				]);
				if (await isRetired(sql, command.targetKeyVersion)) {
					throw new SecretKeyRotationStoreError();
				}
				const rotation = await rotationRow(sql, command.rotationId);
				if (!rotation) return { outcome: "stale" as const };
				const currentProgress = progress(rotation, command);
				if (
					currentProgress.state === "completed" ||
					currentProgress.state === "failed"
				) {
					return { outcome: "stale" as const };
				}
				const row = await secretRow(sql, input.candidate);
				if (!row) return { outcome: "stale" as const };
				const current = parseRecord(row);
				if (!recordMatchesCandidate(current, input.candidate)) {
					return { outcome: "stale" as const };
				}
				const generated = rotatedRecord(
					input.encryptedRecord,
					current,
					command,
				);
				const now = await decisionAt(sql);
				const next = validatePlatformSecretRecordV1({
					...generated,
					updatedAt: now.toISOString(),
				});
				await sql`
					update platform.secret_records
					set dek_fingerprint = ${next.crypto.dekFingerprint},
						record = ${sql.json(next)}, updated_at = ${now}
					where agent_id = ${current.agentId}
						and secret_id = ${current.secretId}
						and secret_version = ${current.secretVersion}
						and configuration_revision = ${current.configRevision}
				`;
				for (const auditEvent of input.auditEvents) {
					await insertAudit(sql, auditEvent, now);
				}
				const remaining = await referenceCount(sql, command.sourceKeyVersions);
				const processed = currentProgress.processedSecrets + 1;
				if (!Number.isSafeInteger(processed)) {
					throw new SecretKeyRotationStoreError();
				}
				const state = remaining === 0 ? "completed" : "rewrapping";
				const rows = await sql<RotationRow[]>`
					update platform.secret_key_rotations
					set state = ${state}, processed_secrets = ${processed},
						remaining_secrets = ${remaining}, updated_at = ${now}
					where rotation_id = ${command.rotationId}
					returning rotation_id, source_key_versions, target_key_version, state,
						processed_secrets, remaining_secrets, updated_at
				`;
				return {
					outcome: "committed" as const,
					progress: progress(rows[0] as RotationRow, command),
				};
			});
		} catch (error) {
			if (isDuplicateFingerprint(error)) {
				return { outcome: "duplicate-fingerprint" };
			}
			if (error instanceof SecretKeyRotationStoreError) throw error;
			throw new SecretKeyRotationStoreError();
		}
	}

	async recordRejection(
		input: Parameters<SecretKeyRotationStorePortV1["recordRejection"]>[0],
	): Promise<boolean> {
		try {
			const command = rotationCommand(input.command);
			const rejected =
				input.failureCode === "SECRET_METADATA_INVALID" ||
				input.failureCode === "SECRET_AUTHENTICATION_FAILED";
			const rotationFailed = input.failureCode === "SECRET_ROTATION_FAILED";
			const expectedAuditOutcomes = rotationFailed
				? (["succeeded", "failed"] as const)
				: ([rejected ? "rejected" : "failed"] as const);
			if (
				![
					"SECRET_KEY_UNAVAILABLE",
					"SECRET_METADATA_INVALID",
					"SECRET_AUTHENTICATION_FAILED",
					"SECRET_ROTATION_FAILED",
				].includes(input.failureCode) ||
				input.auditEvents.length !== expectedAuditOutcomes.length
			) {
				throw new SecretKeyRotationStoreError();
			}
			for (const [index, auditEvent] of input.auditEvents.entries()) {
				validateAudit(
					auditEvent,
					{
						kind: rotationFailed && index === 1 ? "rewrap" : "decrypt",
						candidate: input.candidate,
					},
					command,
				);
				if (auditEvent.outcome !== expectedAuditOutcomes[index]) {
					throw new SecretKeyRotationStoreError();
				}
			}
			return await this.#client.begin(async (sql) => {
				await lock(sql, "rotation", command.rotationId);
				const rotation = await rotationRow(sql, command.rotationId);
				if (!rotation) return false;
				const currentProgress = progress(rotation, command);
				if (
					currentProgress.state === "completed" ||
					currentProgress.state === "failed"
				) {
					return false;
				}
				const row = await secretRow(sql, input.candidate);
				if (!row || !rowMatchesCandidate(row, input.candidate)) {
					return false;
				}
				const now = await decisionAt(sql);
				for (const auditEvent of input.auditEvents) {
					await insertAudit(sql, auditEvent, now);
				}
				await sql`
					update platform.secret_key_rotations
					set state = ${rejected ? "failed" : "rewrapping"}, updated_at = ${now}
					where rotation_id = ${command.rotationId}
				`;
				return true;
			});
		} catch (error) {
			if (error instanceof SecretKeyRotationStoreError) throw error;
			throw new SecretKeyRotationStoreError();
		}
	}

	async recordAttempt(
		input: Parameters<SecretKeyRotationStorePortV1["recordAttempt"]>[0],
	): Promise<boolean> {
		try {
			const command = rotationCommand(input.command);
			if (input.auditEvents.length !== 2) {
				throw new SecretKeyRotationStoreError();
			}
			validateAudit(
				input.auditEvents[0] as SecretKeyRotationAuditIntentV1,
				{ kind: "decrypt", candidate: input.candidate },
				command,
			);
			validateAudit(
				input.auditEvents[1] as SecretKeyRotationAuditIntentV1,
				{ kind: "rewrap", candidate: input.candidate },
				command,
			);
			if (
				input.auditEvents[0]?.outcome !== "succeeded" ||
				input.auditEvents[1]?.outcome !== "rejected"
			) {
				throw new SecretKeyRotationStoreError();
			}
			return await this.#client.begin(async (sql) => {
				await lock(sql, "rotation", command.rotationId);
				const rotation = await rotationRow(sql, command.rotationId);
				if (!rotation) return false;
				progress(rotation, command);
				const now = await decisionAt(sql);
				for (const auditEvent of input.auditEvents) {
					await insertAudit(sql, auditEvent, now);
				}
				return true;
			});
		} catch (error) {
			if (error instanceof SecretKeyRotationStoreError) throw error;
			throw new SecretKeyRotationStoreError();
		}
	}

	async retireKey(
		input: Parameters<SecretKeyRotationStorePortV1["retireKey"]>[0],
	): Promise<"retired" | "referenced"> {
		try {
			const command = retirementCommand(input.command);
			const activeWrappingKeyVersion = text(input.activeWrappingKeyVersion);
			validateAudit(
				input.retiredAuditEvent,
				{
					kind: "retire-key",
					keyVersion: command.keyVersion,
				},
				command,
			);
			validateAudit(
				input.rejectedAuditEvent,
				{
					kind: "retire-key",
					keyVersion: command.keyVersion,
				},
				command,
			);
			if (
				input.retiredAuditEvent.outcome !== "succeeded" ||
				input.rejectedAuditEvent.outcome !== "rejected"
			) {
				throw new SecretKeyRotationStoreError();
			}
			return await this.#client.begin(async (sql) => {
				await lockKeys(sql, [command.keyVersion]);
				if (await isRetired(sql, command.keyVersion)) return "retired" as const;
				const now = await decisionAt(sql);
				if (
					command.keyVersion === activeWrappingKeyVersion ||
					(await referenceCount(sql, [command.keyVersion])) !== 0
				) {
					await insertAudit(sql, input.rejectedAuditEvent, now);
					return "referenced" as const;
				}
				const liveRotations = await sql<{ exists: boolean }[]>`
					select exists(
						select 1 from platform.secret_key_rotations
						where state not in ('completed', 'failed') and (
							target_key_version = ${command.keyVersion}
							or ${command.keyVersion} = any(source_key_versions)
						)
					) as exists
				`;
				if (liveRotations[0]?.exists === true) {
					await insertAudit(sql, input.rejectedAuditEvent, now);
					return "referenced" as const;
				}
				await sql`
					insert into platform.retired_secret_wrapping_keys (key_version, retired_at)
					values (${command.keyVersion}, ${now})
				`;
				await insertAudit(sql, input.retiredAuditEvent, now);
				return "retired" as const;
			});
		} catch (error) {
			if (error instanceof SecretKeyRotationStoreError) throw error;
			throw new SecretKeyRotationStoreError();
		}
	}
}

export function openPostgresSecretKeyRotationStoreV1(
	options: PostgresSecretKeyRotationStoreOptionsV1,
): PostgresSecretKeyRotationStoreV1 {
	return new PostgresSecretKeyRotationStoreV1(options);
}
