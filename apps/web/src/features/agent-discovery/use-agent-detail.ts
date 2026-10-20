import { useQuery } from "@tanstack/react-query";

import {
	type AgentDetailState,
	type AgentDetailViewState,
	loadAgentDetail,
	loadAgentDetailView,
} from "./agent-discovery.js";

/** 创建、启动或更新期间每 2 秒重读一次，其余状态不轮询。 */
function pollWhileTransitioning(query: {
	readonly state: {
		readonly status: string;
		readonly data?: AgentDetailState | AgentDetailViewState;
	};
}) {
	const state = query.state.data;
	if (query.state.status !== "success" || state?.kind !== "ready") return false;
	return state.agent.managementStatus === "creating" ||
		state.agent.serviceAvailability === "starting" ||
		state.agent.serviceAvailability === "updating"
		? 2000
		: false;
}

export function useAgentDetail(agentId: string) {
	return useQuery({
		queryKey: ["agents", agentId],
		queryFn: () => loadAgentDetail(agentId),
		retry: false,
		refetchInterval: pollWhileTransitioning,
	});
}

/**
 * Agent 详情页使用带 Owner 状态的详情投影（#2910）；配置、Skill 等页面仍读 V2 投影。
 * 查询键在 ["agents", agentId] 之下，既有的 ["agents"] 失效同样会刷新它。
 */
export function useAgentDetailView(agentId: string) {
	return useQuery({
		queryKey: ["agents", agentId, "detail"],
		queryFn: () => loadAgentDetailView(agentId),
		retry: false,
		refetchInterval: pollWhileTransitioning,
	});
}
