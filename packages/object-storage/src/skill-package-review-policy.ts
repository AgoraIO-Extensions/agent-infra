export const skillPackageReviewSeverityV1 = [
	"LOW",
	"MEDIUM",
	"HIGH",
	"CRITICAL",
] as const;
export type SkillPackageReviewSeverityV1 =
	(typeof skillPackageReviewSeverityV1)[number];
export type SkillPackageReviewRecommendationV1 =
	| "SAFE"
	| "CAUTION"
	| "DO_NOT_INSTALL";
export type SkillPackageReviewFindingV1 = Readonly<{
	ruleId: string;
	category: string;
	severity: SkillPackageReviewSeverityV1;
	deterministic: boolean;
}>;
export type SkillPackageScanAssessmentV1 = Readonly<{
	schemaVersion: 1;
	scannerId: string;
	engineVersion: string;
	rulesetDigest: string;
	policyRevision: string;
	packageDigest: string;
	manifestDigest: string;
	scannedFileCount: number;
	scannedBytes: number;
	scannedAt: string;
	expiresAt: string;
	coverageComplete: boolean;
	recommendation: SkillPackageReviewRecommendationV1;
	scanMode: "static" | "static+llm";
	findings: readonly SkillPackageReviewFindingV1[];
}>;
export type SkillPackageReviewPolicyV1 = Readonly<{
	schemaVersion: 1;
	policyRevision: string;
	autoPublishMaxSeverity: SkillPackageReviewSeverityV1;
	fatalRuleIds: readonly string[];
	dynamicProbeCategories: readonly string[];
}>;
export type SkillPackageDynamicProbeV1 = Readonly<{
	status: "passed" | "failed";
	probeId: string;
	engineVersion: string;
	evidenceDigest: string;
}>;
export type SkillPackageAdmissionDecisionV1 = Readonly<{
	decision: "auto_published" | "pending_review" | "rejected";
	reasonCode:
		| "clean"
		| "risk_requires_review"
		| "fatal_finding"
		| "incomplete_scan"
		| "policy_mismatch"
		| "probe_required"
		| "probe_failed";
}>;

const severityRank = (severity: SkillPackageReviewSeverityV1) =>
	skillPackageReviewSeverityV1.indexOf(severity);

export function decideSkillPackageAdmissionV1(input: Readonly<{
	policy: SkillPackageReviewPolicyV1;
	assessment: SkillPackageScanAssessmentV1;
	dynamicProbe?: SkillPackageDynamicProbeV1;
}>): SkillPackageAdmissionDecisionV1 {
	const { policy, assessment } = input;
	if (assessment.policyRevision !== policy.policyRevision)
		return { decision: "rejected", reasonCode: "policy_mismatch" };
	if (!assessment.coverageComplete)
		return { decision: "rejected", reasonCode: "incomplete_scan" };
	const fatal = assessment.findings.some(
		(finding) =>
			finding.deterministic && policy.fatalRuleIds.includes(finding.ruleId),
	);
	if (fatal || assessment.recommendation === "DO_NOT_INSTALL")
		return { decision: "rejected", reasonCode: "fatal_finding" };
	const highest = assessment.findings.reduce<SkillPackageReviewSeverityV1>(
		(current, finding) =>
			severityRank(finding.severity) > severityRank(current)
				? finding.severity
				: current,
		"LOW",
	);
	if (severityRank(highest) > severityRank(policy.autoPublishMaxSeverity))
		return { decision: "pending_review", reasonCode: "risk_requires_review" };
	const probeRequired = assessment.findings.some((finding) =>
		policy.dynamicProbeCategories.includes(finding.category),
	);
	if (probeRequired && !input.dynamicProbe)
		return { decision: "rejected", reasonCode: "probe_required" };
	if (probeRequired && input.dynamicProbe?.status !== "passed")
		return { decision: "rejected", reasonCode: "probe_failed" };
	if (assessment.recommendation === "CAUTION")
		return { decision: "pending_review", reasonCode: "risk_requires_review" };
	return { decision: "auto_published", reasonCode: "clean" };
}
