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

export function agentServiceAvailabilityLabel(
	availability: NonNullable<AgentProjectionV2["serviceAvailability"]>,
) {
	if (availability === "starting") return "启动中";
	if (availability === "updating") return "更新中";
	if (availability === "unavailable") return "暂时不可用";
	return "就绪";
}

export function agentSourceLabel(agent: Pick<AgentProjectionV2, "source">) {
	return agent.source.kind === "standard"
		? `标准模板 · ${agent.source.templateId}`
		: "自定义 Agent";
}

export function agentConversationSourceLabel(
	agent:
		| Pick<AgentProjectionV2, "source">
		| Pick<AgentApplicationProjectionV2, "source">,
) {
	return agent.source.kind === "standard"
		? `标准模板 · ${agent.source.templateId}`
		: agent.source.interactionMode === "self-managed"
			? "自定义 Agent · 自有交互入口"
			: "自定义 Agent · 平台交互入口";
}

export function agentIdentityResponsibilityLabel(
	agent:
		| Pick<AgentProjectionV2, "source">
		| Pick<AgentApplicationProjectionV2, "source">,
) {
	return agent.source.kind === "custom" &&
		agent.source.interactionMode === "self-managed" &&
		agent.source.identityResponsibility === "self-managed"
		? "由自有入口校验"
		: "由平台校验";
}
