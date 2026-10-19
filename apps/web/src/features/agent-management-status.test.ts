import { describe, expect, it } from "vitest";
import type { AgentProjectionV2 } from "../pilot/generated-v2/types.gen.js";
import {
	agentAvailabilityStatus,
	agentManagementStatusLabels,
} from "./agent-management-status.js";

const managementStatuses = Object.keys(
	agentManagementStatusLabels,
) as AgentProjectionV2["managementStatus"][];
const serviceStatus = {
	ready: { label: "就绪", tone: "green" },
	starting: { label: "启动中", tone: "amber" },
	updating: { label: "更新中", tone: "amber" },
	unavailable: { label: "暂时不可用", tone: "gray" },
} as const;
const serviceAvailabilities: AgentProjectionV2["serviceAvailability"][] = [
	"ready",
	"starting",
	"updating",
	"unavailable",
	null,
];

describe("agentAvailabilityStatus", () => {
	it("covers every management status and service availability with one label and tone", () => {
		expect(managementStatuses).toHaveLength(8);
		for (const managementStatus of managementStatuses)
			for (const serviceAvailability of serviceAvailabilities) {
				const expected =
					managementStatus === "available" && serviceAvailability
						? serviceStatus[serviceAvailability]
						: {
								label: agentManagementStatusLabels[managementStatus],
								tone: managementStatus === "available" ? "green" : "gray",
							};
				expect(
					agentAvailabilityStatus({ managementStatus, serviceAvailability }),
					`${managementStatus} × ${serviceAvailability}`,
				).toEqual(expected);
			}
	});

	it("never reports a service state for an Agent that is not available", () => {
		expect(
			agentAvailabilityStatus({
				managementStatus: "stopped",
				serviceAvailability: "ready",
			}),
		).toEqual({ label: "已停止", tone: "gray" });
		expect(
			agentAvailabilityStatus({
				managementStatus: "creation_failed",
				serviceAvailability: null,
			}),
		).toEqual({ label: "创建失败", tone: "gray" });
	});
});
