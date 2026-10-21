import { describe, expect, it } from "vitest";

import {
	agentCreationFailureCategoryV1,
	isAgentCreationFailureReadAllowedV1,
} from "./agent-creation-failure.js";
import type { AgentManagementActorContextV1 } from "./agent-management.js";
import type { WorkloadFailureReasonCodeV1 } from "./workload-reconciliation.js";

function actor(
	overrides: Partial<AgentManagementActorContextV1> = {},
): AgentManagementActorContextV1 {
	return {
		schemaVersion: 1,
		userId: "owner-a",
		accountStatus: "active",
		organizationIds: [],
		isAdministrator: false,
		...overrides,
	};
}

describe("Agent creation failure category (#3034)", () => {
	it.each(["preflight_rejected", "kubernetes_policy"] as const)(
		"treats %s as a configuration that the deployment rejects",
		(reason) => {
			expect(
				agentCreationFailureCategoryV1({
					failureCode: "reconciliation_failed",
					workloadFailureReason: reason,
				}),
			).toBe("configuration_rejected");
		},
	);

	it("reports a failed health check before any recorded step failure", () => {
		expect(
			agentCreationFailureCategoryV1({
				failureCode: "health_check_failed",
				workloadFailureReason: "kubernetes_policy",
			}),
		).toBe("health_check_failed");
	});

	it.each<WorkloadFailureReasonCodeV1 | null>([
		null,
		"kubernetes_unauthorized",
		"kubernetes_forbidden",
		"kubernetes_not_found",
		"kubernetes_conflict",
		"kubernetes_invalid",
		"kubernetes_throttled",
		"kubernetes_server_error",
		"kubernetes_unreachable",
		"capabilities_unavailable",
		"unexpected_error",
	])("treats %s as a deployment that is temporarily unavailable", (reason) => {
		expect(
			agentCreationFailureCategoryV1({
				failureCode: "reconciliation_failed",
				workloadFailureReason: reason,
			}),
		).toBe("deployment_unavailable");
	});
});

describe("Agent creation failure read authorization (#3034)", () => {
	const failed = {
		ownerIds: ["owner-a", "owner-b"],
		status: "creation_failed" as const,
	};

	it("allows a current active Owner and an active system administrator", () => {
		expect(isAgentCreationFailureReadAllowedV1(actor(), failed)).toBe(true);
		expect(
			isAgentCreationFailureReadAllowedV1(actor({ userId: "owner-b" }), failed),
		).toBe(true);
		expect(
			isAgentCreationFailureReadAllowedV1(
				actor({ userId: "admin-a", isAdministrator: true }),
				failed,
			),
		).toBe(true);
	});

	it("rejects another user, a disabled Owner and a disabled administrator", () => {
		expect(
			isAgentCreationFailureReadAllowedV1(actor({ userId: "user-c" }), failed),
		).toBe(false);
		expect(
			isAgentCreationFailureReadAllowedV1(
				actor({ accountStatus: "disabled" }),
				failed,
			),
		).toBe(false);
		expect(
			isAgentCreationFailureReadAllowedV1(
				actor({
					userId: "admin-a",
					isAdministrator: true,
					accountStatus: "disabled",
				}),
				failed,
			),
		).toBe(false);
	});

	it.each([
		"creating",
		"available",
		"stopped",
		"disabled",
		"pending_approval",
	] as const)("hides the category while the Agent is %s", (status) => {
		expect(
			isAgentCreationFailureReadAllowedV1(actor(), { ...failed, status }),
		).toBe(false);
		expect(
			isAgentCreationFailureReadAllowedV1(
				actor({ userId: "admin-a", isAdministrator: true }),
				{ ...failed, status },
			),
		).toBe(false);
	});
});
