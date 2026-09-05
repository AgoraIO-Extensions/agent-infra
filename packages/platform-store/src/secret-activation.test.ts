import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type {
	SecretActivationAuditIntentV1,
	SecretActivationCandidateV1,
	SecretActivationClaimStateV1,
	SecretActivationClaimV1,
	SecretActivationFenceV1,
	SecretActivationTransitionPlanV1,
} from "@agent-infra/platform-core";
import { immutableSecretNameV1 } from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import {
	openPostgresSecretActivationStoreV1,
	type PostgresSecretActivationStoreV1,
	SecretActivationStoreError,
} from "./secret-activation.ts";

let database: PostgresTestDatabase | undefined;
let client: ReturnType<typeof postgres>;
let store: PostgresSecretActivationStoreV1;

const pending = validatePlatformSecretRecordV1({
	schemaVersion: 1,
	secretId: "credential_01",
	ownerType: "agent-owner",
	ownerId: "owner_01",
	agentId: "agent_01",
	name: "MODEL_API_KEY",
	secretVersion: 2,
	configRevision: 7,
	lifecycleState: "pending",
	crypto: {
		schemaVersion: 1,
		algorithmVersion: "aes-256-gcm:v1",
		wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
		wrappingKeyVersion: "key_01",
		aadBinding: {
			schemaVersion: 1,
			aadVersion: "platform-secret-aad:v1",
			secretId: "credential_01",
			ownerType: "agent-owner",
			ownerId: "owner_01",
			agentId: "agent_01",
			name: "MODEL_API_KEY",
			secretVersion: 2,
			configRevision: 7,
			algorithmVersion: "aes-256-gcm:v1",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			wrappingKeyVersion: "key_01",
		},
		dekFingerprint: "a".repeat(64),
		nonce: "AAAAAAAAAAAAAAAA",
		ciphertext: "YWJjZA==",
		authenticationTag: "AAAAAAAAAAAAAAAAAAAAAA==",
		wrappedDek: "A".repeat(512),
	},
	createdAt: "2026-09-05T08:00:00.000Z",
	updatedAt: "2026-09-05T08:00:00.000Z",
});
const parallelPending = validatePlatformSecretRecordV1({
	...pending,
	secretId: "credential_02",
	name: "SECOND_KEY",
	crypto: {
		...pending.crypto,
		dekFingerprint: "d".repeat(64),
		aadBinding: {
			...pending.crypto.aadBinding,
			secretId: "credential_02",
			name: "SECOND_KEY",
		},
	},
});
const oldFence = {
	schemaVersion: 1 as const,
	agentId: pending.agentId,
	secretId: pending.secretId,
	secretVersion: 1,
	configRevision: 6,
	kubernetesSecretName: "agent-aaaaaaaaaaaaaaaa.secret-bbbbbbbbbbbbbbbb-v1-r6",
	workloadUid: "workload_uid_old",
	workloadGeneration: 3,
	fence: 4,
};
const oldActive = validatePlatformSecretRecordV1(
	{
		...pending,
		secretVersion: 1,
		configRevision: 6,
		lifecycleState: "active",
		crypto: {
			...pending.crypto,
			dekFingerprint: "b".repeat(64),
			aadBinding: {
				...pending.crypto.aadBinding,
				secretVersion: 1,
				configRevision: 6,
			},
		},
		kubernetesSecretRef: {
			schemaVersion: 1,
			ownerType: pending.ownerType,
			ownerId: pending.ownerId,
			agentId: pending.agentId,
			secretId: pending.secretId,
			secretVersion: 1,
			configRevision: 6,
			algorithmVersion: pending.crypto.algorithmVersion,
			wrappingAlgorithmVersion: pending.crypto.wrappingAlgorithmVersion,
			wrappingKeyVersion: pending.crypto.wrappingKeyVersion,
			name: oldFence.kubernetesSecretName,
		},
		activationFence: oldFence,
	},
	oldFence,
);

beforeAll(async () => {
	database = await startPostgresTestDatabase("secret-activation");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	client = postgres(database.databaseUrl, { max: 1 });
	store = openPostgresSecretActivationStoreV1({
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
	for (const record of [pending, parallelPending, oldActive]) {
		await client`
			insert into platform.secret_records
				(agent_id, secret_id, secret_version, configuration_revision,
				 owner_type, owner_id, name, lifecycle_state, dek_fingerprint,
				 wrapping_key_version, record, created_at, updated_at)
			values
				(${record.agentId}, ${record.secretId}, ${record.secretVersion},
				 ${record.configRevision}, ${record.ownerType}, ${record.ownerId},
				 ${record.name}, ${record.lifecycleState},
				 ${record.crypto.dekFingerprint}, ${record.crypto.wrappingKeyVersion},
				 ${client.json(record)},
				 ${new Date(record.createdAt)}, ${new Date(record.updatedAt)})
		`;
	}
}, 120_000);

afterAll(async () => {
	await store?.close();
	await client?.end();
	await database?.stop();
});

function coreClaimDecision(state: SecretActivationClaimStateV1) {
	if (state.currentConfigurationRevision !== state.candidate.configRevision) {
		return { outcome: "stale" as const };
	}
	if (state.candidate.lifecycleState === "active") {
		return { outcome: "active" as const };
	}
	if (
		state.candidate.lifecycleState === "failed" &&
		state.candidate.failureRetryable === false
	) {
		return { outcome: "failed" as const };
	}
	return { outcome: "claim" as const };
}

function claim(workerId: string, record = pending) {
	return store.claimCandidate(
		{
			schemaVersion: 1,
			agentId: record.agentId,
			secretId: record.secretId,
			secretVersion: record.secretVersion,
			configRevision: record.configRevision,
			workerId,
			leaseDurationMs: 60_000,
		},
		coreClaimDecision,
	);
}

function reference(candidate: SecretActivationCandidateV1) {
	return {
		schemaVersion: 1 as const,
		ownerType: candidate.ownerType,
		ownerId: candidate.ownerId,
		agentId: candidate.agentId,
		secretId: candidate.secretId,
		secretVersion: candidate.secretVersion,
		configRevision: candidate.configRevision,
		algorithmVersion: "aes-256-gcm:v1" as const,
		wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
		wrappingKeyVersion: candidate.wrappingKeyVersion,
		name: immutableSecretNameV1(candidate),
	};
}

function activationFence(claim: SecretActivationClaimV1) {
	return {
		schemaVersion: 1 as const,
		agentId: claim.candidate.agentId,
		secretId: claim.candidate.secretId,
		secretVersion: claim.candidate.secretVersion,
		configRevision: claim.candidate.configRevision,
		kubernetesSecretName: reference(claim.candidate).name,
		workloadUid: "workload_uid_01",
		workloadGeneration: 4,
		fence: claim.fence,
	};
}

function audit(
	claim: SecretActivationClaimV1,
	operation: "decrypt" | "activate",
	outcome: "succeeded" | "rejected" | "failed",
): SecretActivationAuditIntentV1 {
	return {
		schemaVersion: 1,
		auditId: `audit-${operation}-${outcome}-${claim.fence}`,
		traceId: "trace_01",
		actorType: "system",
		actorId: claim.workerId,
		action: operation === "decrypt" ? "secret.decrypt" : "secret.activate",
		targetType: "secret",
		targetId: claim.candidate.secretId,
		agentId: claim.candidate.agentId,
		outcome,
		details: {
			wrappingKeyVersion: claim.candidate.wrappingKeyVersion,
			operation,
			result: outcome,
		},
	};
}

function plan(input: {
	readonly expectedLifecycleStates: SecretActivationTransitionPlanV1["expectedLifecycleStates"];
	readonly expectedActivationFence?: SecretActivationFenceV1;
	readonly next: SecretActivationTransitionPlanV1["next"];
	readonly auditEvents?: readonly SecretActivationAuditIntentV1[];
}): SecretActivationTransitionPlanV1 {
	return {
		schemaVersion: 1,
		expectedLifecycleStates: input.expectedLifecycleStates,
		...(input.expectedActivationFence
			? { expectedActivationFence: input.expectedActivationFence }
			: {}),
		next: input.next,
		auditEvents: input.auditEvents ?? [],
	};
}

describe("PostgreSQL Secret activation Store", () => {
	it("serializes an Agent, fences stale writes and atomically activates with audit", async () => {
		const first = await claim("worker_01");
		expect(first.outcome).toBe("claimed");
		if (first.outcome !== "claimed") throw new Error("Expected claim");
		await expect(claim("worker_02", parallelPending)).resolves.toEqual({
			outcome: "busy",
		});
		await expect(claim("worker_02")).resolves.toEqual({ outcome: "busy" });

		await client`
			update platform.agents
			set secret_activation_lease_expires_at =
				clock_timestamp() - interval '1 second'
			where id = ${pending.agentId}
		`;
		const second = await claim("worker_02");
		expect(second.outcome).toBe("claimed");
		if (second.outcome !== "claimed") throw new Error("Expected claim");
		expect(second.claim.fence).toBe(first.claim.fence + 1);
		const staleFence = activationFence(first.claim);
		await expect(
			store.commitTransition({
				claim: first.claim,
				plan: plan({
					expectedLifecycleStates: ["pending"],
					next: {
						lifecycleState: "applying",
						kubernetesSecretRef: reference(first.claim.candidate),
						activationFence: staleFence,
					},
				}),
			}),
		).resolves.toBe(false);

		await expect(
			store.recordAudit({
				claim: second.claim,
				auditEvent: audit(second.claim, "decrypt", "succeeded"),
			}),
		).resolves.toBe(true);
		const currentReference = reference(second.claim.candidate);
		const currentFence = activationFence(second.claim);
		const wrongReference = {
			...currentReference,
			name: "unrelated-v2-r7",
		};
		await expect(
			store.commitTransition({
				claim: second.claim,
				plan: plan({
					expectedLifecycleStates: ["pending"],
					next: {
						lifecycleState: "applying",
						kubernetesSecretRef: wrongReference,
						activationFence: {
							...currentFence,
							kubernetesSecretName: wrongReference.name,
						},
					},
				}),
			}),
		).rejects.toBeInstanceOf(SecretActivationStoreError);
		await expect(
			store.commitTransition({
				claim: second.claim,
				plan: plan({
					expectedLifecycleStates: ["pending"],
					next: {
						lifecycleState: "applying",
						kubernetesSecretRef: currentReference,
						activationFence: currentFence,
					},
				}),
			}),
		).resolves.toBe(true);
		await expect(
			store.commitTransition({
				claim: second.claim,
				plan: plan({
					expectedLifecycleStates: ["applying"],
					expectedActivationFence: currentFence,
					next: {
						lifecycleState: "observed",
						kubernetesSecretRef: currentReference,
						activationFence: currentFence,
					},
				}),
			}),
		).resolves.toBe(true);

		await client`
			create function platform.fail_secret_activation_audit() returns trigger
			language plpgsql as $$ begin raise exception 'forced'; end $$
		`;
		await client`
			create trigger fail_secret_activation_audit before insert
			on platform.audit_events for each row
			execute function platform.fail_secret_activation_audit()
		`;
		const activePlan = plan({
			expectedLifecycleStates: ["observed"],
			expectedActivationFence: currentFence,
			next: {
				lifecycleState: "active",
				kubernetesSecretRef: currentReference,
				activationFence: currentFence,
			},
			auditEvents: [audit(second.claim, "activate", "succeeded")],
		});
		try {
			await expect(
				store.commitTransition({ claim: second.claim, plan: activePlan }),
			).rejects.toBeInstanceOf(SecretActivationStoreError);
			const [afterFailure] = await client`
				select lifecycle_state from platform.secret_records
				where agent_id = ${pending.agentId} and secret_id = ${pending.secretId}
					and secret_version = ${pending.secretVersion}
			`;
			expect(afterFailure?.lifecycle_state).toBe("observed");
		} finally {
			await client`drop trigger fail_secret_activation_audit on platform.audit_events`;
			await client`drop function platform.fail_secret_activation_audit()`;
		}
		await expect(
			store.commitTransition({ claim: second.claim, plan: activePlan }),
		).resolves.toBe(true);

		const records = await client`
			select secret_version, lifecycle_state, record
			from platform.secret_records
			where agent_id = ${pending.agentId} and secret_id = ${pending.secretId}
			order by secret_version
		`;
		expect(
			records.map(({ secret_version, lifecycle_state }) => ({
				secret_version,
				lifecycle_state,
			})),
		).toEqual([
			{ secret_version: "1", lifecycle_state: "active" },
			{ secret_version: "2", lifecycle_state: "active" },
		]);
		expect(
			validatePlatformSecretRecordV1(records[1]?.record, currentFence),
		).toMatchObject({ lifecycleState: "active" });
		const [agent] = await client`
			select secret_activation_fence, secret_activation_owner,
				secret_activation_lease_expires_at
			from platform.agents where id = ${pending.agentId}
		`;
		expect(agent).toEqual({
			secret_activation_fence: String(second.claim.fence),
			secret_activation_owner: null,
			secret_activation_lease_expires_at: null,
		});
		const auditRows = await client`
			select action, outcome, agent_id, target_id, details
			from platform.audit_events order by occurred_at, id
		`;
		expect(auditRows).toEqual([
			{
				action: "secret.decrypt",
				outcome: "succeeded",
				agent_id: pending.agentId,
				target_id: pending.secretId,
				details: {
					wrappingKeyVersion: "key_01",
					operation: "decrypt",
					result: "succeeded",
				},
			},
			{
				action: "secret.activate",
				outcome: "succeeded",
				agent_id: pending.agentId,
				target_id: pending.secretId,
				details: {
					wrappingKeyVersion: "key_01",
					operation: "activate",
					result: "succeeded",
				},
			},
		]);
		expect(JSON.stringify(auditRows)).not.toContain("YWJjZA==");
	});

	it("reclaims retryable failure but rejects obsolete configuration transitions", async () => {
		const retryable = validatePlatformSecretRecordV1({
			...pending,
			agentId: "agent_retry",
			secretId: "credential_retry",
			crypto: {
				...pending.crypto,
				dekFingerprint: "c".repeat(64),
				aadBinding: {
					...pending.crypto.aadBinding,
					agentId: "agent_retry",
					secretId: "credential_retry",
				},
			},
		});
		await client`
			insert into platform.agents (id, current_configuration_revision)
			values (${retryable.agentId}, 7)
		`;
		await client`
			insert into platform.agent_configuration_revisions
				(agent_id, revision, source_reference, created_at)
			values
				(${retryable.agentId}, 7, 'configuration_07', now()),
				(${retryable.agentId}, 8, 'configuration_08', now())
		`;
		await client`
			insert into platform.secret_records
				(agent_id, secret_id, secret_version, configuration_revision,
				 owner_type, owner_id, name, lifecycle_state, dek_fingerprint,
				 wrapping_key_version, record, created_at, updated_at)
			values
				(${retryable.agentId}, ${retryable.secretId}, ${retryable.secretVersion},
				 ${retryable.configRevision}, ${retryable.ownerType}, ${retryable.ownerId},
				 ${retryable.name}, ${retryable.lifecycleState},
				 ${retryable.crypto.dekFingerprint},
				 ${retryable.crypto.wrappingKeyVersion}, ${client.json(retryable)},
				 ${new Date(retryable.createdAt)}, ${new Date(retryable.updatedAt)})
		`;
		const first = await claim("worker_01", retryable);
		expect(first.outcome).toBe("claimed");
		if (first.outcome !== "claimed") throw new Error("Expected claim");
		await expect(
			store.commitTransition({
				claim: first.claim,
				plan: plan({
					expectedLifecycleStates: ["pending"],
					next: {
						lifecycleState: "failed",
						error: {
							schemaVersion: 1,
							code: "SECRET_KEY_UNAVAILABLE",
							message: "Secret key is unavailable",
							retryable: true,
							traceId: "trace_02",
						},
					},
					auditEvents: [audit(first.claim, "decrypt", "rejected")],
				}),
			}),
		).resolves.toBe(true);
		const second = await claim("worker_02", retryable);
		expect(second).toMatchObject({
			outcome: "claimed",
			claim: { fence: first.claim.fence + 1 },
		});
		if (second.outcome !== "claimed") throw new Error("Expected claim");

		await client`
			update platform.agents set current_configuration_revision = 8
			where id = ${retryable.agentId}
		`;
		await expect(
			store.commitTransition({
				claim: second.claim,
				plan: plan({
					expectedLifecycleStates: ["failed"],
					next: {
						lifecycleState: "failed",
						error: {
							schemaVersion: 1,
							code: "SECRET_ACTIVATION_FAILED",
							message: "Secret activation failed",
							retryable: true,
							traceId: "trace_03",
						},
					},
				}),
			}),
		).resolves.toBe(false);
		await expect(claim("worker_03", retryable)).resolves.toEqual({
			outcome: "stale",
		});
	});
});
