import type { AgentApplicationProjectionV1 } from "../../pilot/generated/types.gen.js";

export const applicationStatusLabels = {
	pending_approval: "Pending approval",
	withdrawn: "Withdrawn",
	rejected: "Rejected",
	creating: "Creating",
	available: "Available",
	stopped: "Stopped",
	creation_failed: "Creation failed",
	disabled: "Disabled",
} satisfies Record<AgentApplicationProjectionV1["status"], string>;
