import { createHash } from "node:crypto";
import { types } from "node:util";

export type SecretActivationLifecycleStateV1 =
	| "pending"
	| "applying"
	| "observed"
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
	readonly encryptedRecord: unknown;
}

export interface SecretActivationClaimV1 {
	readonly schemaVersion: 1;
	readonly workerId: string;
	readonly fence: number;
	readonly leaseExpiresAt: Date;
	readonly candidate: SecretActivationCandidateV1;
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

export interface SecretActivationStorePortV1 {
	claimCandidate(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly secretId: string;
		readonly secretVersion: number;
		readonly configRevision: number;
		readonly workerId: string;
		readonly leaseDurationMs: number;
	}): Promise<
		| { readonly outcome: "claimed"; readonly claim: SecretActivationClaimV1 }
		| { readonly outcome: "busy" | "stale" | "active" | "failed" }
	>;
	markApplying(input: {
		readonly claim: SecretActivationClaimV1;
		readonly kubernetesSecretName: string;
		readonly activationFence: SecretActivationFenceV1;
	}): Promise<boolean>;
	markObserved(input: {
		readonly claim: SecretActivationClaimV1;
		readonly kubernetesSecretName: string;
		readonly activationFence: SecretActivationFenceV1;
	}): Promise<boolean>;
	markActive(input: {
		readonly claim: SecretActivationClaimV1;
		readonly kubernetesSecretName: string;
		readonly activationFence: SecretActivationFenceV1;
	}): Promise<boolean>;
	markFailed(input: {
		readonly claim: SecretActivationClaimV1;
		readonly kubernetesSecretName?: string;
		readonly activationFence?: SecretActivationFenceV1;
		readonly error: SecretActivationFailureV1;
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

interface SecretActivationApplyInputV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly secretId: string;
	readonly secretVersion: number;
	readonly configRevision: number;
	readonly ownerType: "agent-owner" | "platform";
	readonly ownerId: string;
	readonly name: string;
	readonly wrappingKeyVersion: string;
	readonly kubernetesSecretName: string;
	readonly fence: number;
	readonly plaintext: Uint8Array;
}

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
		readonly activationFence: SecretActivationFenceV1;
	}): Promise<
		| ({ readonly outcome: "observed" } & SecretActivationFenceV1)
		| ({ readonly outcome: "failed" } & SecretActivationFenceV1)
		| { readonly outcome: "pending" }
	>;
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
			(candidate.ownerType !== "agent-owner" &&
				candidate.ownerType !== "platform") ||
			![candidate.ownerId, candidate.name, candidate.wrappingKeyVersion].every(
				validText,
			) ||
			!(["pending", "applying", "observed", "failed"] as const).includes(
				candidate.lifecycleState,
			)
		) {
			throw new Error();
		}
		return claim;
	} catch {
		throw new SecretActivationError("unavailable");
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

function immutableSecretName(candidate: SecretActivationCandidateV1): string {
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

function failure(
	code: SecretActivationFailureCodeV1,
	traceId: string,
): SecretActivationFailureV1 {
	return { schemaVersion: 1, code, ...failureDetails[code], traceId };
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

function observedFenceMatches(
	expected: SecretActivationFenceV1,
	observation: {
		readonly outcome: "observed" | "failed";
	} & SecretActivationFenceV1,
): boolean {
	return (
		expected.agentId === observation.agentId &&
		expected.secretId === observation.secretId &&
		expected.secretVersion === observation.secretVersion &&
		expected.configRevision === observation.configRevision &&
		expected.kubernetesSecretName === observation.kubernetesSecretName &&
		expected.workloadUid === observation.workloadUid &&
		expected.workloadGeneration === observation.workloadGeneration &&
		expected.fence === observation.fence
	);
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
				const claimDecision = await dependencies.store.claimCandidate({
					...command,
					leaseDurationMs: leaseMs,
				});
				if (claimDecision.outcome !== "claimed") {
					if (claimDecision.outcome === "active")
						return result(command, "active");
					if (claimDecision.outcome === "failed")
						return result(command, "failed");
					return { schemaVersion: 1, outcome: claimDecision.outcome };
				}
				const claim = validatedClaim(claimDecision.claim, command);
				const kubernetesSecretName = immutableSecretName(claim.candidate);
				const decryption = await dependencies.decryptor.decrypt({
					encryptedRecord: claim.candidate.encryptedRecord,
					traceId: command.traceId,
				});
				if (decryption.outcome === "failed") {
					const saved = await dependencies.store.markFailed({
						claim,
						error: failure(decryption.code, command.traceId),
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
					applied = await dependencies.kubernetes.applyCandidate({
						schemaVersion: 1,
						agentId: claim.candidate.agentId,
						secretId: claim.candidate.secretId,
						secretVersion: claim.candidate.secretVersion,
						configRevision: claim.candidate.configRevision,
						ownerType: claim.candidate.ownerType,
						ownerId: claim.candidate.ownerId,
						name: claim.candidate.name,
						wrappingKeyVersion: claim.candidate.wrappingKeyVersion,
						kubernetesSecretName,
						fence: claim.fence,
						plaintext: decryption.plaintext,
					});
				} finally {
					decryption.plaintext.fill(0);
				}
				if (applied.outcome === "failed") {
					const saved = await dependencies.store.markFailed({
						claim,
						kubernetesSecretName,
						error: failure("SECRET_ACTIVATION_FAILED", command.traceId),
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
					kubernetesSecretName,
					workloadUid: applied.workloadUid,
					workloadGeneration: applied.workloadGeneration,
					fence: claim.fence,
				};
				if (
					!(await dependencies.store.markApplying({
						claim,
						kubernetesSecretName,
						activationFence,
					}))
				) {
					return { schemaVersion: 1, outcome: "stale" };
				}
				const observation = await dependencies.kubernetes.observeCandidate({
					schemaVersion: 1,
					activationFence,
				});
				if (observation.outcome === "pending")
					return result(command, "applying");
				if (!observedFenceMatches(activationFence, observation)) {
					return { schemaVersion: 1, outcome: "stale" };
				}
				if (observation.outcome === "failed") {
					const saved = await dependencies.store.markFailed({
						claim,
						kubernetesSecretName,
						activationFence,
						error: failure("SECRET_ACTIVATION_FAILED", command.traceId),
					});
					return saved
						? result(command, "failed")
						: { schemaVersion: 1, outcome: "stale" };
				}
				const transition = {
					claim,
					kubernetesSecretName,
					activationFence,
				};
				if (!(await dependencies.store.markObserved(transition))) {
					return { schemaVersion: 1, outcome: "stale" };
				}
				if (!(await dependencies.store.markActive(transition))) {
					return { schemaVersion: 1, outcome: "stale" };
				}
				return result(command, "active");
			} catch {
				throw new SecretActivationError("unavailable");
			}
		},
	};
}
