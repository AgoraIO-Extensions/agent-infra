import type { ChipTone } from "@/lib/status-tone";
import type {
	AgentApplicationProjectionV2,
	AgentProjectionV2,
} from "../pilot/generated-v2/types.gen.js";
import {
	standardTemplateLabel,
	type TemplateNameLookup,
	templateDisplayName,
} from "./template-display-name.js";

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

/**
 * Agent 目录卡与详情页只显示一个可用性状态（设计 statusChip）：管理状态为可用且有服务
 * 可用性时取服务可用性，否则取管理状态。色调按设计：就绪 green，启动中 / 更新中 amber，
 * 创建失败 red（与 Owner 配置、Agent 管理表及申请详情「失败」一致，E3-05），其余 gray。
 * 这是目录、详情与 Owner 配置页头唯一的派生规则，标签或色调调整只改这里。
 */
export function agentAvailabilityStatus(
	agent: Pick<AgentProjectionV2, "managementStatus" | "serviceAvailability">,
): { label: string; tone: ChipTone } {
	if (agent.managementStatus === "available" && agent.serviceAvailability) {
		const availability = agent.serviceAvailability;
		return {
			label: agentServiceAvailabilityLabel(availability),
			tone:
				availability === "ready"
					? "green"
					: availability === "unavailable"
						? "gray"
						: "amber",
		};
	}
	return {
		label: agentManagementStatusLabels[agent.managementStatus],
		tone:
			agent.managementStatus === "available"
				? "green"
				: agent.managementStatus === "creation_failed"
					? "red"
					: "gray",
	};
}

// 标准模板只显示部署配置登记的显示名（templateName），读不到时回落为「标准模板」，
// 不显示原始 templateId（F-02）。
export function agentSourceLabel(
	agent: Pick<AgentProjectionV2, "source">,
	templateName?: TemplateNameLookup,
) {
	return agent.source.kind === "standard"
		? standardTemplateLabel(agent.source.templateId, templateName)
		: "自定义 Agent";
}

export function agentSourceReferenceLabel(
	agent:
		| Pick<AgentProjectionV2, "source">
		| Pick<AgentApplicationProjectionV2, "source">,
	templateName?: TemplateNameLookup,
) {
	if (agent.source.kind === "standard")
		return templateDisplayName(agent.source.templateId, templateName);
	return "imageReference" in agent.source
		? agent.source.imageReference
		: "多服务资源清单";
}

export function agentConversationSourceLabel(
	agent:
		| Pick<AgentProjectionV2, "source">
		| Pick<AgentApplicationProjectionV2, "source">,
	templateName?: TemplateNameLookup,
) {
	return agent.source.kind === "standard"
		? standardTemplateLabel(agent.source.templateId, templateName)
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
