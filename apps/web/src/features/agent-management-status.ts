import type {
	AgentApplicationProjectionV2,
	AgentProjectionV2,
} from "../pilot/generated-v2/types.gen.js";

export const agentManagementStatusLabels = {
	pending_approval: "Pending approval",
	withdrawn: "Withdrawn",
	rejected: "Rejected",
	creating: "Creating",
	available: "Available",
	stopped: "Stopped",
	creation_failed: "Creation failed",
	disabled: "Disabled",
} satisfies Record<
	| AgentApplicationProjectionV2["status"]
	| AgentProjectionV2["managementStatus"],
	string
>;
