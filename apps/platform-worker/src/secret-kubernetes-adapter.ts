import {
	KubernetesSecretReferenceV1Schema,
	SecretActivationFenceV1Schema,
	SecretActivationObservationV1Schema,
	validateSecretActivationObservationV1,
} from "@agent-infra/contracts/workload";
import type {
	SecretActivationApplyInputV1,
	SecretActivationFenceV1,
	SecretActivationKubernetesPortV1,
	SecretActivationObservationV1,
	SecretActivationReferenceV1,
} from "@agent-infra/platform-core";

export interface WorkerSecretKubernetesClientV1 {
	applyImmutableSecret(input: {
		readonly kubernetesSecretRef: SecretActivationReferenceV1;
		readonly secretKey: string;
		readonly plaintext: Uint8Array;
	}): Promise<"created" | "unchanged" | "conflict">;
	applyCandidateWorkload(input: {
		readonly kubernetesSecretRef: SecretActivationReferenceV1;
		readonly fence: number;
	}): Promise<{
		readonly workloadUid: string;
		readonly workloadGeneration: number;
	}>;
	observeCandidateWorkload(input: {
		readonly kubernetesSecretRef: SecretActivationReferenceV1;
		readonly activationFence: SecretActivationFenceV1;
	}): Promise<unknown | null>;
}

export function createWorkerSecretActivationKubernetesPortV1(
	client: WorkerSecretKubernetesClientV1,
): SecretActivationKubernetesPortV1 {
	return {
		async applyCandidate(input) {
			const validated = validateApplyInput(input);
			try {
				const secret = await client.applyImmutableSecret({
					kubernetesSecretRef: validated.kubernetesSecretRef,
					secretKey: validated.secretKey,
					plaintext: validated.plaintext,
				});
				if (secret === "conflict") return { outcome: "failed" };
				if (secret !== "created" && secret !== "unchanged") throw new Error();
				const workload = await client.applyCandidateWorkload({
					kubernetesSecretRef: validated.kubernetesSecretRef,
					fence: validated.fence,
				});
				if (
					typeof workload.workloadUid !== "string" ||
					workload.workloadUid.length === 0 ||
					!Number.isSafeInteger(workload.workloadGeneration) ||
					workload.workloadGeneration < 1
				) {
					throw new Error();
				}
				return { outcome: "applied", ...workload };
			} catch {
				return { outcome: "failed" };
			}
		},

		async observeCandidate(input) {
			const expectedReference = validatedReference(input.kubernetesSecretRef);
			const expectedFence = SecretActivationFenceV1Schema.parse(
				input.activationFence,
			) as SecretActivationFenceV1;
			if (!fenceMatchesReference(expectedFence, expectedReference)) {
				throw new TypeError("Secret activation input is invalid");
			}
			try {
				const raw = await client.observeCandidateWorkload({
					kubernetesSecretRef: expectedReference,
					activationFence: expectedFence,
				});
				if (raw === null) return { status: "pending" };
				const observation = validateSecretActivationObservationV1(
					expectedFence,
					SecretActivationObservationV1Schema.parse(raw),
				);
				if (
					observation.kubernetesSecretRef !== undefined &&
					!referencesMatch(
						expectedReference,
						observation.kubernetesSecretRef as SecretActivationReferenceV1,
					)
				) {
					throw new Error();
				}
				return observation as SecretActivationObservationV1;
			} catch {
				throw new TypeError("Secret activation observation is unavailable");
			}
		},
	};
}

function validateApplyInput(
	input: SecretActivationApplyInputV1,
): SecretActivationApplyInputV1 {
	const reference = validatedReference(input.kubernetesSecretRef);
	if (
		input.schemaVersion !== 1 ||
		typeof input.secretKey !== "string" ||
		input.secretKey.length === 0 ||
		input.secretKey.includes("\0") ||
		!(input.plaintext instanceof Uint8Array) ||
		!Number.isSafeInteger(input.fence) ||
		input.fence < 1
	) {
		throw new TypeError("Secret activation input is invalid");
	}
	return { ...input, kubernetesSecretRef: reference };
}

function validatedReference(
	input: SecretActivationReferenceV1,
): SecretActivationReferenceV1 {
	try {
		return KubernetesSecretReferenceV1Schema.parse(
			input,
		) as SecretActivationReferenceV1;
	} catch {
		throw new TypeError("Secret activation input is invalid");
	}
}

function referencesMatch(
	expected: SecretActivationReferenceV1,
	actual: SecretActivationReferenceV1,
): boolean {
	return (
		expected.ownerType === actual.ownerType &&
		expected.ownerId === actual.ownerId &&
		expected.agentId === actual.agentId &&
		expected.secretId === actual.secretId &&
		expected.secretVersion === actual.secretVersion &&
		expected.configRevision === actual.configRevision &&
		expected.algorithmVersion === actual.algorithmVersion &&
		expected.wrappingAlgorithmVersion === actual.wrappingAlgorithmVersion &&
		expected.wrappingKeyVersion === actual.wrappingKeyVersion &&
		expected.name === actual.name
	);
}

function fenceMatchesReference(
	fence: SecretActivationFenceV1,
	reference: SecretActivationReferenceV1,
): boolean {
	return (
		fence.agentId === reference.agentId &&
		fence.secretId === reference.secretId &&
		fence.secretVersion === reference.secretVersion &&
		fence.configRevision === reference.configRevision &&
		fence.kubernetesSecretName === reference.name
	);
}
