import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type {
	AgentConfigurationRecordV1,
	RetireSecretKeyCommandV1,
	RotateSecretKeyCommandV1,
	SecretKeyRotationAuditIntentV1,
	SecretKeyRotationCandidateV1,
} from "@agent-infra/platform-core";
import { createSecretKeyRotationUseCaseV1 } from "@agent-infra/platform-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import {
	openPostgresSecretKeyRotationStoreV1,
	type PostgresSecretKeyRotationStoreV1,
} from "./secret-key-rotation.ts";
import {
	insertPendingSecretRecordAttachments,
	PendingSecretRecordStoreError,
} from "./secret-records.ts";

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;
let store: PostgresSecretKeyRotationStoreV1;

const command: RotateSecretKeyCommandV1 = {
	schemaVersion: 1,
	rotationId: "rotation_01",
	sourceKeyVersions: ["key_01"],
	targetKeyVersion: "key_02",
	workerId: "worker_01",
	traceId: "trace_rotation_01",
};

function record(input: {
	readonly version: number;
	readonly revision: number;
	readonly lifecycleState: "pending" | "active";
	readonly fingerprint: string;
}) {
	const base = {
		schemaVersion: 1 as const,
		secretId: "credential_01",
		ownerType: "agent-owner" as const,
		ownerId: "owner_01",
		agentId: "agent_01",
		name: "MODEL_API_KEY",
		secretVersion: input.version,
		configRevision: input.revision,
		crypto: {
			schemaVersion: 1 as const,
			algorithmVersion: "aes-256-gcm:v1" as const,
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
			wrappingKeyVersion: "key_01",
			aadBinding: {
				schemaVersion: 1 as const,
				aadVersion: "platform-secret-aad:v1" as const,
				secretId: "credential_01",
				ownerType: "agent-owner" as const,
				ownerId: "owner_01",
				agentId: "agent_01",
				name: "MODEL_API_KEY",
				secretVersion: input.version,
				configRevision: input.revision,
				algorithmVersion: "aes-256-gcm:v1" as const,
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
				wrappingKeyVersion: "key_01",
			},
			dekFingerprint: input.fingerprint,
			nonce: "AAAAAAAAAAAAAAAA",
			ciphertext: "YWJjZA==",
			authenticationTag: "AAAAAAAAAAAAAAAAAAAAAA==",
			wrappedDek: "A".repeat(512),
		},
		createdAt: "2026-09-05T08:00:00.000Z",
		updatedAt: "2026-09-05T08:00:00.000Z",
	};
	if (input.lifecycleState === "pending") {
		return validatePlatformSecretRecordV1({
			...base,
			lifecycleState: "pending",
		});
	}
	const name = `agent-aaaaaaaaaaaaaaaa.secret-bbbbbbbbbbbbbbbb-v${input.version}-r${input.revision}`;
	return validatePlatformSecretRecordV1({
		...base,
		lifecycleState: "active",
		kubernetesSecretRef: {
			schemaVersion: 1,
			ownerType: base.ownerType,
			ownerId: base.ownerId,
			agentId: base.agentId,
			secretId: base.secretId,
			secretVersion: input.version,
			configRevision: input.revision,
			algorithmVersion: base.crypto.algorithmVersion,
			wrappingAlgorithmVersion: base.crypto.wrappingAlgorithmVersion,
			wrappingKeyVersion: "key_01",
			name,
		},
		activationFence: {
			schemaVersion: 1,
			agentId: base.agentId,
			secretId: base.secretId,
			secretVersion: input.version,
			configRevision: input.revision,
			kubernetesSecretName: name,
			workloadUid: "workload_01",
			workloadGeneration: 3,
			fence: 4,
		},
	});
}

const oldActive = record({
	version: 1,
	revision: 6,
	lifecycleState: "active",
	fingerprint: "a".repeat(64),
});
const replacement = record({
	version: 2,
	revision: 7,
	lifecycleState: "pending",
	fingerprint: "b".repeat(64),
});

function reencrypted(
	candidate: SecretKeyRotationCandidateV1,
	fingerprint: string,
	targetKeyVersion = "key_02",
) {
	const source = validatePlatformSecretRecordV1(candidate.encryptedRecord);
	return validatePlatformSecretRecordV1({
		...source,
		crypto: {
			...source.crypto,
			wrappingKeyVersion: targetKeyVersion,
			dekFingerprint: fingerprint,
			nonce: "AQEBAQEBAQEBAQEB",
			aadBinding: {
				...source.crypto.aadBinding,
				wrappingKeyVersion: targetKeyVersion,
			},
		},
		...(source.lifecycleState === "active"
			? {
					kubernetesSecretRef: {
						...source.kubernetesSecretRef,
						wrappingKeyVersion: targetKeyVersion,
					},
				}
			: {}),
		updatedAt: "2026-09-05T13:30:00.000Z",
	});
}

function audit(
	candidate: SecretKeyRotationCandidateV1,
	rotation: RotateSecretKeyCommandV1 = command,
	outcome: "succeeded" | "rejected" | "failed" = "succeeded",
	operation: "decrypt" | "rewrap" = "rewrap",
) {
	return {
		schemaVersion: 1,
		auditId: `audit-${rotation.rotationId}-${candidate.secretVersion}-${operation}-${outcome}`,
		traceId: rotation.traceId,
		actorType: "system",
		actorId: rotation.workerId,
		action: operation === "decrypt" ? "secret.decrypt" : "secret.rewrap",
		targetType: "secret",
		targetId: candidate.secretId,
		agentId: candidate.agentId,
		outcome,
		details: {
			wrappingKeyVersion: candidate.wrappingKeyVersion,
			operation,
			result: outcome,
		},
	} satisfies SecretKeyRotationAuditIntentV1;
}

function retirementAudit(
	command: RetireSecretKeyCommandV1,
	outcome: "succeeded" | "rejected",
) {
	return {
		schemaVersion: 1,
		auditId: `audit-retire-${command.keyVersion}-${outcome}`,
		traceId: command.traceId,
		actorType: "system",
		actorId: command.workerId,
		action: "secret.retire-key",
		targetType: "secret_key",
		targetId: command.keyVersion,
		agentId: null,
		outcome,
		details: {
			wrappingKeyVersion: command.keyVersion,
			operation: "retire-key",
			result: outcome,
		},
	} satisfies SecretKeyRotationAuditIntentV1;
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("secret-key-rotation");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 1 });
	store = openPostgresSecretKeyRotationStoreV1({
		databaseUrl: database.databaseUrl,
	});
	await client`
		insert into platform.agents (id, current_configuration_revision)
		values ('agent_01', 7)
	`;
	await client`
		insert into platform.agent_configuration_revisions
			(agent_id, revision, source_reference, created_at)
		values
			('agent_01', 6, 'configuration_06', now()),
			('agent_01', 7, 'configuration_07', now())
	`;
	for (const secretRecord of [oldActive, replacement]) {
		await client`
			insert into platform.secret_records
				(agent_id, secret_id, secret_version, configuration_revision,
				 owner_type, owner_id, name, lifecycle_state, dek_fingerprint,
				 record, created_at, updated_at)
			values
				(${secretRecord.agentId}, ${secretRecord.secretId},
				 ${secretRecord.secretVersion}, ${secretRecord.configRevision},
				 ${secretRecord.ownerType}, ${secretRecord.ownerId}, ${secretRecord.name},
				 ${secretRecord.lifecycleState}, ${secretRecord.crypto.dekFingerprint},
				 ${client.json(secretRecord)}, ${new Date(secretRecord.createdAt)},
				 ${new Date(secretRecord.updatedAt)})
		`;
	}
}, 120_000);

afterAll(async () => {
	await store?.close();
	await client?.end();
	await database?.stop();
});

describe("PostgreSQL Secret key rotation Store", () => {
	it("recovers before commit and atomically rotates without dropping the old active version", async () => {
		const first = await store.nextCandidate(command);
		expect(first.outcome).toBe("candidate");
		if (first.outcome !== "candidate") throw new Error("Expected candidate");
		expect(first.candidate).toMatchObject({
			secretVersion: 1,
			lifecycleState: "active",
			wrappingKeyVersion: "key_01",
		});

		const recovered = await store.nextCandidate(command);
		expect(recovered).toMatchObject({
			outcome: "candidate",
			candidate: { secretVersion: 1, dekFingerprint: "a".repeat(64) },
		});

		await expect(
			store.commitReencryption({
				command,
				candidate: first.candidate,
				encryptedRecord: reencrypted(first.candidate, "c".repeat(64)),
				auditEvents: [
					audit(first.candidate, command, "succeeded", "decrypt"),
					audit(first.candidate),
				],
			}),
		).resolves.toMatchObject({
			outcome: "committed",
			progress: { processedSecrets: 1, remainingSecrets: 1 },
		});
		const rows = await client`
			select secret_version, lifecycle_state,
				record -> 'crypto' ->> 'wrappingKeyVersion' as key_version
			from platform.secret_records order by secret_version
		`;
		expect(rows).toEqual([
			{ secret_version: "1", lifecycle_state: "active", key_version: "key_02" },
			{
				secret_version: "2",
				lifecycle_state: "pending",
				key_version: "key_01",
			},
		]);
		expect(JSON.stringify(rows)).not.toContain("YWJjZA==");

		const retirement = {
			schemaVersion: 1 as const,
			keyVersion: "key_01",
			workerId: "worker_01",
			traceId: "trace_retire_01",
		};
		await expect(
			store.retireKey({
				command: retirement,
				activeWrappingKeyVersion: "key_02",
				retiredAuditEvent: retirementAudit(retirement, "succeeded"),
				rejectedAuditEvent: retirementAudit(retirement, "rejected"),
			}),
		).resolves.toBe("referenced");

		const second = await store.nextCandidate(command);
		expect(second.outcome).toBe("candidate");
		if (second.outcome !== "candidate") throw new Error("Expected candidate");
		const secondCommit = {
			command,
			candidate: second.candidate,
			encryptedRecord: reencrypted(second.candidate, "d".repeat(64)),
			auditEvents: [
				audit(second.candidate, command, "succeeded", "decrypt"),
				audit(second.candidate),
			],
		};
		await expect(store.commitReencryption(secondCommit)).resolves.toMatchObject(
			{
				outcome: "committed",
				progress: {
					state: "completed",
					processedSecrets: 2,
					remainingSecrets: 0,
				},
			},
		);
		await expect(store.commitReencryption(secondCommit)).resolves.toEqual({
			outcome: "stale",
		});
		await expect(store.nextCandidate(command)).resolves.toMatchObject({
			outcome: "completed",
			progress: { state: "completed", remainingSecrets: 0 },
		});
		await expect(
			store.retireKey({
				command: retirement,
				activeWrappingKeyVersion: "key_02",
				retiredAuditEvent: retirementAudit(retirement, "succeeded"),
				rejectedAuditEvent: retirementAudit(retirement, "rejected"),
			}),
		).resolves.toBe("retired");
		const activeRetirement = {
			...retirement,
			keyVersion: "key_02",
			traceId: "trace_retire_active",
		};
		await expect(
			store.retireKey({
				command: activeRetirement,
				activeWrappingKeyVersion: "key_02",
				retiredAuditEvent: retirementAudit(activeRetirement, "succeeded"),
				rejectedAuditEvent: retirementAudit(activeRetirement, "rejected"),
			}),
		).resolves.toBe("referenced");

		const audits = await client`
			select action, outcome, agent_id, target_id, details
			from platform.audit_events order by occurred_at, id
		`;
		expect(audits.map(({ action, outcome }) => ({ action, outcome }))).toEqual([
			{ action: "secret.decrypt", outcome: "succeeded" },
			{ action: "secret.rewrap", outcome: "succeeded" },
			{ action: "secret.retire-key", outcome: "rejected" },
			{ action: "secret.decrypt", outcome: "succeeded" },
			{ action: "secret.rewrap", outcome: "succeeded" },
			{ action: "secret.retire-key", outcome: "succeeded" },
			{ action: "secret.retire-key", outcome: "rejected" },
		]);
		expect(
			audits.find(
				({ action, outcome, target_id }) =>
					action === "secret.retire-key" &&
					outcome === "succeeded" &&
					target_id === "key_01",
			),
		).toEqual({
			action: "secret.retire-key",
			outcome: "succeeded",
			agent_id: null,
			target_id: "key_01",
			details: {
				wrappingKeyVersion: "key_01",
				operation: "retire-key",
				result: "succeeded",
			},
		});
		expect(JSON.stringify(audits)).not.toContain("YWJjZA==");
	});

	it("rolls back ciphertext, audit, and progress on a duplicate DEK fingerprint", async () => {
		const duplicateSource = validatePlatformSecretRecordV1({
			...replacement,
			agentId: "agent_collision",
			secretId: "credential_collision",
			crypto: {
				...replacement.crypto,
				wrappingKeyVersion: "key_03",
				dekFingerprint: "e".repeat(64),
				aadBinding: {
					...replacement.crypto.aadBinding,
					agentId: "agent_collision",
					secretId: "credential_collision",
					wrappingKeyVersion: "key_03",
				},
			},
		});
		await client`
			insert into platform.agents (id, current_configuration_revision)
			values (${duplicateSource.agentId}, ${duplicateSource.configRevision})
		`;
		await client`
			insert into platform.agent_configuration_revisions
				(agent_id, revision, source_reference, created_at)
			values
				(${duplicateSource.agentId}, ${duplicateSource.configRevision},
				 'configuration_collision', now())
		`;
		await client`
			insert into platform.secret_records
				(agent_id, secret_id, secret_version, configuration_revision,
				 owner_type, owner_id, name, lifecycle_state, dek_fingerprint,
				 record, created_at, updated_at)
			values
				(${duplicateSource.agentId}, ${duplicateSource.secretId},
				 ${duplicateSource.secretVersion}, ${duplicateSource.configRevision},
				 ${duplicateSource.ownerType}, ${duplicateSource.ownerId},
				 ${duplicateSource.name}, ${duplicateSource.lifecycleState},
				 ${duplicateSource.crypto.dekFingerprint}, ${client.json(duplicateSource)},
				 ${new Date(duplicateSource.createdAt)},
				 ${new Date(duplicateSource.updatedAt)})
		`;
		const collisionCommand = {
			...command,
			rotationId: "rotation_collision",
			sourceKeyVersions: ["key_03"],
			targetKeyVersion: "key_04",
			traceId: "trace_collision",
		};
		const next = await store.nextCandidate(collisionCommand);
		expect(next.outcome).toBe("candidate");
		if (next.outcome !== "candidate") throw new Error("Expected candidate");

		await expect(
			store.commitReencryption({
				command: collisionCommand,
				candidate: next.candidate,
				encryptedRecord: reencrypted(next.candidate, "c".repeat(64), "key_04"),
				auditEvents: [
					audit(next.candidate, collisionCommand, "succeeded", "decrypt"),
					audit(next.candidate, collisionCommand),
				],
			}),
		).resolves.toEqual({ outcome: "duplicate-fingerprint" });
		const [persisted] = await client`
			select dek_fingerprint, record -> 'crypto' ->> 'wrappingKeyVersion' as key_version
			from platform.secret_records where agent_id = ${duplicateSource.agentId}
		`;
		expect(persisted).toEqual({
			dek_fingerprint: "e".repeat(64),
			key_version: "key_03",
		});
		const [rotation] = await client`
			select processed_secrets, remaining_secrets from platform.secret_key_rotations
			where rotation_id = ${collisionCommand.rotationId}
		`;
		expect(rotation).toEqual({
			processed_secrets: "0",
			remaining_secrets: "1",
		});
		const [auditCount] = await client`
			select count(*)::text as count from platform.audit_events
			where trace_id = ${collisionCommand.traceId}
		`;
		expect(auditCount?.count).toBe("0");
	});

	it("rejects a new ciphertext that uses a retired wrapping key", async () => {
		const retiredRecord = validatePlatformSecretRecordV1({
			...replacement,
			agentId: "agent_retired_key",
			secretId: "credential_retired_key",
			crypto: {
				...replacement.crypto,
				dekFingerprint: "f".repeat(64),
				aadBinding: {
					...replacement.crypto.aadBinding,
					agentId: "agent_retired_key",
					secretId: "credential_retired_key",
				},
			},
		});
		await client`
			insert into platform.agents (id, current_configuration_revision)
			values (${retiredRecord.agentId}, ${retiredRecord.configRevision})
		`;
		await client`
			insert into platform.agent_configuration_revisions
				(agent_id, revision, source_reference, created_at)
			values
				(${retiredRecord.agentId}, ${retiredRecord.configRevision},
				 'configuration_retired_key', now())
		`;
		const configuration = {
			agentId: retiredRecord.agentId,
			revision: retiredRecord.configRevision,
			secrets: [
				{
					name: retiredRecord.name,
					secretId: retiredRecord.secretId,
					version: retiredRecord.secretVersion,
					isSet: true,
				},
			],
			modelConfiguration: null,
		} as unknown as AgentConfigurationRecordV1;
		const attachments = {
			schemaVersion: 1 as const,
			expected: [
				{
					schemaVersion: 1 as const,
					ownerType: "agent-owner" as const,
					ownerId: retiredRecord.ownerId,
					agentId: retiredRecord.agentId,
					name: retiredRecord.name,
					secretId: retiredRecord.secretId,
					secretVersion: retiredRecord.secretVersion,
					configurationRevision: retiredRecord.configRevision,
					occurredAt: retiredRecord.createdAt,
				},
			],
			encryptedRecords: [retiredRecord],
		};

		if (!database) throw new Error("Expected database");
		const admissionClient = postgres(database.databaseUrl, { max: 1 });
		await expect(
			drizzle(admissionClient).transaction((transaction) =>
				insertPendingSecretRecordAttachments(
					transaction,
					attachments,
					configuration,
				),
			),
		).rejects.toBeInstanceOf(PendingSecretRecordStoreError);
		await admissionClient.end();
		const [count] = await client`
			select count(*)::text as count from platform.secret_records
			where agent_id = ${retiredRecord.agentId}
		`;
		expect(count?.count).toBe("0");
	});

	it("keeps a key-missing rotation retryable but terminates authenticated corruption", async () => {
		const rejectedRecord = validatePlatformSecretRecordV1({
			...replacement,
			agentId: "agent_rejection",
			secretId: "credential_rejection",
			crypto: {
				...replacement.crypto,
				wrappingKeyVersion: "key_05",
				dekFingerprint: "1".repeat(64),
				aadBinding: {
					...replacement.crypto.aadBinding,
					agentId: "agent_rejection",
					secretId: "credential_rejection",
					wrappingKeyVersion: "key_05",
				},
			},
		});
		await client`
			insert into platform.agents (id, current_configuration_revision)
			values (${rejectedRecord.agentId}, ${rejectedRecord.configRevision})
		`;
		await client`
			insert into platform.agent_configuration_revisions
				(agent_id, revision, source_reference, created_at)
			values (${rejectedRecord.agentId}, ${rejectedRecord.configRevision},
				'configuration_rejection', now())
		`;
		await client`
			insert into platform.secret_records
				(agent_id, secret_id, secret_version, configuration_revision,
				 owner_type, owner_id, name, lifecycle_state, dek_fingerprint,
				 record, created_at, updated_at)
			values (${rejectedRecord.agentId}, ${rejectedRecord.secretId},
				${rejectedRecord.secretVersion}, ${rejectedRecord.configRevision},
				${rejectedRecord.ownerType}, ${rejectedRecord.ownerId},
				${rejectedRecord.name}, ${rejectedRecord.lifecycleState},
				${rejectedRecord.crypto.dekFingerprint}, ${client.json(rejectedRecord)},
				${new Date(rejectedRecord.createdAt)}, ${new Date(rejectedRecord.updatedAt)})
		`;
		const rejectionCommand = {
			...command,
			rotationId: "rotation_rejection",
			sourceKeyVersions: ["key_05"],
			targetKeyVersion: "key_06",
			traceId: "trace_rejection",
		};
		const first = await store.nextCandidate(rejectionCommand);
		expect(first.outcome).toBe("candidate");
		if (first.outcome !== "candidate") throw new Error("Expected candidate");
		await expect(
			store.recordRejection({
				command: rejectionCommand,
				candidate: first.candidate,
				failureCode: "SECRET_KEY_UNAVAILABLE",
				auditEvents: [
					audit(first.candidate, rejectionCommand, "failed", "decrypt"),
				],
			}),
		).resolves.toBe(true);
		const retried = await store.nextCandidate(rejectionCommand);
		expect(retried).toMatchObject({
			outcome: "candidate",
			progress: { state: "rewrapping", remainingSecrets: 1 },
		});
		if (retried.outcome !== "candidate") throw new Error("Expected retry");
		await expect(
			store.recordRejection({
				command: rejectionCommand,
				candidate: retried.candidate,
				failureCode: "SECRET_AUTHENTICATION_FAILED",
				auditEvents: [
					audit(retried.candidate, rejectionCommand, "rejected", "decrypt"),
				],
			}),
		).resolves.toBe(true);
		await expect(store.nextCandidate(rejectionCommand)).resolves.toMatchObject({
			outcome: "failed",
			progress: { state: "failed", processedSecrets: 0, remainingSecrets: 1 },
		});
		await expect(
			store.recordRejection({
				command: rejectionCommand,
				candidate: retried.candidate,
				failureCode: "SECRET_KEY_UNAVAILABLE",
				auditEvents: [
					audit(retried.candidate, rejectionCommand, "failed", "decrypt"),
				],
			}),
		).resolves.toBe(false);
		await expect(store.nextCandidate(rejectionCommand)).resolves.toMatchObject({
			outcome: "failed",
			progress: { state: "failed" },
		});
		const audits = await client`
			select outcome, details from platform.audit_events
			where trace_id = ${rejectionCommand.traceId} order by occurred_at, id
		`;
		expect(audits).toEqual([
			{
				outcome: "failed",
				details: {
					wrappingKeyVersion: "key_05",
					operation: "decrypt",
					result: "failed",
				},
			},
			{
				outcome: "rejected",
				details: {
					wrappingKeyVersion: "key_05",
					operation: "decrypt",
					result: "rejected",
				},
			},
		]);
		expect(JSON.stringify(audits)).not.toContain("YWJjZA==");
	});

	it("rejects audit attribution that is not bound to the rotation command", async () => {
		const next = await store.nextCandidate({
			...command,
			rotationId: "rotation_collision",
			sourceKeyVersions: ["key_03"],
			targetKeyVersion: "key_04",
			traceId: "trace_collision",
		});
		expect(next.outcome).toBe("candidate");
		if (next.outcome !== "candidate") throw new Error("Expected candidate");
		const mismatchedCommand = {
			...command,
			rotationId: "rotation_collision",
			sourceKeyVersions: ["key_03"],
			targetKeyVersion: "key_04",
			traceId: "trace_collision",
		};

		await expect(
			store.recordRejection({
				command: mismatchedCommand,
				candidate: next.candidate,
				failureCode: "SECRET_KEY_UNAVAILABLE",
				auditEvents: [
					{
						...audit(next.candidate, mismatchedCommand, "failed", "decrypt"),
						actorId: "other_worker",
					},
				],
			}),
		).rejects.toBeInstanceOf(Error);
		await expect(
			store.recordRejection({
				command: mismatchedCommand,
				candidate: next.candidate,
				failureCode: "SECRET_KEY_UNAVAILABLE",
				auditEvents: [
					{
						...audit(next.candidate, mismatchedCommand, "failed", "decrypt"),
						traceId: "other_trace",
					},
				],
			}),
		).rejects.toBeInstanceOf(Error);
	});

	it("audits malformed persisted AAD before terminating rotation", async () => {
		await client`
			update platform.secret_records
			set record = jsonb_set(record, '{crypto,aadBinding,agentId}', '"agent_swapped"')
			where agent_id = 'agent_collision'
		`;
		const malformedCommand = {
			...command,
			rotationId: "rotation_collision",
			sourceKeyVersions: ["key_03"],
			targetKeyVersion: "key_04",
			traceId: "trace_collision",
		};
		const useCase = createSecretKeyRotationUseCaseV1({
			store,
			crypto: {
				activeWrappingKeyVersion: "key_04",
				retiringWrappingKeyVersions: ["key_03"],
				async reencrypt({ encryptedRecord }) {
					try {
						validatePlatformSecretRecordV1(encryptedRecord);
						return {
							outcome: "failed" as const,
							code: "SECRET_ROTATION_FAILED" as const,
						};
					} catch {
						return {
							outcome: "failed" as const,
							code: "SECRET_METADATA_INVALID" as const,
						};
					}
				},
			},
		});

		await expect(useCase.rotate(malformedCommand)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "failed",
			code: "SECRET_METADATA_INVALID",
		});
		const audits = await client`
			select action, outcome, details from platform.audit_events
			where trace_id = ${malformedCommand.traceId}
			order by occurred_at desc, id desc limit 1
		`;
		expect(audits).toEqual([
			{
				action: "secret.decrypt",
				outcome: "rejected",
				details: {
					wrappingKeyVersion: "key_03",
					operation: "decrypt",
					result: "rejected",
				},
			},
		]);
		expect(JSON.stringify(audits)).not.toContain("agent_swapped");
		await expect(store.nextCandidate(malformedCommand)).resolves.toMatchObject({
			outcome: "failed",
			progress: { state: "failed" },
		});
	});
});
