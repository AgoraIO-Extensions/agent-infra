import { createHash } from "node:crypto";
import { types } from "node:util";

export type SecretKeyRotationStateV1 =
	| "pending"
	| "rewrapping"
	| "verifying"
	| "completed"
	| "failed";

export interface SecretKeyRotationProgressV1 {
	readonly schemaVersion: 1;
	readonly rotationId: string;
	readonly sourceKeyVersions: readonly string[];
	readonly targetKeyVersion: string;
	readonly state: SecretKeyRotationStateV1;
	readonly processedSecrets: number;
	readonly remainingSecrets: number;
	readonly updatedAt: Date;
}

export interface RotateSecretKeyCommandV1 {
	readonly schemaVersion: 1;
	readonly rotationId: string;
	readonly sourceKeyVersions: readonly string[];
	readonly targetKeyVersion: string;
	readonly workerId: string;
	readonly traceId: string;
}

export interface RetireSecretKeyCommandV1 {
	readonly schemaVersion: 1;
	readonly keyVersion: string;
	readonly workerId: string;
	readonly traceId: string;
}

export interface SecretKeyRotationCandidateV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly secretId: string;
	readonly secretVersion: number;
	readonly configRevision: number;
	readonly ownerType: "agent-owner" | "platform";
	readonly ownerId: string;
	readonly name: string;
	readonly lifecycleState:
		| "pending"
		| "applying"
		| "observed"
		| "active"
		| "failed";
	readonly wrappingKeyVersion: string;
	readonly dekFingerprint: string;
	readonly encryptedRecord: unknown;
}

export interface SecretKeyRotationAuditIntentV1 {
	readonly schemaVersion: 1;
	readonly auditId: string;
	readonly traceId: string;
	readonly actorType: "system";
	readonly actorId: string;
	readonly action: "secret.decrypt" | "secret.rewrap" | "secret.retire-key";
	readonly targetType: "secret" | "secret_key";
	readonly targetId: string;
	readonly agentId: string | null;
	readonly outcome: "succeeded" | "rejected" | "failed";
	readonly details: {
		readonly wrappingKeyVersion: string;
		readonly operation: "decrypt" | "rewrap" | "retire-key";
		readonly result: "succeeded" | "rejected" | "failed";
	};
}

export type SecretKeyRotationCryptoFailureCodeV1 =
	| "SECRET_KEY_UNAVAILABLE"
	| "SECRET_METADATA_INVALID"
	| "SECRET_AUTHENTICATION_FAILED"
	| "SECRET_ROTATION_FAILED";

export interface SecretKeyRotationCryptoPortV1 {
	readonly activeWrappingKeyVersion: string;
	readonly retiringWrappingKeyVersions: readonly string[];
	reencrypt(input: {
		readonly encryptedRecord: unknown;
		readonly expectedBinding: {
			readonly agentId: string;
			readonly secretId: string;
			readonly secretVersion: number;
			readonly configRevision: number;
			readonly ownerType: "agent-owner" | "platform";
			readonly ownerId: string;
			readonly name: string;
			readonly wrappingKeyVersion: string;
			readonly dekFingerprint: string;
		};
		readonly targetKeyVersion: string;
		readonly traceId: string;
	}): Promise<
		| {
				readonly outcome: "reencrypted";
				readonly attemptId: string;
				readonly encryptedRecord: unknown;
		  }
		| {
				readonly outcome: "failed";
				readonly attemptId: string;
				readonly code: SecretKeyRotationCryptoFailureCodeV1;
		  }
	>;
}

export interface SecretKeyRotationStorePortV1 {
	nextCandidate(command: RotateSecretKeyCommandV1): Promise<
		| {
				readonly outcome: "candidate";
				readonly progress: SecretKeyRotationProgressV1;
				readonly candidate: SecretKeyRotationCandidateV1;
		  }
		| {
				readonly outcome: "completed" | "failed";
				readonly progress: SecretKeyRotationProgressV1;
		  }
	>;
	commitReencryption(input: {
		readonly command: RotateSecretKeyCommandV1;
		readonly candidate: SecretKeyRotationCandidateV1;
		readonly encryptedRecord: unknown;
		readonly auditEvents: readonly SecretKeyRotationAuditIntentV1[];
		readonly rejectedAuditEvents: readonly SecretKeyRotationAuditIntentV1[];
	}): Promise<
		| {
				readonly outcome: "committed";
				readonly progress: SecretKeyRotationProgressV1;
		  }
		| { readonly outcome: "stale" }
		| { readonly outcome: "duplicate-fingerprint" }
	>;
	recordRejection(input: {
		readonly command: RotateSecretKeyCommandV1;
		readonly candidate: SecretKeyRotationCandidateV1;
		readonly failureCode: SecretKeyRotationCryptoFailureCodeV1;
		readonly auditEvents: readonly SecretKeyRotationAuditIntentV1[];
	}): Promise<boolean>;
	retireKey(input: {
		readonly command: RetireSecretKeyCommandV1;
		readonly activeWrappingKeyVersion: string;
		readonly retiredAuditEvent: SecretKeyRotationAuditIntentV1;
		readonly rejectedAuditEvent: SecretKeyRotationAuditIntentV1;
	}): Promise<"retired" | "referenced">;
}

export type SecretKeyRotationDecisionV1 =
	| {
			readonly schemaVersion: 1;
			readonly outcome: "rewrapped" | "completed";
			readonly progress: SecretKeyRotationProgressV1;
	  }
	| {
			readonly schemaVersion: 1;
			readonly outcome: "failed";
			readonly code: SecretKeyRotationCryptoFailureCodeV1;
	  }
	| { readonly schemaVersion: 1; readonly outcome: "stale" };

export interface SecretKeyRotationUseCaseV1 {
	rotate(
		command: RotateSecretKeyCommandV1,
	): Promise<SecretKeyRotationDecisionV1>;
	retire(command: RetireSecretKeyCommandV1): Promise<{
		readonly schemaVersion: 1;
		readonly outcome: "retired" | "referenced";
	}>;
}

export class SecretKeyRotationError extends Error {
	readonly code: "invalid_input" | "unavailable";

	constructor(code: "invalid_input" | "unavailable") {
		super(
			code === "invalid_input"
				? "Invalid Secret key rotation command"
				: "Secret key rotation is unavailable",
		);
		this.name = "SecretKeyRotationError";
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

function plainObject(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		!types.isProxy(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function parseRotationCommand(input: unknown): RotateSecretKeyCommandV1 {
	try {
		if (!plainObject(input)) throw new Error();
		const keys = [
			"schemaVersion",
			"rotationId",
			"sourceKeyVersions",
			"targetKeyVersion",
			"workerId",
			"traceId",
		] as const;
		if (
			Reflect.ownKeys(input).length !== keys.length ||
			keys.some((key) => !Object.hasOwn(input, key)) ||
			input.schemaVersion !== 1 ||
			![
				input.rotationId,
				input.targetKeyVersion,
				input.workerId,
				input.traceId,
			].every(validText) ||
			!Array.isArray(input.sourceKeyVersions) ||
			types.isProxy(input.sourceKeyVersions) ||
			input.sourceKeyVersions.length === 0 ||
			input.sourceKeyVersions.length > 128 ||
			!input.sourceKeyVersions.every(validText) ||
			new Set(input.sourceKeyVersions).size !==
				input.sourceKeyVersions.length ||
			input.sourceKeyVersions.includes(input.targetKeyVersion as string)
		) {
			throw new Error();
		}
		return Object.freeze({
			schemaVersion: 1,
			rotationId: input.rotationId as string,
			sourceKeyVersions: Object.freeze([...input.sourceKeyVersions]),
			targetKeyVersion: input.targetKeyVersion as string,
			workerId: input.workerId as string,
			traceId: input.traceId as string,
		});
	} catch {
		throw new SecretKeyRotationError("invalid_input");
	}
}

function validatedProgress(
	input: SecretKeyRotationProgressV1,
	command: RotateSecretKeyCommandV1,
): SecretKeyRotationProgressV1 {
	if (
		input.schemaVersion !== 1 ||
		input.rotationId !== command.rotationId ||
		input.targetKeyVersion !== command.targetKeyVersion ||
		input.sourceKeyVersions.length !== command.sourceKeyVersions.length ||
		input.sourceKeyVersions.some(
			(value, index) => value !== command.sourceKeyVersions[index],
		) ||
		!["pending", "rewrapping", "verifying", "completed", "failed"].includes(
			input.state,
		) ||
		![input.processedSecrets, input.remainingSecrets].every(
			(value) => Number.isSafeInteger(value) && value >= 0,
		) ||
		!Number.isFinite(Date.prototype.getTime.call(input.updatedAt)) ||
		(input.state === "completed" && input.remainingSecrets !== 0)
	) {
		throw new SecretKeyRotationError("unavailable");
	}
	return input;
}

function validatedCandidate(
	input: SecretKeyRotationCandidateV1,
	command: RotateSecretKeyCommandV1,
): SecretKeyRotationCandidateV1 {
	if (
		input.schemaVersion !== 1 ||
		![
			input.agentId,
			input.secretId,
			input.ownerId,
			input.name,
			input.wrappingKeyVersion,
		].every(validText) ||
		(input.ownerType !== "agent-owner" && input.ownerType !== "platform") ||
		![input.secretVersion, input.configRevision].every(
			(value) => Number.isSafeInteger(value) && value >= 1,
		) ||
		!["pending", "applying", "observed", "active", "failed"].includes(
			input.lifecycleState,
		) ||
		!command.sourceKeyVersions.includes(input.wrappingKeyVersion) ||
		!/^[a-f0-9]{64}$/.test(input.dekFingerprint)
	) {
		throw new SecretKeyRotationError("unavailable");
	}
	return input;
}

function secretAudit(
	command: RotateSecretKeyCommandV1,
	candidate: SecretKeyRotationCandidateV1,
	operation: "decrypt" | "rewrap",
	outcome: "succeeded" | "rejected" | "failed",
	attemptId: string,
): SecretKeyRotationAuditIntentV1 {
	const identity = [
		command.rotationId,
		candidate.agentId,
		candidate.secretId,
		candidate.secretVersion,
		candidate.configRevision,
		candidate.dekFingerprint,
		command.workerId,
		command.traceId,
		operation,
		outcome,
		attemptId,
	].join("\0");
	return Object.freeze({
		schemaVersion: 1,
		auditId: `secret-audit-${createHash("sha256").update(identity).digest("hex")}`,
		traceId: command.traceId,
		actorType: "system",
		actorId: command.workerId,
		action: operation === "decrypt" ? "secret.decrypt" : "secret.rewrap",
		targetType: "secret",
		targetId: candidate.secretId,
		agentId: candidate.agentId,
		outcome,
		details: Object.freeze({
			wrappingKeyVersion: candidate.wrappingKeyVersion,
			operation,
			result: outcome,
		}),
	});
}

function parseRetirementCommand(input: unknown): RetireSecretKeyCommandV1 {
	try {
		if (!plainObject(input)) throw new Error();
		const keys = [
			"schemaVersion",
			"keyVersion",
			"workerId",
			"traceId",
		] as const;
		if (
			Reflect.ownKeys(input).length !== keys.length ||
			keys.some((key) => !Object.hasOwn(input, key)) ||
			input.schemaVersion !== 1 ||
			![input.keyVersion, input.workerId, input.traceId].every(validText)
		) {
			throw new Error();
		}
		return Object.freeze({
			schemaVersion: 1,
			keyVersion: input.keyVersion as string,
			workerId: input.workerId as string,
			traceId: input.traceId as string,
		});
	} catch {
		throw new SecretKeyRotationError("invalid_input");
	}
}

function retirementAudit(
	command: RetireSecretKeyCommandV1,
	outcome: "succeeded" | "rejected",
): SecretKeyRotationAuditIntentV1 {
	const identity = [
		command.keyVersion,
		command.workerId,
		command.traceId,
		"retire-key",
		outcome,
	].join("\0");
	return Object.freeze({
		schemaVersion: 1,
		auditId: `secret-audit-${createHash("sha256").update(identity).digest("hex")}`,
		traceId: command.traceId,
		actorType: "system",
		actorId: command.workerId,
		action: "secret.retire-key",
		targetType: "secret_key",
		targetId: command.keyVersion,
		agentId: null,
		outcome,
		details: Object.freeze({
			wrappingKeyVersion: command.keyVersion,
			operation: "retire-key",
			result: outcome,
		}),
	});
}

export function createSecretKeyRotationUseCaseV1(dependencies: {
	readonly store: SecretKeyRotationStorePortV1;
	readonly crypto: SecretKeyRotationCryptoPortV1;
}): SecretKeyRotationUseCaseV1 {
	return {
		async rotate(input) {
			const command = parseRotationCommand(input);
			const retiringKeyVersions =
				dependencies.crypto.retiringWrappingKeyVersions;
			if (
				!validText(dependencies.crypto.activeWrappingKeyVersion) ||
				command.targetKeyVersion !==
					dependencies.crypto.activeWrappingKeyVersion ||
				!Array.isArray(retiringKeyVersions) ||
				retiringKeyVersions.some((keyVersion) => !validText(keyVersion)) ||
				command.sourceKeyVersions.some(
					(keyVersion) => !retiringKeyVersions.includes(keyVersion),
				)
			) {
				throw new SecretKeyRotationError("invalid_input");
			}
			try {
				const next = await dependencies.store.nextCandidate(command);
				const progress = validatedProgress(next.progress, command);
				if (next.outcome !== "candidate") {
					return next.outcome === "completed"
						? { schemaVersion: 1, outcome: "completed", progress }
						: {
								schemaVersion: 1,
								outcome: "failed",
								code: "SECRET_ROTATION_FAILED",
							};
				}
				const candidate = validatedCandidate(next.candidate, command);
				for (let attempt = 0; attempt < 3; attempt += 1) {
					const rotated = await dependencies.crypto.reencrypt({
						encryptedRecord: candidate.encryptedRecord,
						expectedBinding: {
							agentId: candidate.agentId,
							secretId: candidate.secretId,
							secretVersion: candidate.secretVersion,
							configRevision: candidate.configRevision,
							ownerType: candidate.ownerType,
							ownerId: candidate.ownerId,
							name: candidate.name,
							wrappingKeyVersion: candidate.wrappingKeyVersion,
							dekFingerprint: candidate.dekFingerprint,
						},
						targetKeyVersion: command.targetKeyVersion,
						traceId: command.traceId,
					});
					if (!validText(rotated.attemptId)) {
						throw new SecretKeyRotationError("unavailable");
					}
					if (rotated.outcome === "failed") {
						const outcome =
							rotated.code === "SECRET_METADATA_INVALID" ||
							rotated.code === "SECRET_AUTHENTICATION_FAILED"
								? "rejected"
								: "failed";
						const auditEvents =
							rotated.code === "SECRET_ROTATION_FAILED"
								? [
										secretAudit(
											command,
											candidate,
											"decrypt",
											"succeeded",
											rotated.attemptId,
										),
										secretAudit(
											command,
											candidate,
											"rewrap",
											"failed",
											rotated.attemptId,
										),
									]
								: [
										secretAudit(
											command,
											candidate,
											"decrypt",
											outcome,
											rotated.attemptId,
										),
									];
						const recorded = await dependencies.store.recordRejection({
							command,
							candidate,
							failureCode: rotated.code,
							auditEvents,
						});
						return recorded
							? { schemaVersion: 1, outcome: "failed", code: rotated.code }
							: { schemaVersion: 1, outcome: "stale" };
					}
					const successAudits = [
						secretAudit(
							command,
							candidate,
							"decrypt",
							"succeeded",
							rotated.attemptId,
						),
						secretAudit(
							command,
							candidate,
							"rewrap",
							"succeeded",
							rotated.attemptId,
						),
					];
					const rejectedAudits = [
						successAudits[0] as SecretKeyRotationAuditIntentV1,
						secretAudit(
							command,
							candidate,
							"rewrap",
							"rejected",
							rotated.attemptId,
						),
					];
					const committed = await dependencies.store.commitReencryption({
						command,
						candidate,
						encryptedRecord: rotated.encryptedRecord,
						auditEvents: successAudits,
						rejectedAuditEvents: rejectedAudits,
					});
					if (committed.outcome === "stale") {
						return { schemaVersion: 1, outcome: "stale" };
					}
					if (committed.outcome === "duplicate-fingerprint") continue;
					const committedProgress = validatedProgress(
						committed.progress,
						command,
					);
					return {
						schemaVersion: 1,
						outcome:
							committedProgress.state === "completed"
								? "completed"
								: "rewrapped",
						progress: committedProgress,
					};
				}
				return {
					schemaVersion: 1,
					outcome: "failed",
					code: "SECRET_ROTATION_FAILED",
				};
			} catch (error) {
				if (error instanceof SecretKeyRotationError) throw error;
				throw new SecretKeyRotationError("unavailable");
			}
		},
		async retire(input) {
			const command = parseRetirementCommand(input);
			if (!validText(dependencies.crypto.activeWrappingKeyVersion)) {
				throw new SecretKeyRotationError("unavailable");
			}
			try {
				const outcome = await dependencies.store.retireKey({
					command,
					activeWrappingKeyVersion:
						dependencies.crypto.activeWrappingKeyVersion,
					retiredAuditEvent: retirementAudit(command, "succeeded"),
					rejectedAuditEvent: retirementAudit(command, "rejected"),
				});
				if (outcome !== "retired" && outcome !== "referenced") {
					throw new Error();
				}
				return { schemaVersion: 1, outcome };
			} catch (error) {
				if (error instanceof SecretKeyRotationError) throw error;
				throw new SecretKeyRotationError("unavailable");
			}
		},
	};
}
