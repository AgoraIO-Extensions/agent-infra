/** Fixed, body-free failure facts for the existing Skill binding read contract. */
export type SkillSyncFailureV1 = Readonly<{
	stage:
		| "binding_admission"
		| "package_verification"
		| "materialization"
		| "delivery"
		| "applied_persistence";
	reason:
		| "dependency_unavailable"
		| "denied"
		| "invalid_binding"
		| "digest_mismatch"
		| "signature_invalid"
		| "scan_rejected"
		| "source_untrusted"
		| "invalid_package"
		| "invalid_materialization"
		| "policy_mismatch"
		| "conflict"
		| "stale_binding";
	retryable: boolean;
}>;
export type SkillSyncAttemptV1 = Readonly<{
	agentId: string;
	agentVersion: string;
	configurationRevision: number;
	workloadRevision: number;
	fence: number;
	actorId: string;
	organizationIds: readonly string[];
	isAdministrator: boolean;
	bindings: readonly { skillVersionId: string; syncRevision: number }[];
}>;
export function skillSyncFailureCodeV1(failure: SkillSyncFailureV1): string {
	if (
		!failure ||
		![
			"binding_admission",
			"package_verification",
			"materialization",
			"delivery",
			"applied_persistence",
		].includes(failure.stage) ||
		![
			"dependency_unavailable",
			"denied",
			"invalid_binding",
			"digest_mismatch",
			"signature_invalid",
			"scan_rejected",
			"source_untrusted",
			"invalid_package",
			"invalid_materialization",
			"policy_mismatch",
			"conflict",
			"stale_binding",
		].includes(failure.reason) ||
		typeof failure.retryable !== "boolean"
	)
		throw new TypeError("Invalid Skill sync failure");
	if (
		failure.retryable !==
		["dependency_unavailable", "conflict"].includes(failure.reason)
	)
		throw new TypeError("Invalid Skill sync retry classification");
	return `SKILL_SYNC_${failure.stage}_${failure.reason}_${failure.retryable ? "RETRYABLE" : "REJECTED"}`.toUpperCase();
}
export class SkillSyncErrorV1 extends Error {
	readonly failure: SkillSyncFailureV1;
	constructor(failure: SkillSyncFailureV1) {
		super(skillSyncFailureCodeV1(failure));
		this.name = "SkillSyncErrorV1";
		this.failure = Object.freeze({
			stage: failure.stage,
			reason: failure.reason,
			retryable: failure.retryable,
		});
	}
}
