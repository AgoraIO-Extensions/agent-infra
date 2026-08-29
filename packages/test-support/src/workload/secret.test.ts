import { PlatformSecretRecordV1Schema } from "@agent-infra/contracts/workload";
import { describe, expect, it } from "vitest";

import { createFakeSecretActivationAdapterV1 } from "./secret.js";

const cryptoMetadata = {
	schemaVersion: 1,
	algorithmVersion: "aes-256-gcm:v1",
	aadVersion: "platform-secret-aad:v1",
	wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
	wrappingKeyVersion: "key-2026-08",
	dekFingerprint: "a".repeat(64),
	nonce: "AAAAAAAAAAAAAAAA",
	ciphertext: "c2VhbGVkLXNlY3JldA==",
	authenticationTag: "AAAAAAAAAAAAAAAAAAAAAA==",
	wrappedDek: "A".repeat(512),
} as const;

const secretRef = {
	schemaVersion: 1,
	agentId: "agent_01",
	secretId: "secret_01",
	secretVersion: 2,
	configRevision: 7,
	name: "agent-01-secret-01-v2-r7",
} as const;

const activationFence = {
	schemaVersion: 1,
	agentId: secretRef.agentId,
	secretId: secretRef.secretId,
	secretVersion: secretRef.secretVersion,
	configRevision: secretRef.configRevision,
	kubernetesSecretName: secretRef.name,
	workloadUid: "workload_uid_01",
	workloadGeneration: 4,
	fence: 11,
} as const;

const applying = {
	schemaVersion: 1,
	secretId: secretRef.secretId,
	ownerType: "agent-owner",
	ownerId: "user_01",
	agentId: secretRef.agentId,
	name: "MODEL_API_KEY",
	secretVersion: secretRef.secretVersion,
	configRevision: secretRef.configRevision,
	crypto: cryptoMetadata,
	createdAt: "2026-08-28T10:00:00Z",
	updatedAt: "2026-08-28T10:01:00Z",
	lifecycleState: "applying",
	kubernetesSecretRef: secretRef,
	activationFence,
} as const;

describe("Fake Secret activation V1", () => {
	it("recovers an observed activation after recreating the Fake", () => {
		const adapter = createFakeSecretActivationAdapterV1();
		const observed = adapter.observe(applying, activationFence, {
			schemaVersion: 1,
			status: "observed",
			kubernetesSecretRef: secretRef,
			activationFence,
			health: "healthy",
		});
		expect(observed.lifecycleState).toBe("observed");

		const [recovered] = adapter.recover([observed]);
		const active = adapter.activate(recovered, activationFence);
		expect(active.lifecycleState).toBe("active");
		expect(PlatformSecretRecordV1Schema.parse(active)).toEqual(active);
	});

	it("rejects a stale observation without changing the stored record", () => {
		const adapter = createFakeSecretActivationAdapterV1();
		expect(() =>
			adapter.observe(applying, activationFence, {
				schemaVersion: 1,
				status: "observed",
				kubernetesSecretRef: secretRef,
				activationFence: { ...activationFence, fence: 10 },
				health: "healthy",
			}),
		).toThrow("Secret activation fence mismatch");
		expect(applying.lifecycleState).toBe("applying");
		expect(() =>
			adapter.observe(
				applying,
				{ ...activationFence, fence: 12 },
				{
					schemaVersion: 1,
					status: "observed",
					kubernetesSecretRef: secretRef,
					activationFence: { ...activationFence, fence: 12 },
					health: "healthy",
				},
			),
		).toThrow("Platform Secret record correlation mismatch");
	});

	it("persists a schema-valid failed activation without Secret plaintext", () => {
		const adapter = createFakeSecretActivationAdapterV1();
		const failed = adapter.observe(applying, activationFence, {
			schemaVersion: 1,
			status: "failed",
			kubernetesSecretRef: secretRef,
			activationFence,
			health: "unhealthy",
			error: {
				schemaVersion: 1,
				code: "SECRET_ACTIVATION_FAILED",
				message: "The candidate Workload did not become healthy",
				retryable: true,
				traceId: "trace_secret_01",
			},
		});

		expect(failed.lifecycleState).toBe("failed");
		expect(JSON.stringify(failed)).not.toContain("plaintext");
		expect(PlatformSecretRecordV1Schema.parse(failed)).toEqual(failed);
	});

	it("recovers old active and candidate versions without collapsing them", () => {
		const adapter = createFakeSecretActivationAdapterV1();
		const oldSecretRef = {
			...secretRef,
			secretVersion: 1,
			configRevision: 6,
			name: "agent-01-secret-01-v1-r6",
		} as const;
		const oldFence = {
			...activationFence,
			secretVersion: 1,
			configRevision: 6,
			kubernetesSecretName: oldSecretRef.name,
			workloadGeneration: 3,
			fence: 10,
		} as const;
		const oldActive = {
			...applying,
			secretVersion: 1,
			configRevision: 6,
			lifecycleState: "active",
			kubernetesSecretRef: oldSecretRef,
			activationFence: oldFence,
		} as const;

		const recovered = adapter.recover([oldActive, applying]);
		expect(recovered).toHaveLength(2);
		expect(recovered.map(({ secretVersion }) => secretVersion)).toEqual([1, 2]);
	});

	it("rejects cross-linked records through read, recover, and activate", () => {
		const adapter = createFakeSecretActivationAdapterV1();
		const crossLinked = {
			...applying,
			lifecycleState: "observed",
			kubernetesSecretRef: {
				...secretRef,
				name: "agent-01-secret-01-v2-r8",
			},
		} as const;

		expect(() => adapter.read(crossLinked)).toThrow(
			"Platform Secret record correlation mismatch",
		);
		expect(() => adapter.recover([crossLinked])).toThrow(
			"Platform Secret record correlation mismatch",
		);
		expect(() => adapter.activate(crossLinked, activationFence)).toThrow(
			"Platform Secret record correlation mismatch",
		);
	});
});
