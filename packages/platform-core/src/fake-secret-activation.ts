import { createHash } from "node:crypto";

import type {
	SecretActivationApplyInputV1,
	SecretActivationFenceV1,
	SecretActivationKubernetesPortV1,
	SecretActivationObservationV1,
	SecretActivationReferenceV1,
} from "./secret-activation.js";

interface AppliedCandidate {
	readonly digest: string;
	readonly secretKey: string;
	readonly reference: SecretActivationReferenceV1;
	readonly activationFence: SecretActivationFenceV1;
}

export class FakeSecretActivationKubernetesV1
	implements SecretActivationKubernetesPortV1
{
	readonly #candidates = new Map<string, AppliedCandidate>();
	readonly #activeSecretName: string | null;
	#nextObservation:
		| "observed"
		| "pending"
		| "failed"
		| "malformed"
		| "mismatched"
		| "unavailable" = "observed";
	#failNextApply = false;
	#generation = 0;

	constructor(options: { readonly activeSecretName?: string } = {}) {
		this.#activeSecretName = options.activeSecretName ?? null;
	}

	activeSecretName(): string | null {
		return this.#activeSecretName;
	}

	setNextObservation(
		status:
			| "observed"
			| "pending"
			| "failed"
			| "malformed"
			| "mismatched"
			| "unavailable",
	): void {
		this.#nextObservation = status;
	}

	setNextApplyFailure(): void {
		this.#failNextApply = true;
	}

	async applyCandidate(input: SecretActivationApplyInputV1) {
		if (this.#failNextApply) {
			this.#failNextApply = false;
			return { outcome: "failed" as const };
		}
		const digest = createHash("sha256").update(input.plaintext).digest("hex");
		const existing = this.#candidates.get(input.kubernetesSecretRef.name);
		if (
			existing &&
			(existing.digest !== digest || existing.secretKey !== input.secretKey)
		) {
			return { outcome: "failed" as const };
		}
		this.#generation += 1;
		const activationFence = {
			schemaVersion: 1 as const,
			agentId: input.kubernetesSecretRef.agentId,
			secretId: input.kubernetesSecretRef.secretId,
			secretVersion: input.kubernetesSecretRef.secretVersion,
			configRevision: input.kubernetesSecretRef.configRevision,
			kubernetesSecretName: input.kubernetesSecretRef.name,
			workloadUid: `workload-${createHash("sha256")
				.update(input.kubernetesSecretRef.agentId)
				.digest("hex")
				.slice(0, 16)}`,
			workloadGeneration: this.#generation,
			fence: input.fence,
		};
		this.#candidates.set(input.kubernetesSecretRef.name, {
			digest,
			secretKey: input.secretKey,
			reference: structuredClone(input.kubernetesSecretRef),
			activationFence,
		});
		return {
			outcome: "applied" as const,
			workloadUid: activationFence.workloadUid,
			workloadGeneration: activationFence.workloadGeneration,
		};
	}

	async observeCandidate(input: {
		readonly schemaVersion: 1;
		readonly kubernetesSecretRef: SecretActivationReferenceV1;
		readonly activationFence: SecretActivationFenceV1;
	}): Promise<SecretActivationObservationV1> {
		const candidate = this.#candidates.get(input.kubernetesSecretRef.name);
		if (!candidate) return { status: "pending" };
		const status = this.#nextObservation;
		this.#nextObservation = "observed";
		if (status === "pending") return { status };
		if (
			status === "malformed" ||
			status === "mismatched" ||
			status === "unavailable"
		) {
			throw new TypeError("Secret activation observation is unavailable");
		}
		if (status === "failed") {
			return {
				schemaVersion: 1,
				status,
				kubernetesSecretRef: structuredClone(candidate.reference),
				activationFence: structuredClone(candidate.activationFence),
				health: "unhealthy",
				error: {
					schemaVersion: 1,
					code: "SECRET_ACTIVATION_FAILED",
					message: "Secret activation failed",
					retryable: true,
					traceId: "fake-trace",
				},
			};
		}
		return {
			schemaVersion: 1,
			status,
			kubernetesSecretRef: structuredClone(candidate.reference),
			activationFence: structuredClone(candidate.activationFence),
			health: "healthy",
		};
	}
}
