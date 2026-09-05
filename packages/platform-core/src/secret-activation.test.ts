import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	createSecretActivationUseCaseV1,
	type SecretActivationCandidateV1,
	type SecretActivationClaimV1,
	SecretActivationError,
	type SecretActivationFenceV1,
	type SecretActivationStorePortV1,
} from "./secret-activation.js";

const candidate: SecretActivationCandidateV1 = {
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
	encryptedRecord: Object.freeze({ ciphertext: "opaque" }),
};

class FakeActivationStore implements SecretActivationStorePortV1 {
	readonly transitions: string[] = [];
	private claim?: SecretActivationClaimV1;
	private nextFence = 0;

	async claimCandidate(input: {
		readonly workerId: string;
		readonly leaseDurationMs: number;
	}): Promise<
		| { readonly outcome: "claimed"; readonly claim: SecretActivationClaimV1 }
		| { readonly outcome: "busy" | "stale" | "active" | "failed" }
	> {
		this.nextFence += 1;
		this.claim = {
			schemaVersion: 1,
			workerId: input.workerId,
			fence: this.nextFence,
			leaseExpiresAt: new Date(Date.now() + input.leaseDurationMs),
			candidate,
		};
		return { outcome: "claimed", claim: this.claim };
	}

	async markApplying(input: {
		readonly claim: SecretActivationClaimV1;
		readonly kubernetesSecretName: string;
		readonly activationFence: SecretActivationFenceV1;
	}): Promise<boolean> {
		this.transitions.push("applying");
		return input.claim === this.claim;
	}

	async markObserved(): Promise<boolean> {
		this.transitions.push("observed");
		return true;
	}

	async markActive(): Promise<boolean> {
		this.transitions.push("active");
		return true;
	}

	async markFailed(): Promise<boolean> {
		this.transitions.push("failed");
		return true;
	}
}

class StaleFailureStore extends FakeActivationStore {
	override async markFailed(): Promise<boolean> {
		return false;
	}
}

describe("Secret candidate activation", () => {
	it("activates only after an exact immutable Secret and Workload observation", async () => {
		const store = new FakeActivationStore();
		const applied: { name?: string; digest?: string } = {};
		let plaintext: Uint8Array | undefined;
		const useCase = createSecretActivationUseCaseV1(
			{
				store,
				decryptor: {
					async decrypt() {
						plaintext = new Uint8Array([11, 29, 47, 83]);
						return { outcome: "decrypted", plaintext };
					},
				},
				kubernetes: {
					async applyCandidate(input) {
						applied.name = input.kubernetesSecretName;
						applied.digest = createHash("sha256")
							.update(input.plaintext)
							.digest("hex");
						return {
							outcome: "applied",
							workloadUid: "workload_uid_01",
							workloadGeneration: 4,
						};
					},
					async observeCandidate(input) {
						return { outcome: "observed", ...input.activationFence };
					},
				},
			},
			{ leaseMs: 60_000 },
		);

		await expect(
			useCase.activate({
				schemaVersion: 1,
				agentId: candidate.agentId,
				secretId: candidate.secretId,
				secretVersion: candidate.secretVersion,
				configRevision: candidate.configRevision,
				workerId: "worker_01",
				traceId: "trace_01",
			}),
		).resolves.toEqual({
			schemaVersion: 1,
			outcome: "active",
			agentId: candidate.agentId,
			secretId: candidate.secretId,
			secretVersion: candidate.secretVersion,
			configRevision: candidate.configRevision,
		});
		expect(applied.name).toMatch(/-v2-r7$/);
		expect(applied.digest).toBe(
			createHash("sha256")
				.update(new Uint8Array([11, 29, 47, 83]))
				.digest("hex"),
		);
		expect(plaintext).toEqual(new Uint8Array(4));
		expect(store.transitions).toEqual(["applying", "observed", "active"]);
	});

	it("rejects malformed commands before any Worker boundary is called", async () => {
		const useCase = createSecretActivationUseCaseV1({
			store: {
				async claimCandidate() {
					throw new Error("store must not be called");
				},
				async markApplying() {
					return false;
				},
				async markObserved() {
					return false;
				},
				async markActive() {
					return false;
				},
				async markFailed() {
					return false;
				},
			},
			decryptor: {
				async decrypt() {
					throw new Error("decryptor must not be called");
				},
			},
			kubernetes: {
				async applyCandidate() {
					throw new Error("Kubernetes must not be called");
				},
				async observeCandidate() {
					throw new Error("Kubernetes must not be called");
				},
			},
		});

		await expect(
			useCase.activate({
				schemaVersion: 1,
				agentId: "agent_01",
				secretId: "credential_01",
				secretVersion: 0,
				configRevision: 7,
				workerId: "worker_01",
				traceId: "trace_01",
			}),
		).rejects.toEqual(new SecretActivationError("invalid_input"));
	});

	it("rejects a cross-Agent claim before decrypting ciphertext", async () => {
		let decryptCalled = false;
		const useCase = createSecretActivationUseCaseV1({
			store: {
				async claimCandidate() {
					return {
						outcome: "claimed" as const,
						claim: {
							schemaVersion: 1 as const,
							workerId: "worker_01",
							fence: 1,
							leaseExpiresAt: new Date("2026-09-05T08:01:00.000Z"),
							candidate: { ...candidate, agentId: "agent_02" },
						},
					};
				},
				async markApplying() {
					return false;
				},
				async markObserved() {
					return false;
				},
				async markActive() {
					return false;
				},
				async markFailed() {
					return false;
				},
			},
			decryptor: {
				async decrypt() {
					decryptCalled = true;
					return { outcome: "decrypted", plaintext: new Uint8Array([1]) };
				},
			},
			kubernetes: {
				async applyCandidate() {
					return {
						outcome: "applied",
						workloadUid: "workload_uid_01",
						workloadGeneration: 1,
					} as const;
				},
				async observeCandidate() {
					return { outcome: "pending" } as const;
				},
			},
		});

		await expect(
			useCase.activate({
				schemaVersion: 1,
				agentId: candidate.agentId,
				secretId: candidate.secretId,
				secretVersion: candidate.secretVersion,
				configRevision: candidate.configRevision,
				workerId: "worker_01",
				traceId: "trace_01",
			}),
		).rejects.toEqual(new SecretActivationError("unavailable"));
		expect(decryptCalled).toBe(false);
	});

	it("redacts Kubernetes failures and zeroes transient plaintext", async () => {
		const store = new FakeActivationStore();
		const plaintext = new Uint8Array([17, 31, 61]);
		const useCase = createSecretActivationUseCaseV1({
			store,
			decryptor: {
				async decrypt() {
					return { outcome: "decrypted", plaintext };
				},
			},
			kubernetes: {
				async applyCandidate() {
					throw new Error("boundary detail must not escape");
				},
				async observeCandidate() {
					return { outcome: "pending" };
				},
			},
		});

		await expect(
			useCase.activate({
				schemaVersion: 1,
				agentId: candidate.agentId,
				secretId: candidate.secretId,
				secretVersion: candidate.secretVersion,
				configRevision: candidate.configRevision,
				workerId: "worker_01",
				traceId: "trace_01",
			}),
		).rejects.toEqual(new SecretActivationError("unavailable"));
		expect(plaintext).toEqual(new Uint8Array(3));
	});

	it("retries a crash window with a new fence and the same immutable name", async () => {
		const store = new FakeActivationStore();
		const applications: { readonly name: string; readonly fence: number }[] =
			[];
		let observationAttempts = 0;
		const useCase = createSecretActivationUseCaseV1({
			store,
			decryptor: {
				async decrypt() {
					return {
						outcome: "decrypted",
						plaintext: new Uint8Array([3, 5, 7]),
					};
				},
			},
			kubernetes: {
				async applyCandidate(input) {
					applications.push({
						name: input.kubernetesSecretName,
						fence: input.fence,
					});
					return {
						outcome: "applied",
						workloadUid: "workload_uid_01",
						workloadGeneration: observationAttempts + 4,
					};
				},
				async observeCandidate(input) {
					observationAttempts += 1;
					if (observationAttempts === 1) throw new Error("simulated crash");
					return { outcome: "observed", ...input.activationFence };
				},
			},
		});
		const command = {
			schemaVersion: 1 as const,
			agentId: candidate.agentId,
			secretId: candidate.secretId,
			secretVersion: candidate.secretVersion,
			configRevision: candidate.configRevision,
			workerId: "worker_01",
			traceId: "trace_01",
		};

		await expect(useCase.activate(command)).rejects.toEqual(
			new SecretActivationError("unavailable"),
		);
		await expect(useCase.activate(command)).resolves.toMatchObject({
			outcome: "active",
		});
		expect(applications).toHaveLength(2);
		expect(applications[0]?.name).toBe(applications[1]?.name);
		expect(applications.map(({ fence }) => fence)).toEqual([1, 2]);
		expect(store.transitions).toEqual([
			"applying",
			"applying",
			"observed",
			"active",
		]);
	});

	it.each([
		["Agent", { agentId: "agent_02" }],
		["Secret", { secretId: "credential_02" }],
		["Secret version", { secretVersion: 1 }],
		["configuration", { configRevision: 6 }],
		["Secret name", { kubernetesSecretName: "other-v2-r7" }],
		["Workload UID", { workloadUid: "workload_uid_02" }],
		["Workload generation", { workloadGeneration: 3 }],
		["fence", { fence: 2 }],
	] as const)("rejects a stale %s observation", async (_name, mismatch) => {
		const store = new FakeActivationStore();
		const useCase = createSecretActivationUseCaseV1({
			store,
			decryptor: {
				async decrypt() {
					return { outcome: "decrypted", plaintext: new Uint8Array([2]) };
				},
			},
			kubernetes: {
				async applyCandidate() {
					return {
						outcome: "applied",
						workloadUid: "workload_uid_01",
						workloadGeneration: 4,
					};
				},
				async observeCandidate(input) {
					return {
						outcome: "observed",
						...input.activationFence,
						...mismatch,
					};
				},
			},
		});

		await expect(
			useCase.activate({
				schemaVersion: 1,
				agentId: candidate.agentId,
				secretId: candidate.secretId,
				secretVersion: candidate.secretVersion,
				configRevision: candidate.configRevision,
				workerId: "worker_01",
				traceId: "trace_01",
			}),
		).resolves.toEqual({ schemaVersion: 1, outcome: "stale" });
		expect(store.transitions).toEqual(["applying"]);
	});

	it("does not report failed when the fenced failure write is stale", async () => {
		const useCase = createSecretActivationUseCaseV1({
			store: new StaleFailureStore(),
			decryptor: {
				async decrypt() {
					return {
						outcome: "failed",
						code: "SECRET_KEY_UNAVAILABLE",
					};
				},
			},
			kubernetes: {
				async applyCandidate() {
					return { outcome: "failed" };
				},
				async observeCandidate() {
					return { outcome: "pending" };
				},
			},
		});

		await expect(
			useCase.activate({
				schemaVersion: 1,
				agentId: candidate.agentId,
				secretId: candidate.secretId,
				secretVersion: candidate.secretVersion,
				configRevision: candidate.configRevision,
				workerId: "worker_01",
				traceId: "trace_01",
			}),
		).resolves.toEqual({ schemaVersion: 1, outcome: "stale" });
	});
});
