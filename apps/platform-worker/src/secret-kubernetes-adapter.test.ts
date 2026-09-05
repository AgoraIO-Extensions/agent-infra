import { createHash } from "node:crypto";

import {
	createSecretActivationUseCaseV1,
	type SecretActivationAuditIntentV1,
	type SecretActivationCandidateV1,
	type SecretActivationClaimPlanV1,
	type SecretActivationClaimStateV1,
	type SecretActivationClaimV1,
	type SecretActivationFenceV1,
	type SecretActivationReferenceV1,
	type SecretActivationStorePortV1,
	type SecretActivationTransitionPlanV1,
} from "@agent-infra/platform-core";
import { describe, expect, it } from "vitest";
import { secretActivationKubernetesConformanceV1 } from "../../../packages/platform-core/src/secret-activation.conformance.js";
import {
	createWorkerSecretActivationKubernetesPortV1,
	type WorkerSecretKubernetesClientV1,
} from "./secret-kubernetes-adapter.js";

class FakeWorkerSecretKubernetesClient
	implements WorkerSecretKubernetesClientV1
{
	readonly #secrets = new Map<string, { key: string; digest: string }>();
	readonly #observations = new Map<string, unknown>();
	readonly #activeSecretName = "agent-old.secret-old-v1-r6";
	#generation = 0;
	#observationMode:
		| "observed"
		| "missing"
		| "malformed"
		| "mismatched"
		| "unavailable" = "observed";
	#failNextApply = false;
	#failNextWorkload = false;

	activeSecretName(): string {
		return this.#activeSecretName;
	}

	setObservation(
		mode: "missing" | "malformed" | "mismatched" | "unavailable",
	): void {
		this.#observationMode = mode;
	}

	failNextApply(): void {
		this.#failNextApply = true;
	}

	failNextWorkloadAfterSecret(): void {
		this.#failNextWorkload = true;
	}

	async applyImmutableSecret(input: {
		readonly kubernetesSecretRef: SecretActivationReferenceV1;
		readonly secretKey: string;
		readonly plaintext: Uint8Array;
	}) {
		if (this.#failNextApply) {
			this.#failNextApply = false;
			throw new Error("simulated unavailable apply");
		}
		const digest = createHash("sha256").update(input.plaintext).digest("hex");
		const existing = this.#secrets.get(input.kubernetesSecretRef.name);
		if (existing) {
			return existing.key === input.secretKey && existing.digest === digest
				? ("unchanged" as const)
				: ("conflict" as const);
		}
		this.#secrets.set(input.kubernetesSecretRef.name, {
			key: input.secretKey,
			digest,
		});
		return "created" as const;
	}

	async applyCandidateWorkload(input: {
		readonly kubernetesSecretRef: SecretActivationReferenceV1;
		readonly fence: number;
	}) {
		if (this.#failNextWorkload) {
			this.#failNextWorkload = false;
			throw new Error("simulated crash after immutable Secret");
		}
		this.#generation += 1;
		const workloadUid = "workload_uid_01";
		const activationFence: SecretActivationFenceV1 = {
			schemaVersion: 1,
			agentId: input.kubernetesSecretRef.agentId,
			secretId: input.kubernetesSecretRef.secretId,
			secretVersion: input.kubernetesSecretRef.secretVersion,
			configRevision: input.kubernetesSecretRef.configRevision,
			kubernetesSecretName: input.kubernetesSecretRef.name,
			workloadUid,
			workloadGeneration: this.#generation,
			fence: input.fence,
		};
		this.#observations.set(input.kubernetesSecretRef.name, {
			schemaVersion: 1,
			status: "observed",
			kubernetesSecretRef: input.kubernetesSecretRef,
			activationFence,
			health: "healthy",
		});
		return { workloadUid, workloadGeneration: this.#generation };
	}

	async observeCandidateWorkload(input: {
		readonly kubernetesSecretRef: SecretActivationReferenceV1;
		readonly activationFence: SecretActivationFenceV1;
	}) {
		const mode = this.#observationMode;
		this.#observationMode = "observed";
		if (mode === "missing") return null;
		if (mode === "unavailable") throw new Error("simulated unavailable read");
		if (mode === "malformed") {
			return { status: "observed", detail: "boundary-sensitive" };
		}
		const observation = this.#observations.get(input.kubernetesSecretRef.name);
		if (
			mode === "mismatched" &&
			observation &&
			typeof observation === "object"
		) {
			return {
				...observation,
				activationFence: {
					...(observation as { activationFence: SecretActivationFenceV1 })
						.activationFence,
					fence: input.activationFence.fence + 1,
				},
			};
		}
		return observation ?? null;
	}
}

const recoveryCandidate: SecretActivationCandidateV1 = {
	schemaVersion: 1,
	agentId: "agent_01",
	secretId: "credential_01",
	secretVersion: 2,
	configRevision: 7,
	ownerType: "agent-owner",
	ownerId: "owner_01",
	name: "MODEL_API_KEY",
	wrappingKeyVersion: "key_01",
	lifecycleState: "pending",
	failureRetryable: null,
	encryptedRecord: { ciphertext: "opaque" },
};

class RecoveryStore implements SecretActivationStorePortV1 {
	readonly claimFences: number[] = [];
	readonly transitions: string[] = [];
	current = structuredClone(recoveryCandidate);
	#fence = 0;

	async claimCandidate(
		input: { readonly workerId: string; readonly leaseDurationMs: number },
		decide: (
			state: SecretActivationClaimStateV1,
		) => SecretActivationClaimPlanV1,
	) {
		const decision = decide({
			schemaVersion: 1,
			currentConfigurationRevision: this.current.configRevision,
			candidate: structuredClone(this.current),
		});
		if (decision.outcome !== "claim") return decision;
		this.#fence += 1;
		this.claimFences.push(this.#fence);
		return {
			outcome: "claimed" as const,
			claim: {
				schemaVersion: 1 as const,
				workerId: input.workerId,
				fence: this.#fence,
				leaseExpiresAt: new Date(Date.now() + input.leaseDurationMs),
				candidate: structuredClone(this.current),
			},
		};
	}

	async recordAudit(input: {
		readonly claim: SecretActivationClaimV1;
		readonly auditEvent: SecretActivationAuditIntentV1;
	}) {
		return input.claim.fence === this.#fence;
	}

	async commitTransition(input: {
		readonly claim: SecretActivationClaimV1;
		readonly plan: SecretActivationTransitionPlanV1;
	}) {
		if (
			input.claim.fence !== this.#fence ||
			!input.plan.expectedLifecycleStates.includes(this.current.lifecycleState)
		) {
			return false;
		}
		const state = input.plan.next.lifecycleState;
		this.current = {
			...this.current,
			lifecycleState: state,
			failureRetryable:
				state === "failed" ? input.plan.next.error.retryable : null,
		};
		this.transitions.push(state);
		return true;
	}
}

secretActivationKubernetesConformanceV1("Worker Adapter", () => {
	const client = new FakeWorkerSecretKubernetesClient();
	return {
		port: createWorkerSecretActivationKubernetesPortV1(client),
		activeSecretName: () => client.activeSecretName(),
		setObservation: (mode) => client.setObservation(mode),
		failNextApply: () => client.failNextApply(),
	};
});

describe("Worker Secret Kubernetes Adapter", () => {
	it("recovers a crash after immutable Secret creation with a new Agent fence", async () => {
		const client = new FakeWorkerSecretKubernetesClient();
		client.failNextWorkloadAfterSecret();
		const store = new RecoveryStore();
		const seed = new Uint8Array([41, 43, 47]);
		const activation = createSecretActivationUseCaseV1({
			store,
			kubernetes: createWorkerSecretActivationKubernetesPortV1(client),
			decryptor: {
				async decrypt() {
					return { outcome: "decrypted", plaintext: new Uint8Array(seed) };
				},
			},
		});
		const command = {
			schemaVersion: 1 as const,
			agentId: recoveryCandidate.agentId,
			secretId: recoveryCandidate.secretId,
			secretVersion: recoveryCandidate.secretVersion,
			configRevision: recoveryCandidate.configRevision,
			workerId: "worker_01",
			traceId: "trace_01",
		};

		await expect(activation.activate(command)).resolves.toMatchObject({
			outcome: "failed",
		});
		expect(store.current).toMatchObject({
			lifecycleState: "failed",
			failureRetryable: true,
		});
		expect(client.activeSecretName()).toBe("agent-old.secret-old-v1-r6");
		await expect(activation.activate(command)).resolves.toMatchObject({
			outcome: "active",
		});
		expect(store.claimFences).toEqual([1, 2]);
		expect(store.transitions).toEqual([
			"failed",
			"applying",
			"observed",
			"active",
		]);
		expect(client.activeSecretName()).toBe("agent-old.secret-old-v1-r6");
	});

	it("rejects a stale or malformed Workload observation without leaking it", async () => {
		const client = new FakeWorkerSecretKubernetesClient();
		const port = createWorkerSecretActivationKubernetesPortV1({
			...client,
			applyImmutableSecret: (input) => client.applyImmutableSecret(input),
			applyCandidateWorkload: (input) => client.applyCandidateWorkload(input),
			async observeCandidateWorkload() {
				return { status: "observed", detail: "must not escape" };
			},
		});
		const reference: SecretActivationReferenceV1 = {
			schemaVersion: 1,
			ownerType: "agent-owner",
			ownerId: "owner_01",
			agentId: "agent_01",
			secretId: "credential_01",
			secretVersion: 2,
			configRevision: 7,
			algorithmVersion: "aes-256-gcm:v1",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			wrappingKeyVersion: "key_01",
			name: "agent-aaaaaaaaaaaaaaaa.secret-bbbbbbbbbbbbbbbb-v2-r7",
		};
		const applied = await port.applyCandidate({
			schemaVersion: 1,
			kubernetesSecretRef: reference,
			secretKey: "MODEL_API_KEY",
			fence: 1,
			plaintext: new Uint8Array([2, 3]),
		});
		if (applied.outcome !== "applied") throw new Error("Expected apply");
		const fence: SecretActivationFenceV1 = {
			schemaVersion: 1,
			agentId: reference.agentId,
			secretId: reference.secretId,
			secretVersion: reference.secretVersion,
			configRevision: reference.configRevision,
			kubernetesSecretName: reference.name,
			workloadUid: applied.workloadUid,
			workloadGeneration: applied.workloadGeneration,
			fence: 1,
		};
		const error = await port
			.observeCandidate({
				schemaVersion: 1,
				kubernetesSecretRef: reference,
				activationFence: fence,
			})
			.catch((failure: unknown) => failure);
		expect(error).toEqual(
			new TypeError("Secret activation observation is unavailable"),
		);
		expect(JSON.stringify(error)).not.toContain("must not escape");
	});
});
