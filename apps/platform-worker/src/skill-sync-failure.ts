import {
	SkillPackageAdmissionErrorV1,
	SkillPackageMaterializerErrorV1,
} from "@agent-infra/object-storage";
import {
	SkillSyncErrorV1,
	type SkillSyncFailureV1,
} from "@agent-infra/platform-core";
export function classifySkillSyncFailureV1(
	error: unknown,
	stage: SkillSyncFailureV1["stage"],
): SkillSyncErrorV1 {
	if (error instanceof SkillSyncErrorV1) return error;
	let reason: SkillSyncFailureV1["reason"] = "dependency_unavailable";
	if (error instanceof SkillPackageAdmissionErrorV1) {
		const code = error.code;
		reason =
			code === "dependency_unavailable" || code === "scan_unavailable"
				? "dependency_unavailable"
				: code === "signature_invalid" ||
						code === "digest_mismatch" ||
						code === "scan_rejected" ||
						code === "source_untrusted"
					? code
					: "invalid_package";
	}
	if (error instanceof SkillPackageMaterializerErrorV1)
		reason =
			error.code === "unavailable"
				? "dependency_unavailable"
				: error.code === "conflict"
					? "conflict"
					: "invalid_materialization";
	return new SkillSyncErrorV1({
		stage,
		reason,
		retryable: reason === "dependency_unavailable" || reason === "conflict",
	});
}
