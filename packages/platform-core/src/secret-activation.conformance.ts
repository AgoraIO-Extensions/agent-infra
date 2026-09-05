import { describe, expect, it } from "vitest";

import type {
	SecretActivationFenceV1,
	SecretActivationKubernetesPortV1,
	SecretActivationReferenceV1,
} from "./secret-activation.js";

export interface SecretActivationKubernetesHarnessV1 {
	readonly port: SecretActivationKubernetesPortV1;
	activeSecretName(): string | null;
	setObservation(
		mode: "missing" | "malformed" | "mismatched" | "unavailable",
	): void;
	failNextApply(): void;
}

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

export function secretActivationKubernetesConformanceV1(
	name: string,
	create: () => SecretActivationKubernetesHarnessV1,
): void {
	describe(`${name} Secret activation Kubernetes conformance`, () => {
		it("observes the exact immutable Secret, healthy Workload and fence", async () => {
			const harness = create();
			const previous = harness.activeSecretName();
			const applied = await harness.port.applyCandidate({
				schemaVersion: 1,
				kubernetesSecretRef: reference,
				secretKey: "MODEL_API_KEY",
				fence: 3,
				plaintext: new Uint8Array([7, 11, 13]),
			});
			expect(applied.outcome).toBe("applied");
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
				fence: 3,
			};
			await expect(
				harness.port.observeCandidate({
					schemaVersion: 1,
					kubernetesSecretRef: reference,
					activationFence: fence,
				}),
			).resolves.toEqual({
				schemaVersion: 1,
				status: "observed",
				kubernetesSecretRef: reference,
				activationFence: fence,
				health: "healthy",
			});
			expect(harness.activeSecretName()).toBe(previous);
		});

		it("rejects an in-place value change without replacing the old active Secret", async () => {
			const harness = create();
			const previous = harness.activeSecretName();
			const input = {
				schemaVersion: 1 as const,
				kubernetesSecretRef: reference,
				secretKey: "MODEL_API_KEY",
				fence: 3,
			};
			await expect(
				harness.port.applyCandidate({
					...input,
					plaintext: new Uint8Array([17]),
				}),
			).resolves.toMatchObject({ outcome: "applied" });
			await expect(
				harness.port.applyCandidate({
					...input,
					plaintext: new Uint8Array([19]),
				}),
			).resolves.toEqual({ outcome: "failed" });
			expect(harness.activeSecretName()).toBe(previous);
		});

		it.each([
			["missing", "pending"],
			["malformed", "failure"],
			["mismatched", "failure"],
			["unavailable", "failure"],
		] as const)("fails closed for a %s observation", async (mode, expected) => {
			const harness = create();
			const previous = harness.activeSecretName();
			const applied = await harness.port.applyCandidate({
				schemaVersion: 1,
				kubernetesSecretRef: reference,
				secretKey: "MODEL_API_KEY",
				fence: 5,
				plaintext: new Uint8Array([31]),
			});
			if (applied.outcome !== "applied") throw new Error("Expected apply");
			const activationFence: SecretActivationFenceV1 = {
				schemaVersion: 1,
				agentId: reference.agentId,
				secretId: reference.secretId,
				secretVersion: reference.secretVersion,
				configRevision: reference.configRevision,
				kubernetesSecretName: reference.name,
				workloadUid: applied.workloadUid,
				workloadGeneration: applied.workloadGeneration,
				fence: 5,
			};
			harness.setObservation(mode);
			const observation = harness.port.observeCandidate({
				schemaVersion: 1,
				kubernetesSecretRef: reference,
				activationFence,
			});
			if (expected === "pending") {
				await expect(observation).resolves.toEqual({ status: "pending" });
			} else {
				await expect(observation).rejects.toEqual(
					new TypeError("Secret activation observation is unavailable"),
				);
			}
			expect(harness.activeSecretName()).toBe(previous);
		});

		it("maps an unavailable immutable apply to a bounded failure", async () => {
			const harness = create();
			harness.failNextApply();
			await expect(
				harness.port.applyCandidate({
					schemaVersion: 1,
					kubernetesSecretRef: reference,
					secretKey: "MODEL_API_KEY",
					fence: 7,
					plaintext: new Uint8Array([37]),
				}),
			).resolves.toEqual({ outcome: "failed" });
			expect(harness.activeSecretName()).toBe("agent-old.secret-old-v1-r6");
		});
	});
}
