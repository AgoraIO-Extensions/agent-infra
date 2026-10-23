import { AgentCreationFailureProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import { getAgentCreationFailureV1 } from "../../pilot/generated-v2/sdk.gen.js";
import type { AgentCreationFailureCategoryV1 } from "../../pilot/generated-v2/types.gen.js";

/**
 * 创建失败类别的说明（#3034）。类别由服务端按工程 Spec §10.5 推导，只说明 Owner 或系统管理员
 * 下一步能做什么，不展示原因码或部署细节。
 *
 * 「重试创建」对所有类别都保留（PRD §6.3：创建失败后保留再次重试入口）；configuration_rejected
 * 只在调整配置或部署之前重试不会成功（工程 Spec §10.5），说明按这个条件写，不与旁边的「重试创建」
 * 自相矛盾（#3268 N8-2-08）。
 */
export const agentCreationFailureMessages = {
	configuration_rejected: {
		title: "配置与当前部署不兼容",
		description:
			"当前部署不支持这个 Agent 的来源或入口配置（例如未启用平台身份入口），调整配置或部署之前重试创建不会成功。请按部署支持的配置重新申请，或联系系统管理员调整部署后再重试创建。",
	},
	health_check_failed: {
		title: "健康检查未通过",
		description:
			"Agent 已启动，但没有通过健康检查。可以重试创建；多次失败时请检查镜像或联系系统管理员。",
	},
	deployment_unavailable: {
		title: "部署资源暂不可用",
		description:
			"部署资源暂时不可用或没有及时就绪。可以稍后重试创建；多次失败时请联系系统管理员。",
	},
} satisfies Record<
	AgentCreationFailureCategoryV1,
	{ readonly title: string; readonly description: string }
>;

/**
 * 读取一个创建失败 Agent 的失败类别。只有当前 Owner 与系统管理员能读到；其他主体、
 * 状态已变化或读取失败时返回 null，页面不展示任何原因。
 */
export async function loadAgentCreationFailure(
	agentId: string,
	client?: Client,
): Promise<AgentCreationFailureCategoryV1 | null> {
	const result = await getAgentCreationFailureV1({
		...(client ? { client } : {}),
		path: { agentId },
		responseStyle: "fields",
		throwOnError: false,
	});
	if (result.response?.status !== 200) return null;
	const parsed = AgentCreationFailureProjectionV1Schema.safeParse(result.data);
	return parsed.success && parsed.data.agentId === agentId
		? parsed.data.category
		: null;
}

export function useAgentCreationFailure(agentId: string, enabled = true) {
	// 挂在 ["agents", agentId] 下：重试创建等命令让 Agent 查询失效时一并刷新。
	return useQuery({
		queryKey: ["agents", agentId, "creation-failure"],
		queryFn: () => loadAgentCreationFailure(agentId),
		enabled,
		retry: false,
	});
}

/** 只在 Agent 处于创建失败时由调用方渲染；没有可展示的类别时不占位。 */
export function AgentCreationFailureNotice({
	agentId,
	className,
}: {
	agentId: string;
	className?: string;
}) {
	const query = useAgentCreationFailure(agentId);
	const category = query.data;
	if (!category) return null;
	const message = agentCreationFailureMessages[category];
	return (
		<Alert
			className={className}
			data-creation-failure={category}
			role="status"
			tone="danger"
		>
			<AlertTitle>失败原因：{message.title}</AlertTitle>
			<AlertDescription>{message.description}</AlertDescription>
		</Alert>
	);
}
