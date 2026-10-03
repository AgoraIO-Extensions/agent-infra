import type {
	AgentApplicationProjectionV2,
	AgentProjectionV2,
} from "../pilot/generated-v2/types.gen.js";

export const agentManagementStatusLabels = {
	pending_approval: "待审批",
	withdrawn: "已撤回",
	rejected: "已驳回",
	creating: "创建中",
	available: "可用",
	stopped: "已停止",
	creation_failed: "创建失败",
	disabled: "已停用",
} satisfies Record<
	| AgentApplicationProjectionV2["status"]
	| AgentProjectionV2["managementStatus"],
	string
>;
