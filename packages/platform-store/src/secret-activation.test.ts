import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type { SecretActivationClaimV1 } from "@agent-infra/platform-core";
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
} from "./secret-activation.ts";

let databaseUrl = "";
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
	databaseUrl = database.databaseUrl;
	await migratePlatformDatabase({ databaseUrl });
	client = postgres(databaseUrl, { max: 1 });
	store = openPostgresSecretActivationStoreV1({ databaseUrl });
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
	await client`
		insert into platform.secret_records
			(agent_id, secret_id, secret_version, configuration_revision,
			 owner_type, owner_id, name, lifecycle_state, dek_fingerprint,
			 record, created_at, updated_at)
		values
			(${pending.agentId}, ${pending.secretId}, ${pending.secretVersion},
			 ${pending.configRevision}, ${pending.ownerType}, ${pending.ownerId},
			 ${pending.name}, ${pending.lifecycleState},
			 ${pending.crypto.dekFingerprint}, ${client.json(pending)},
			 ${new Date(pending.createdAt)}, ${new Date(pending.updatedAt)})
	`;
	await client`
		insert into platform.secret_records
			(agent_id, secret_id, secret_version, configuration_revision,
			 owner_type, owner_id, name, lifecycle_state, activation_fence,
			 dek_fingerprint, record, created_at, updated_at)
		values
			(${oldActive.agentId}, ${oldActive.secretId}, ${oldActive.secretVersion},
			 ${oldActive.configRevision}, ${oldActive.ownerType}, ${oldActive.ownerId},
			 ${oldActive.name}, ${oldActive.lifecycleState}, ${oldFence.fence},
			 ${oldActive.crypto.dekFingerprint}, ${client.json(oldActive)},
			 ${new Date(oldActive.createdAt)}, ${new Date(oldActive.updatedAt)})
	`;
}, 120_000);

afterAll(async () => {
	await store?.close();
	await client?.end();
	await database?.stop();
});

function claim(workerId: string) {
	return store.claimCandidate({
		schemaVersion: 1,
		agentId: pending.agentId,
		secretId: pending.secretId,
		secretVersion: pending.secretVersion,
		configRevision: pending.configRevision,
		workerId,
		leaseDurationMs: 60_000,
	});
}

function activationFence(claim: SecretActivationClaimV1) {
	return {
		schemaVersion: 1 as const,
		agentId: pending.agentId,
		secretId: pending.secretId,
		secretVersion: pending.secretVersion,
		configRevision: pending.configRevision,
		kubernetesSecretName:
			"agent-aaaaaaaaaaaaaaaa.secret-bbbbbbbbbbbbbbbb-v2-r7",
		workloadUid: "workload_uid_01",
		workloadGeneration: 4,
		fence: claim.fence,
	};
}

describe("PostgreSQL Secret activation Store", () => {
	it("fences concurrent Workers and rejects an expired owner's stale writes", async () => {
		const firstDecision = await claim("worker_01");
		expect(firstDecision.outcome).toBe("claimed");
		if (firstDecision.outcome !== "claimed") throw new Error("Expected claim");
		await expect(claim("worker_02")).resolves.toEqual({ outcome: "busy" });

		await client`
			update platform.secret_records
			set activation_lease_expires_at = clock_timestamp() - interval '1 second'
			where agent_id = ${pending.agentId} and secret_id = ${pending.secretId}
				and secret_version = ${pending.secretVersion}
		`;
		const secondDecision = await claim("worker_02");
		expect(secondDecision.outcome).toBe("claimed");
		if (secondDecision.outcome !== "claimed") throw new Error("Expected claim");
		expect(secondDecision.claim.fence).toBe(firstDecision.claim.fence + 1);

		await expect(
			store.markApplying({
				claim: firstDecision.claim,
				kubernetesSecretName: activationFence(firstDecision.claim)
					.kubernetesSecretName,
				activationFence: activationFence(firstDecision.claim),
			}),
		).resolves.toBe(false);

		const currentFence = activationFence(secondDecision.claim);
		const transition = {
			claim: secondDecision.claim,
			kubernetesSecretName: currentFence.kubernetesSecretName,
			activationFence: currentFence,
		};
		await expect(store.markApplying(transition)).resolves.toBe(true);
		await expect(store.markObserved(transition)).resolves.toBe(true);
		await expect(store.markActive(transition)).resolves.toBe(true);

		const rows = await client`
			select lifecycle_state, activation_fence, activation_owner,
				activation_lease_expires_at, secret_version, record
			from platform.secret_records
			where agent_id = ${pending.agentId} and secret_id = ${pending.secretId}
			order by secret_version
		`;
		expect(rows[0]).toMatchObject({
			lifecycle_state: "active",
			secret_version: "1",
			activation_fence: String(oldFence.fence),
		});
		expect(rows[1]).toMatchObject({
			lifecycle_state: "active",
			activation_fence: String(secondDecision.claim.fence),
			activation_owner: null,
			activation_lease_expires_at: null,
		});
		expect(
			validatePlatformSecretRecordV1(rows[1]?.record, currentFence),
		).toMatchObject({ lifecycleState: "active" });
	});

	it("reclaims retryable failures but rejects an obsolete configuration", async () => {
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
				 record, created_at, updated_at)
			values
				(${retryable.agentId}, ${retryable.secretId},
				 ${retryable.secretVersion}, ${retryable.configRevision},
				 ${retryable.ownerType}, ${retryable.ownerId}, ${retryable.name},
				 ${retryable.lifecycleState}, ${retryable.crypto.dekFingerprint},
				 ${client.json(retryable)}, ${new Date(retryable.createdAt)},
				 ${new Date(retryable.updatedAt)})
		`;
		const request = {
			schemaVersion: 1 as const,
			agentId: retryable.agentId,
			secretId: retryable.secretId,
			secretVersion: retryable.secretVersion,
			configRevision: retryable.configRevision,
			leaseDurationMs: 60_000,
		};
		const first = await store.claimCandidate({
			...request,
			workerId: "worker_01",
		});
		expect(first.outcome).toBe("claimed");
		if (first.outcome !== "claimed") throw new Error("Expected claim");
		await expect(
			store.markFailed({
				claim: first.claim,
				error: {
					schemaVersion: 1,
					code: "SECRET_KEY_UNAVAILABLE",
					message: "Secret key is unavailable",
					retryable: true,
					traceId: "trace_01",
				},
			}),
		).resolves.toBe(true);
		const second = await store.claimCandidate({
			...request,
			workerId: "worker_02",
		});
		expect(second).toMatchObject({
			outcome: "claimed",
			claim: { fence: first.claim.fence + 1 },
		});
		if (second.outcome !== "claimed") throw new Error("Expected claim");

		await client`
			update platform.agents
			set current_configuration_revision = 8
			where id = ${retryable.agentId}
		`;
		await expect(
			store.markFailed({
				claim: second.claim,
				error: {
					schemaVersion: 1,
					code: "SECRET_ACTIVATION_FAILED",
					message: "Secret activation failed",
					retryable: true,
					traceId: "trace_02",
				},
			}),
		).resolves.toBe(false);
		await expect(
			store.claimCandidate({
				...request,
				workerId: "worker_03",
			}),
		).resolves.toEqual({ outcome: "stale" });
	});
});
