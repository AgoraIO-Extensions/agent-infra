import { describe, expect, it } from "vitest";

import { FakeSecretActivationKubernetesV1 } from "./fake-secret-activation.js";
import { FakeSecretActivationDecryptorV1 } from "./fake-secret-decryptor.js";
import { secretActivationKubernetesConformanceV1 } from "./secret-activation.conformance.js";
import {
	createSecretActivationUseCaseV1,
	type SecretActivationAuditIntentV1,
	type SecretActivationCandidateV1,
	type SecretActivationClaimPlanV1,
	type SecretActivationClaimStateV1,
	type SecretActivationClaimV1,
	SecretActivationError,
	type SecretActivationFenceV1,
	type SecretActivationKubernetesPortV1,
	type SecretActivationStorePortV1,
	type SecretActivationTransitionPlanV1,
} from "./secret-activation.js";
import { secretActivationDecryptorConformanceV1 } from "./secret-decryptor.conformance.js";

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
	failureRetryable: null,
	encryptedRecord: Object.freeze({ ciphertext: "opaque" }),
};

type CrashStage =
	| "before_applying"
	| "after_applying"
	| "before_observed"
	| "after_observed"
	| "after_active";

class FakeActivationStore implements SecretActivationStorePortV1 {
	readonly transitions: string[] = [];
	readonly audits: SecretActivationAuditIntentV1[] = [];
	currentConfigurationRevision = candidate.configRevision;
	currentFence?: SecretActivationFenceV1;
	currentCandidate: SecretActivationCandidateV1;
	#claimFence = 0;
	#crashStage?: CrashStage;
	#crashed = false;
	#staleWrites = false;

	constructor(
		options: {
			readonly candidate?: SecretActivationCandidateV1;
			readonly crashStage?: CrashStage;
			readonly staleWrites?: boolean;
		} = {},
	) {
		this.currentCandidate = structuredClone(options.candidate ?? candidate);
		this.#crashStage = options.crashStage;
		this.#staleWrites = options.staleWrites ?? false;
	}

	async claimCandidate(
		input: { readonly workerId: string; readonly leaseDurationMs: number },
		decide: (
			state: SecretActivationClaimStateV1,
		) => SecretActivationClaimPlanV1,
	) {
		const plan = decide({
			schemaVersion: 1,
			currentConfigurationRevision: this.currentConfigurationRevision,
			candidate: structuredClone(this.currentCandidate),
		});
		if (plan.outcome !== "claim") return plan;
		this.#claimFence += 1;
		return {
			outcome: "claimed" as const,
			claim: {
				schemaVersion: 1 as const,
				workerId: input.workerId,
				fence: this.#claimFence,
				leaseExpiresAt: new Date(Date.now() + input.leaseDurationMs),
				candidate: structuredClone(this.currentCandidate),
			},
		};
	}

	async recordAudit(input: {
		readonly claim: SecretActivationClaimV1;
		readonly auditEvent: SecretActivationAuditIntentV1;
	}): Promise<boolean> {
		if (this.#staleWrites || input.claim.fence !== this.#claimFence)
			return false;
		this.audits.push(structuredClone(input.auditEvent));
		return true;
	}

	async commitTransition(input: {
		readonly claim: SecretActivationClaimV1;
		readonly plan: SecretActivationTransitionPlanV1;
	}): Promise<boolean> {
		if (
			this.#staleWrites ||
			input.claim.fence !== this.#claimFence ||
			!input.plan.expectedLifecycleStates.includes(
				this.currentCandidate.lifecycleState,
			)
		) {
			return false;
		}
		const nextState = input.plan.next.lifecycleState;
		if (
			!this.#crashed &&
			((this.#crashStage === "before_applying" && nextState === "applying") ||
				(this.#crashStage === "before_observed" && nextState === "observed"))
		) {
			this.#crashed = true;
			throw new Error("simulated crash");
		}
		this.currentCandidate = {
			...this.currentCandidate,
			lifecycleState: nextState,
			failureRetryable:
				nextState === "failed" ? input.plan.next.error.retryable : null,
		};
		this.currentFence =
			"activationFence" in input.plan.next
				? input.plan.next.activationFence
				: undefined;
		this.transitions.push(nextState);
		this.audits.push(
			...input.plan.auditEvents.map((event) => structuredClone(event)),
		);
		if (
			!this.#crashed &&
			((this.#crashStage === "after_applying" && nextState === "applying") ||
				(this.#crashStage === "after_observed" && nextState === "observed") ||
				(this.#crashStage === "after_active" && nextState === "active"))
		) {
			this.#crashed = true;
			throw new Error("simulated crash");
		}
		return true;
	}
}

function command() {
	return {
		schemaVersion: 1 as const,
		agentId: candidate.agentId,
		secretId: candidate.secretId,
		secretVersion: candidate.secretVersion,
		configRevision: candidate.configRevision,
		workerId: "worker_01",
		traceId: "trace_01",
	};
}

function useCase(options: {
	readonly store?: FakeActivationStore;
	readonly kubernetes?: SecretActivationKubernetesPortV1;
	readonly plaintext?: Uint8Array;
}) {
	const store = options.store ?? new FakeActivationStore();
	const kubernetes =
		options.kubernetes ??
		new FakeSecretActivationKubernetesV1({
			activeSecretName: "agent-old.secret-old-v1-r6",
		});
	const plaintext = options.plaintext ?? new Uint8Array([11, 29, 47, 83]);
	const plaintextSource = new Uint8Array(plaintext);
	let decryptions = 0;
	return {
		store,
		kubernetes,
		plaintext,
		activation: createSecretActivationUseCaseV1({
			store,
			kubernetes,
			decryptor: {
				async decrypt() {
					const value =
						decryptions === 0 ? plaintext : new Uint8Array(plaintextSource);
					decryptions += 1;
					return { outcome: "decrypted", plaintext: value };
				},
			},
		}),
	};
}

secretActivationKubernetesConformanceV1("Fake", () => {
	const port = new FakeSecretActivationKubernetesV1({
		activeSecretName: "agent-old.secret-old-v1-r6",
	});
	return {
		port,
		activeSecretName: () => port.activeSecretName(),
		setObservation: (mode) =>
			port.setNextObservation(mode === "missing" ? "pending" : mode),
		failNextApply: () => port.setNextApplyFailure(),
	};
});

secretActivationDecryptorConformanceV1("Fake", () => ({
	valid: {
		port: new FakeSecretActivationDecryptorV1({
			outcome: "decrypted",
			plaintext: new Uint8Array([23, 29, 31]),
		}),
		encryptedRecord: { kind: "valid" },
		expectedDigest:
			"be290f087d99b032b8a017f86db6ac0719b10974cfa2ae1398cd6a2eaaf81430",
	},
	unavailableKey: {
		port: new FakeSecretActivationDecryptorV1({
			outcome: "failed",
			code: "SECRET_KEY_UNAVAILABLE",
		}),
		encryptedRecord: { kind: "boundary-sensitive" },
	},
	malformed: {
		port: new FakeSecretActivationDecryptorV1({
			outcome: "failed",
			code: "SECRET_METADATA_INVALID",
		}),
		encryptedRecord: { kind: "boundary-sensitive" },
	},
	tampered: {
		port: new FakeSecretActivationDecryptorV1({
			outcome: "failed",
			code: "SECRET_AUTHENTICATION_FAILED",
		}),
		encryptedRecord: { kind: "boundary-sensitive" },
	},
}));

describe("Secret candidate activation", () => {
	it("activates only after a healthy exact observation and records redacted audits", async () => {
		const scenario = useCase({});
		await expect(
			scenario.activation.activate(command()),
		).resolves.toMatchObject({
			outcome: "active",
		});
		expect(scenario.plaintext).toEqual(new Uint8Array(4));
		expect(scenario.store.transitions).toEqual([
			"applying",
			"observed",
			"active",
		]);
		expect(
			scenario.store.audits.map(({ action, outcome, details }) => ({
				action,
				outcome,
				details,
			})),
		).toEqual([
			{
				action: "secret.decrypt",
				outcome: "succeeded",
				details: {
					wrappingKeyVersion: "key_01",
					operation: "decrypt",
					result: "succeeded",
				},
			},
			{
				action: "secret.activate",
				outcome: "succeeded",
				details: {
					wrappingKeyVersion: "key_01",
					operation: "activate",
					result: "succeeded",
				},
			},
		]);
		expect(
			(
				scenario.kubernetes as FakeSecretActivationKubernetesV1
			).activeSecretName(),
		).toBe("agent-old.secret-old-v1-r6");
	});

	it("rejects malformed commands before calling Worker boundaries", async () => {
		const scenario = useCase({});
		await expect(
			scenario.activation.activate({ ...command(), secretVersion: 0 }),
		).rejects.toEqual(new SecretActivationError("invalid_input"));
		expect(scenario.store.transitions).toEqual([]);
	});

	it("rejects a cross-Agent claim before decryption", async () => {
		const store = new FakeActivationStore({
			candidate: { ...candidate, agentId: "agent_02" },
		});
		let decryptCalled = false;
		const activation = createSecretActivationUseCaseV1({
			store,
			kubernetes: new FakeSecretActivationKubernetesV1(),
			decryptor: {
				async decrypt() {
					decryptCalled = true;
					return { outcome: "decrypted", plaintext: new Uint8Array([1]) };
				},
			},
		});
		await expect(activation.activate(command())).rejects.toEqual(
			new SecretActivationError("unavailable"),
		);
		expect(decryptCalled).toBe(false);
	});

	it("redacts Kubernetes errors and zeroes transient plaintext", async () => {
		const plaintext = new Uint8Array([17, 31, 61]);
		const base = new FakeSecretActivationKubernetesV1();
		let attempts = 0;
		const kubernetes: SecretActivationKubernetesPortV1 = {
			applyCandidate: async (input) => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("boundary detail must not escape");
				}
				return base.applyCandidate(input);
			},
			observeCandidate: (input) => base.observeCandidate(input),
		};
		const scenario = useCase({ kubernetes, plaintext });
		await expect(scenario.activation.activate(command())).rejects.toEqual(
			new SecretActivationError("unavailable"),
		);
		expect(plaintext).toEqual(new Uint8Array(3));
		await expect(
			scenario.activation.activate(command()),
		).resolves.toMatchObject({
			outcome: "active",
		});
	});

	it.each([
		"before_applying",
		"after_applying",
		"before_observed",
		"after_observed",
		"after_active",
	] as const)("recovers the %s crash window", async (crashStage) => {
		const store = new FakeActivationStore({ crashStage });
		const scenario = useCase({ store });
		await expect(scenario.activation.activate(command())).rejects.toEqual(
			new SecretActivationError("unavailable"),
		);
		await expect(
			scenario.activation.activate(command()),
		).resolves.toMatchObject({
			outcome: "active",
		});
		expect(store.currentCandidate.lifecycleState).toBe("active");
		expect(
			store.audits.some(({ action }) => action === "secret.activate"),
		).toBe(true);
		expect(
			(
				scenario.kubernetes as FakeSecretActivationKubernetesV1
			).activeSecretName(),
		).toBe("agent-old.secret-old-v1-r6");
	});

	it("recovers persisted applying state after a pending observation", async () => {
		const kubernetes = new FakeSecretActivationKubernetesV1();
		kubernetes.setNextObservation("pending");
		const scenario = useCase({ kubernetes });
		await expect(
			scenario.activation.activate(command()),
		).resolves.toMatchObject({
			outcome: "applying",
		});
		expect(scenario.store.currentCandidate.lifecycleState).toBe("applying");
		await expect(
			scenario.activation.activate(command()),
		).resolves.toMatchObject({
			outcome: "active",
		});
	});

	it("persists a failed observation without changing the old active Secret", async () => {
		const kubernetes = new FakeSecretActivationKubernetesV1({
			activeSecretName: "agent-old.secret-old-v1-r6",
		});
		kubernetes.setNextObservation("failed");
		const scenario = useCase({ kubernetes });
		await expect(
			scenario.activation.activate(command()),
		).resolves.toMatchObject({
			outcome: "failed",
		});
		expect(scenario.store.currentCandidate).toMatchObject({
			lifecycleState: "failed",
			failureRetryable: true,
		});
		expect(kubernetes.activeSecretName()).toBe("agent-old.secret-old-v1-r6");
		expect(scenario.store.audits.at(-1)).toMatchObject({
			action: "secret.activate",
			outcome: "failed",
		});
	});

	it.each([
		["Agent", { activationFence: { agentId: "agent_02" } }],
		["Secret", { activationFence: { secretId: "credential_02" } }],
		["Secret version", { activationFence: { secretVersion: 1 } }],
		["configuration", { activationFence: { configRevision: 6 } }],
		["Secret name", { reference: { name: "other-v2-r7" } }],
		["Workload UID", { activationFence: { workloadUid: "workload_02" } }],
		["Workload generation", { activationFence: { workloadGeneration: 2 } }],
		["fence", { activationFence: { fence: 99 } }],
	] as const)("rejects a stale %s observation", async (_name, mismatch) => {
		const base = new FakeSecretActivationKubernetesV1();
		const kubernetes: SecretActivationKubernetesPortV1 = {
			applyCandidate: (input) => base.applyCandidate(input),
			async observeCandidate(input) {
				const observation = await base.observeCandidate(input);
				if (observation.status !== "observed") return observation;
				return {
					...observation,
					kubernetesSecretRef: {
						...observation.kubernetesSecretRef,
						...("reference" in mismatch ? mismatch.reference : {}),
					},
					activationFence: {
						...observation.activationFence,
						...("activationFence" in mismatch ? mismatch.activationFence : {}),
					},
				};
			},
		};
		const scenario = useCase({ kubernetes });
		await expect(scenario.activation.activate(command())).resolves.toEqual({
			schemaVersion: 1,
			outcome: "stale",
		});
		expect(scenario.store.transitions).toEqual(["applying"]);
	});

	it("rejects an observation without a healthy immutable Secret reference", async () => {
		const base = new FakeSecretActivationKubernetesV1();
		const kubernetes: SecretActivationKubernetesPortV1 = {
			applyCandidate: (input) => base.applyCandidate(input),
			async observeCandidate(input) {
				const observation = await base.observeCandidate(input);
				if (observation.status !== "observed") return observation;
				return {
					status: "observed",
					activationFence: observation.activationFence,
				} as never;
			},
		};
		const scenario = useCase({ kubernetes });
		await expect(scenario.activation.activate(command())).resolves.toEqual({
			schemaVersion: 1,
			outcome: "stale",
		});
	});

	it("does not report failure when its fenced transition is stale", async () => {
		const store = new FakeActivationStore({ staleWrites: true });
		const activation = createSecretActivationUseCaseV1({
			store,
			kubernetes: new FakeSecretActivationKubernetesV1(),
			decryptor: {
				async decrypt() {
					return {
						outcome: "failed",
						code: "SECRET_KEY_UNAVAILABLE",
					};
				},
			},
		});
		await expect(activation.activate(command())).resolves.toEqual({
			schemaVersion: 1,
			outcome: "stale",
		});
	});
});
