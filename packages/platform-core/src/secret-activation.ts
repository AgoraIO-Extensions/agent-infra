import { createHash } from "node:crypto";
import { types } from "node:util";

export type SecretActivationLifecycleStateV1 =
	| "pending"
	| "applying"
	| "observed"
	| "active"
	| "failed";

export interface SecretActivationCandidateV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly secretId: string;
	readonly secretVersion: number;
	readonly configRevision: number;
	readonly ownerType: "agent-owner" | "platform";
	readonly ownerId: string;
	readonly name: string;
	readonly wrappingKeyVersion: string;
	readonly lifecycleState: SecretActivationLifecycleStateV1;
	readonly failureRetryable: boolean | null;
	readonly encryptedRecord: unknown;
}

export interface SecretActivationClaimStateV1 {
	readonly schemaVersion: 1;
	readonly currentConfigurationRevision: number;
	readonly candidate: SecretActivationCandidateV1;
}

export type SecretActivationClaimPlanV1 =
	| { readonly outcome: "claim" }
	| { readonly outcome: "stale" | "active" | "failed" };

export interface SecretActivationClaimV1 {
	readonly schemaVersion: 1;
	readonly workerId: string;
	readonly fence: number;
	readonly leaseExpiresAt: Date;
	readonly candidate: SecretActivationCandidateV1;
}

export interface SecretActivationReferenceV1 {
	readonly schemaVersion: 1;
	readonly ownerType: "agent-owner" | "platform";
	readonly ownerId: string;
	readonly agentId: string;
	readonly secretId: string;
	readonly secretVersion: number;
	readonly configRevision: number;
	readonly algorithmVersion: "aes-256-gcm:v1";
	readonly wrappingAlgorithmVersion: "rsa-oaep-sha256:v1";
	readonly wrappingKeyVersion: string;
	readonly name: string;
}

export interface SecretActivationFenceV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly secretId: string;
	readonly secretVersion: number;
	readonly configRevision: number;
	readonly kubernetesSecretName: string;
	readonly workloadUid: string;
	readonly workloadGeneration: number;
	readonly fence: number;
}

export type SecretActivationFailureCodeV1 =
	| "SECRET_KEY_UNAVAILABLE"
	| "SECRET_METADATA_INVALID"
	| "SECRET_AUTHENTICATION_FAILED"
	| "SECRET_ACTIVATION_FAILED";

export interface SecretActivationFailureV1 {
	readonly schemaVersion: 1;
	readonly code: SecretActivationFailureCodeV1;
	readonly message:
		| "Secret key is unavailable"
		| "Secret metadata is invalid"
		| "Secret authentication failed"
		| "Secret activation failed";
	readonly retryable: boolean;
	readonly traceId: string;
}

export interface SecretActivationAuditIntentV1 {
	readonly schemaVersion: 1;
	readonly auditId: string;
	readonly traceId: string;
	readonly actorType: "system";
	readonly actorId: string;
	readonly action: "secret.decrypt" | "secret.activate";
	readonly targetType: "secret";
	readonly targetId: string;
	readonly agentId: string;
	readonly outcome: "succeeded" | "rejected" | "failed";
	readonly details: {
		readonly wrappingKeyVersion: string;
		readonly operation: "decrypt" | "activate";
		readonly result: "succeeded" | "rejected" | "failed";
	};
}

export type SecretActivationNextStateV1 =
	| {
			readonly lifecycleState: "applying" | "observed" | "active";
			readonly kubernetesSecretRef: SecretActivationReferenceV1;
			readonly activationFence: SecretActivationFenceV1;
	  }
	| {
			readonly lifecycleState: "failed";
			readonly kubernetesSecretRef?: SecretActivationReferenceV1;
			readonly activationFence?: SecretActivationFenceV1;
			readonly error: SecretActivationFailureV1;
	  };

export interface SecretActivationTransitionPlanV1 {
	readonly schemaVersion: 1;
	readonly expectedLifecycleStates: readonly SecretActivationLifecycleStateV1[];
	readonly expectedActivationFence?: SecretActivationFenceV1;
	readonly next: SecretActivationNextStateV1;
	readonly auditEvents: readonly SecretActivationAuditIntentV1[];
}

export interface SecretActivationStorePortV1 {
	claimCandidate(
		input: {
			readonly schemaVersion: 1;
			readonly agentId: string;
			readonly secretId: string;
			readonly secretVersion: number;
			readonly configRevision: number;
			readonly workerId: string;
			readonly leaseDurationMs: number;
		},
		decide: (
			state: SecretActivationClaimStateV1,
		) => SecretActivationClaimPlanV1,
	): Promise<
		| { readonly outcome: "claimed"; readonly claim: SecretActivationClaimV1 }
		| { readonly outcome: "busy" | "stale" | "active" | "failed" }
	>;
	recordAudit(input: {
		readonly claim: SecretActivationClaimV1;
		readonly auditEvent: SecretActivationAuditIntentV1;
	}): Promise<boolean>;
	commitTransition(input: {
		readonly claim: SecretActivationClaimV1;
		readonly plan: SecretActivationTransitionPlanV1;
	}): Promise<boolean>;
}

export interface SecretActivationDecryptorPortV1 {
	decrypt(input: {
		readonly encryptedRecord: unknown;
		readonly traceId: string;
	}): Promise<
		| { readonly outcome: "decrypted"; readonly plaintext: Uint8Array }
		| {
				readonly outcome: "failed";
				readonly code:
					| "SECRET_KEY_UNAVAILABLE"
					| "SECRET_METADATA_INVALID"
					| "SECRET_AUTHENTICATION_FAILED";
		  }
	>;
}

export interface SecretActivationApplyInputV1 {
	readonly schemaVersion: 1;
	readonly kubernetesSecretRef: SecretActivationReferenceV1;
	readonly secretKey: string;
	readonly fence: number;
	readonly plaintext: Uint8Array;
}

export type SecretActivationObservationV1 =
	| { readonly status: "pending" }
	| {
			readonly schemaVersion: 1;
			readonly status: "observed";
			readonly kubernetesSecretRef: SecretActivationReferenceV1;
			readonly activationFence: SecretActivationFenceV1;
			readonly health: "healthy";
	  }
	| {
			readonly schemaVersion: 1;
			readonly status: "failed";
			readonly kubernetesSecretRef?: SecretActivationReferenceV1;
			readonly activationFence: SecretActivationFenceV1;
			readonly health: "unknown" | "unhealthy";
			readonly error: SecretActivationFailureV1;
	  };

export interface SecretActivationKubernetesPortV1 {
	applyCandidate(input: SecretActivationApplyInputV1): Promise<
		| {
				readonly outcome: "applied";
				readonly workloadUid: string;
				readonly workloadGeneration: number;
		  }
		| { readonly outcome: "failed" }
	>;
	observeCandidate(input: {
		readonly schemaVersion: 1;
		readonly kubernetesSecretRef: SecretActivationReferenceV1;
		readonly activationFence: SecretActivationFenceV1;
	}): Promise<SecretActivationObservationV1>;
}

export interface ActivateSecretCandidateCommandV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly secretId: string;
	readonly secretVersion: number;
	readonly configRevision: number;
	readonly workerId: string;
	readonly traceId: string;
}

export type SecretActivationDecisionV1 =
	| {
			readonly schemaVersion: 1;
			readonly outcome: "active" | "applying" | "failed";
			readonly agentId: string;
			readonly secretId: string;
			readonly secretVersion: number;
			readonly configRevision: number;
	  }
	| { readonly schemaVersion: 1; readonly outcome: "busy" | "stale" };

export interface SecretActivationUseCaseV1 {
	activate(
		command: ActivateSecretCandidateCommandV1,
	): Promise<SecretActivationDecisionV1>;
}

export class SecretActivationError extends Error {
	readonly code: "invalid_input" | "unavailable";

	constructor(code: "invalid_input" | "unavailable") {
		super(
			code === "invalid_input"
				? "Invalid Secret activation command"
				: "Secret activation is unavailable",
		);
		this.name = "SecretActivationError";
		this.code = code;
	}
}

const failureDetails = {
	SECRET_KEY_UNAVAILABLE: {
		message: "Secret key is unavailable",
		retryable: true,
	},
	SECRET_METADATA_INVALID: {
		message: "Secret metadata is invalid",
		retryable: false,
	},
	SECRET_AUTHENTICATION_FAILED: {
		message: "Secret authentication failed",
		retryable: false,
	},
	SECRET_ACTIVATION_FAILED: {
		message: "Secret activation failed",
		retryable: true,
	},
} as const;

function validText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 1024 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value)
	);
}

function parseCommand(input: unknown): ActivateSecretCandidateCommandV1 {
	try {
		if (
			!input ||
			typeof input !== "object" ||
			Array.isArray(input) ||
			types.isProxy(input) ||
			Object.getPrototypeOf(input) !== Object.prototype
		) {
			throw new Error();
		}
		const keys = [
			"schemaVersion",
			"agentId",
			"secretId",
			"secretVersion",
			"configRevision",
			"workerId",
			"traceId",
		] as const;
		const descriptors = Object.getOwnPropertyDescriptors(input);
		if (
			Reflect.ownKeys(descriptors).length !== keys.length ||
			keys.some((key) => {
				const descriptor = descriptors[key];
				return (
					descriptor?.enumerable !== true ||
					!Object.hasOwn(descriptor, "value") ||
					Object.hasOwn(descriptor, "get") ||
					Object.hasOwn(descriptor, "set")
				);
			})
		) {
			throw new Error();
		}
		const value = input as Record<string, unknown>;
		if (
			value.schemaVersion !== 1 ||
			![value.agentId, value.secretId, value.workerId, value.traceId].every(
				validText,
			) ||
			![value.secretVersion, value.configRevision].every(
				(entry) => Number.isSafeInteger(entry) && (entry as number) >= 1,
			)
		) {
			throw new Error();
		}
		return {
			schemaVersion: 1,
			agentId: value.agentId as string,
			secretId: value.secretId as string,
			secretVersion: value.secretVersion as number,
			configRevision: value.configRevision as number,
			workerId: value.workerId as string,
			traceId: value.traceId as string,
		};
	} catch {
		throw new SecretActivationError("invalid_input");
	}
}

function decideClaim(
	command: ActivateSecretCandidateCommandV1,
	state: SecretActivationClaimStateV1,
): SecretActivationClaimPlanV1 {
	if (state.currentConfigurationRevision !== command.configRevision) {
		return { outcome: "stale" };
	}
	if (state.candidate.lifecycleState === "active") {
		return { outcome: "active" };
	}
	if (
		state.candidate.lifecycleState === "failed" &&
		state.candidate.failureRetryable === false
	) {
		return { outcome: "failed" };
	}
	return { outcome: "claim" };
}

function validatedClaim(
	claim: SecretActivationClaimV1,
	command: ActivateSecretCandidateCommandV1,
): SecretActivationClaimV1 {
	try {
		const candidate = claim.candidate;
		if (
			claim.schemaVersion !== 1 ||
			claim.workerId !== command.workerId ||
			!Number.isSafeInteger(claim.fence) ||
			claim.fence < 1 ||
			!Number.isFinite(Date.prototype.getTime.call(claim.leaseExpiresAt)) ||
			candidate.schemaVersion !== 1 ||
			candidate.agentId !== command.agentId ||
			candidate.secretId !== command.secretId ||
			candidate.secretVersion !== command.secretVersion ||
			candidate.configRevision !== command.configRevision ||
			candidate.lifecycleState === "active" ||
			(candidate.lifecycleState === "failed") !==
				(candidate.failureRetryable !== null) ||
			(candidate.ownerType !== "agent-owner" &&
				candidate.ownerType !== "platform") ||
			![candidate.ownerId, candidate.name, candidate.wrappingKeyVersion].every(
				validText,
			)
		) {
			throw new Error();
		}
		return claim;
	} catch {
		throw new SecretActivationError("unavailable");
	}
}

export function immutableSecretNameV1(
	candidate: SecretActivationCandidateV1,
): string {
	const agent = createHash("sha256")
		.update(candidate.agentId)
		.digest("hex")
		.slice(0, 16);
	const secret = createHash("sha256")
		.update(candidate.secretId)
		.digest("hex")
		.slice(0, 16);
	return `agent-${agent}.secret-${secret}-v${candidate.secretVersion}-r${candidate.configRevision}`;
}

function secretReference(
	candidate: SecretActivationCandidateV1,
): SecretActivationReferenceV1 {
	return {
		schemaVersion: 1,
		ownerType: candidate.ownerType,
		ownerId: candidate.ownerId,
		agentId: candidate.agentId,
		secretId: candidate.secretId,
		secretVersion: candidate.secretVersion,
		configRevision: candidate.configRevision,
		algorithmVersion: "aes-256-gcm:v1",
		wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
		wrappingKeyVersion: candidate.wrappingKeyVersion,
		name: immutableSecretNameV1(candidate),
	};
}

function failure(
	code: SecretActivationFailureCodeV1,
	traceId: string,
): SecretActivationFailureV1 {
	return { schemaVersion: 1, code, ...failureDetails[code], traceId };
}

function audit(
	claim: SecretActivationClaimV1,
	traceId: string,
	operation: "decrypt" | "activate",
	result: "succeeded" | "rejected" | "failed",
): SecretActivationAuditIntentV1 {
	const identity = [
		claim.candidate.agentId,
		claim.candidate.secretId,
		claim.candidate.secretVersion,
		claim.candidate.configRevision,
		claim.fence,
		operation,
		result,
	].join("\0");
	return {
		schemaVersion: 1,
		auditId: `secret-audit-${createHash("sha256").update(identity).digest("hex")}`,
		traceId,
		actorType: "system",
		actorId: claim.workerId,
		action: operation === "decrypt" ? "secret.decrypt" : "secret.activate",
		targetType: "secret",
		targetId: claim.candidate.secretId,
		agentId: claim.candidate.agentId,
		outcome: result,
		details: {
			wrappingKeyVersion: claim.candidate.wrappingKeyVersion,
			operation,
			result,
		},
	};
}

function transitionPlan(input: {
	readonly expectedLifecycleStates: readonly SecretActivationLifecycleStateV1[];
	readonly expectedActivationFence?: SecretActivationFenceV1;
	readonly next: SecretActivationNextStateV1;
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

function referenceMatches(
	expected: SecretActivationReferenceV1,
	actual: SecretActivationReferenceV1,
): boolean {
	return (
		expected.schemaVersion === actual.schemaVersion &&
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

function fenceMatches(
	expected: SecretActivationFenceV1,
	actual: SecretActivationFenceV1,
): boolean {
	return (
		expected.schemaVersion === actual.schemaVersion &&
		expected.agentId === actual.agentId &&
		expected.secretId === actual.secretId &&
		expected.secretVersion === actual.secretVersion &&
		expected.configRevision === actual.configRevision &&
		expected.kubernetesSecretName === actual.kubernetesSecretName &&
		expected.workloadUid === actual.workloadUid &&
		expected.workloadGeneration === actual.workloadGeneration &&
		expected.fence === actual.fence
	);
}

function result(
	command: ActivateSecretCandidateCommandV1,
	outcome: "active" | "applying" | "failed",
): SecretActivationDecisionV1 {
	return {
		schemaVersion: 1,
		outcome,
		agentId: command.agentId,
		secretId: command.secretId,
		secretVersion: command.secretVersion,
		configRevision: command.configRevision,
	};
}

export function createSecretActivationUseCaseV1(
	dependencies: {
		readonly store: SecretActivationStorePortV1;
		readonly decryptor: SecretActivationDecryptorPortV1;
		readonly kubernetes: SecretActivationKubernetesPortV1;
	},
	options: { readonly leaseMs?: number } = {},
): SecretActivationUseCaseV1 {
	const leaseMs = options.leaseMs ?? 30_000;
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) {
		throw new SecretActivationError("invalid_input");
	}
	return {
		async activate(input) {
			const command = parseCommand(input);
			try {
				const claimDecision = await dependencies.store.claimCandidate(
					{ ...command, leaseDurationMs: leaseMs },
					(state) => decideClaim(command, state),
				);
				if (claimDecision.outcome !== "claimed") {
					if (claimDecision.outcome === "active")
						return result(command, "active");
					if (claimDecision.outcome === "failed")
						return result(command, "failed");
					return { schemaVersion: 1, outcome: claimDecision.outcome };
				}
				const claim = validatedClaim(claimDecision.claim, command);
				const reference = secretReference(claim.candidate);
				const decryption = await dependencies.decryptor.decrypt({
					encryptedRecord: claim.candidate.encryptedRecord,
					traceId: command.traceId,
				});
				if (decryption.outcome === "failed") {
					const saved = await dependencies.store.commitTransition({
						claim,
						plan: transitionPlan({
							expectedLifecycleStates: [claim.candidate.lifecycleState],
							next: {
								lifecycleState: "failed",
								error: failure(decryption.code, command.traceId),
							},
							auditEvents: [
								audit(claim, command.traceId, "decrypt", "rejected"),
							],
						}),
					});
					return saved
						? result(command, "failed")
						: { schemaVersion: 1, outcome: "stale" };
				}
				if (!(decryption.plaintext instanceof Uint8Array)) {
					throw new SecretActivationError("unavailable");
				}
				let applied: Awaited<
					ReturnType<SecretActivationKubernetesPortV1["applyCandidate"]>
				>;
				try {
					const audited = await dependencies.store.recordAudit({
						claim,
						auditEvent: audit(claim, command.traceId, "decrypt", "succeeded"),
					});
					if (!audited) return { schemaVersion: 1, outcome: "stale" };
					applied = await dependencies.kubernetes.applyCandidate({
						schemaVersion: 1,
						kubernetesSecretRef: reference,
						secretKey: claim.candidate.name,
						fence: claim.fence,
						plaintext: decryption.plaintext,
					});
				} finally {
					decryption.plaintext.fill(0);
				}
				if (applied.outcome === "failed") {
					const saved = await dependencies.store.commitTransition({
						claim,
						plan: transitionPlan({
							expectedLifecycleStates: [claim.candidate.lifecycleState],
							next: {
								lifecycleState: "failed",
								kubernetesSecretRef: reference,
								error: failure("SECRET_ACTIVATION_FAILED", command.traceId),
							},
							auditEvents: [
								audit(claim, command.traceId, "activate", "failed"),
							],
						}),
					});
					return saved
						? result(command, "failed")
						: { schemaVersion: 1, outcome: "stale" };
				}
				if (
					!validText(applied.workloadUid) ||
					!Number.isSafeInteger(applied.workloadGeneration) ||
					applied.workloadGeneration < 1
				) {
					throw new SecretActivationError("unavailable");
				}
				const activationFence: SecretActivationFenceV1 = {
					schemaVersion: 1,
					agentId: claim.candidate.agentId,
					secretId: claim.candidate.secretId,
					secretVersion: claim.candidate.secretVersion,
					configRevision: claim.candidate.configRevision,
					kubernetesSecretName: reference.name,
					workloadUid: applied.workloadUid,
					workloadGeneration: applied.workloadGeneration,
					fence: claim.fence,
				};
				const applying = await dependencies.store.commitTransition({
					claim,
					plan: transitionPlan({
						expectedLifecycleStates: [claim.candidate.lifecycleState],
						next: {
							lifecycleState: "applying",
							kubernetesSecretRef: reference,
							activationFence,
						},
					}),
				});
				if (!applying) return { schemaVersion: 1, outcome: "stale" };
				const observation = await dependencies.kubernetes.observeCandidate({
					schemaVersion: 1,
					kubernetesSecretRef: reference,
					activationFence,
				});
				if (observation.status === "pending") {
					return result(command, "applying");
				}
				if (
					!fenceMatches(activationFence, observation.activationFence) ||
					(observation.status === "observed" &&
						(!observation.kubernetesSecretRef ||
							!referenceMatches(reference, observation.kubernetesSecretRef))) ||
					(observation.status === "failed" &&
						observation.kubernetesSecretRef !== undefined &&
						!referenceMatches(reference, observation.kubernetesSecretRef))
				) {
					return { schemaVersion: 1, outcome: "stale" };
				}
				if (observation.status === "failed") {
					const saved = await dependencies.store.commitTransition({
						claim,
						plan: transitionPlan({
							expectedLifecycleStates: ["applying"],
							expectedActivationFence: activationFence,
							next: {
								lifecycleState: "failed",
								kubernetesSecretRef: reference,
								activationFence,
								error: failure("SECRET_ACTIVATION_FAILED", command.traceId),
							},
							auditEvents: [
								audit(claim, command.traceId, "activate", "failed"),
							],
						}),
					});
					return saved
						? result(command, "failed")
						: { schemaVersion: 1, outcome: "stale" };
				}
				if (observation.health !== "healthy") {
					return { schemaVersion: 1, outcome: "stale" };
				}
				const observed = await dependencies.store.commitTransition({
					claim,
					plan: transitionPlan({
						expectedLifecycleStates: ["applying"],
						expectedActivationFence: activationFence,
						next: {
							lifecycleState: "observed",
							kubernetesSecretRef: reference,
							activationFence,
						},
					}),
				});
				if (!observed) return { schemaVersion: 1, outcome: "stale" };
				const active = await dependencies.store.commitTransition({
					claim,
					plan: transitionPlan({
						expectedLifecycleStates: ["observed"],
						expectedActivationFence: activationFence,
						next: {
							lifecycleState: "active",
							kubernetesSecretRef: reference,
							activationFence,
						},
						auditEvents: [
							audit(claim, command.traceId, "activate", "succeeded"),
						],
					}),
				});
				return active
					? result(command, "active")
					: { schemaVersion: 1, outcome: "stale" };
			} catch {
				throw new SecretActivationError("unavailable");
			}
		},
	};
}
