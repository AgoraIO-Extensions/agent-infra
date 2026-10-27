import { describe, expect, it } from "vitest";
import {
	decideSkillPackageAdmissionV1,
	type SkillPackageScanAssessmentV1,
	type SkillPackageReviewPolicyV1,
} from "./skill-package-review-policy.js";

const policy: SkillPackageReviewPolicyV1 = {
	schemaVersion: 1,
	policyRevision: "policy-1",
	autoPublishMaxSeverity: "LOW",
	fatalRuleIds: ["SKL-DOWNLOAD-EXEC"],
	dynamicProbeCategories: ["network", "credentials"],
};
const base: SkillPackageScanAssessmentV1 = {
	schemaVersion: 1,
	scannerId: "nvidia-skillspector",
	engineVersion: "1.0.0",
	rulesetDigest: "a".repeat(64),
	policyRevision: "policy-1",
	packageDigest: "b".repeat(64),
	manifestDigest: "c".repeat(64),
	scannedFileCount: 2,
	scannedBytes: 100,
	scannedAt: "2026-10-27T00:00:00.000Z",
	expiresAt: "2026-10-27T00:05:00.000Z",
	coverageComplete: true,
	recommendation: "SAFE",
	scanMode: "static",
	findings: [],
};
const passedProbe = {
	status: "passed" as const,
	probeId: "sandbox-1",
	engineVersion: "probe-1",
	evidenceDigest: "d".repeat(64),
};

describe("Skill package review policy", () => {
	it("auto-publishes a complete low-risk static assessment", () => {
		expect(
			decideSkillPackageAdmissionV1({ policy, assessment: base }),
		).toEqual({ decision: "auto_published", reasonCode: "clean" });
	});
	it("routes non-fatal high-risk findings to manual review", () => {
		expect(
			decideSkillPackageAdmissionV1({
				policy,
				assessment: {
					...base,
					recommendation: "CAUTION",
					findings: [
						{
							ruleId: "SKL-NETWORK",
							category: "other",
							severity: "HIGH",
							deterministic: true,
						},
					],
				},
				dynamicProbe: passedProbe,
			}),
		).toEqual({
				decision: "pending_review",
				reasonCode: "risk_requires_review",
			});
	});
	it("rejects fatal findings and incomplete evidence", () => {
		expect(
			decideSkillPackageAdmissionV1({
				policy,
				assessment: {
					...base,
					recommendation: "DO_NOT_INSTALL",
					findings: [
						{
							ruleId: "SKL-DOWNLOAD-EXEC",
							category: "supply_chain",
							severity: "CRITICAL",
							deterministic: true,
						},
					],
				},
			}),
		).toEqual({ decision: "rejected", reasonCode: "fatal_finding" });
		expect(
			decideSkillPackageAdmissionV1({
				policy,
				assessment: { ...base, coverageComplete: false },
			}),
		).toEqual({ decision: "rejected", reasonCode: "incomplete_scan" });
	});
	it("requires a passing probe for selected categories", () => {
		const assessment: SkillPackageScanAssessmentV1 = {
			...base,
			findings: [
				{
					ruleId: "SKL-NETWORK-INFO",
					category: "network",
					severity: "LOW",
					deterministic: true,
				},
			],
		};
		expect(decideSkillPackageAdmissionV1({ policy, assessment })).toEqual({
			decision: "rejected",
			reasonCode: "probe_required",
		});
		expect(
			decideSkillPackageAdmissionV1({ policy, assessment, dynamicProbe: passedProbe }),
		).toEqual({ decision: "auto_published", reasonCode: "clean" });
	});
	it("rejects a policy mismatch", () => {
		expect(
			decideSkillPackageAdmissionV1({
				policy,
				assessment: { ...base, policyRevision: "old" },
			}),
		).toEqual({ decision: "rejected", reasonCode: "policy_mismatch" });
	});
});
