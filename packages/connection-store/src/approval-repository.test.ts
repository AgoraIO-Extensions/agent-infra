import { describe, expect, it } from "vitest";

import {
	type ApprovalPolicyDraft,
	validateApprovalPolicyDraft,
} from "./approval-repository";

function draft(): ApprovalPolicyDraft {
	return {
		allowPermanent: true,
		capabilityProfileId: "profile-jira-write",
		connectTtlSeconds: 604_800,
		createdByPrincipalId: "principal-admin",
		defaultDurationDays: 90,
		disclaimerVersionIds: ["disclaimer-global-v1"],
		durations: [
			{ days: 90, id: "duration-90", kind: "FINITE" },
			{ id: "duration-permanent", kind: "PERMANENT" },
		],
		id: "policy-jira-write-v1",
		priority: 100,
		providerReleaseId: "jira-release-v1",
		renewalLeadSeconds: 1_209_600,
		requestTtlSeconds: 1_209_600,
		stages: [
			{
				approvers: [
					{
						displaySnapshot: { displayName: "Approver One" },
						principalId: "principal-approver-1",
					},
				],
				id: "stage-1",
				name: "Security",
				quorumType: "ANY",
				timeoutSeconds: 259_200,
			},
		],
	};
}

describe("approval policy draft validation", () => {
	it("accepts a bounded staged policy", () => {
		expect(() => validateApprovalPolicyDraft(draft())).not.toThrow();
	});

	it("accepts an incomplete draft without inventing disclaimers or approvers", () => {
		const value = draft();
		value.disclaimerVersionIds = [];
		value.stages = value.stages.map((stage) => ({ ...stage, approvers: [] }));
		expect(() => validateApprovalPolicyDraft(value)).not.toThrow();
	});

	it("rejects one approver assigned to multiple stages", () => {
		const value = draft();
		value.stages = [
			...value.stages,
			{
				approvers: value.stages[0]?.approvers ?? [],
				id: "stage-2",
				name: "Data Owner",
				quorumType: "ALL",
				timeoutSeconds: 259_200,
			},
		];
		expect(() => validateApprovalPolicyDraft(value)).toThrow(
			"An approver cannot appear in multiple stages",
		);
	});

	it("rejects an unsatisfiable quorum", () => {
		const value = draft();
		const [stage] = value.stages;
		if (!stage) throw new Error("test fixture stage is missing");
		value.stages = [
			{
				...stage,
				quorumCount: 2,
				quorumType: "AT_LEAST_N",
			},
		];
		expect(() => validateApprovalPolicyDraft(value)).toThrow(
			"Approval stage quorum cannot be satisfied",
		);
	});

	it("rejects a default outside the allowed durations", () => {
		const value = draft();
		value.defaultDurationDays = 30;
		expect(() => validateApprovalPolicyDraft(value)).toThrow(
			"Default duration must be one of the allowed finite durations",
		);
	});

	it("rejects a mismatched permanent option", () => {
		const value = draft();
		value.allowPermanent = false;
		expect(() => validateApprovalPolicyDraft(value)).toThrow(
			"Permanent duration does not match policy configuration",
		);
	});
});
