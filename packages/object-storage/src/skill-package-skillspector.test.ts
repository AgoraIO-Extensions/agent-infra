import { expect, it } from "vitest";
import { decideSkillPackageAdmissionV1 } from "./skill-package-skillspector.js";

const policy = {
	policyRevision: "policy-v1",
	maximumReceiptAgeMs: 60_000,
	fatalSeverities: ["high", "critical"] as const,
	maximumAutomaticSeverity: "low" as const,
};

const report = (overrides: Record<string, unknown> = {}) => ({
	schemaVersion: 1 as const,
	scannerId: "skillspector",
	engineVersion: "1.0.0",
	rulesetDigest: "a".repeat(64),
	policyRevision: "policy-v1",
	packageDigest: "b".repeat(64),
	manifestDigest: "c".repeat(64),
	issuedAt: new Date().toISOString(),
	coverage: "complete" as const,
	findingCount: 0,
	findings: [],
	dynamicProbe: { required: false, completed: false, violations: [] },
	...overrides,
});

it("fails closed for incomplete evidence and fatal findings", () => {
	expect(
		decideSkillPackageAdmissionV1(report({ coverage: "incomplete" }), policy),
	).toMatchObject({
		outcome: "rejected",
		reason: "incomplete_evidence",
	});
	expect(
		decideSkillPackageAdmissionV1(
			report({
				findings: [{ code: "network", severity: "high", category: "static" }],
			}),
			policy,
		),
	).toMatchObject({ outcome: "rejected", reason: "fatal_finding" });
	const malformed = report({
		findings: [{ code: "x", category: "static", severity: "toString" }],
	});
	expect(
		decideSkillPackageAdmissionV1(malformed as never, policy),
	).toMatchObject({
		outcome: "rejected",
		reason: "incomplete_evidence",
	});
});

it("routes uncertain findings to review but publishes clean complete reports", () => {
	expect(
		decideSkillPackageAdmissionV1(
			report({
				findings: [
					{
						code: "prompt-injection",
						severity: "medium",
						category: "semantic",
					},
				],
			}),
			policy,
		),
	).toMatchObject({ outcome: "pending_review", reason: "review_required" });
	expect(decideSkillPackageAdmissionV1(report(), policy)).toMatchObject({
		outcome: "auto_published",
		reason: "clean",
	});
});

it("rejects stale receipts and server-required probes", () => {
	const stale = decideSkillPackageAdmissionV1(
		report({ issuedAt: new Date(0).toISOString() }),
		{
			...policy,
			now: () => 60_001,
		},
	);
	expect(stale).toMatchObject({
		outcome: "rejected",
		reason: "incomplete_evidence",
	});
	const probe = decideSkillPackageAdmissionV1(
		report({
			dynamicProbe: { required: false, completed: false, violations: [] },
		}),
		{ ...policy, dynamicProbeRequired: true, now: () => 1 },
	);
	expect(probe).toMatchObject({
		outcome: "rejected",
		reason: "incomplete_evidence",
	});
	const violation = decideSkillPackageAdmissionV1(
		report({
			dynamicProbe: {
				required: false,
				completed: true,
				violations: ["network"],
			},
		}),
		{ ...policy, now: () => 1 },
	);
	expect(violation).toMatchObject({
		outcome: "rejected",
		reason: "incomplete_evidence",
	});
});
