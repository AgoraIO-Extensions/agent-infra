import { useQuery } from "@tanstack/react-query";

import { type PollingQueryState, pollWhileShown } from "../background-read.js";
import {
	type AgentDetailState,
	type AgentDetailViewState,
	isRetryableAgentDiscoveryError,
	loadAgentDetail,
	loadAgentDetailView,
} from "./agent-discovery.js";

/**
 * 创建、启动或更新期间每 2 秒重读一次，其余状态不轮询；管理员单项读取同样使用（#3033）。
 * 以最近一次读到的 Agent 判断：轮询遇到可重试的失败（503、网络中断）后继续按原节奏重读，读到就绪即停止
 * （#3418 N14-04）；不可重试的结果（无权、不存在、响应无效）停止。
 */
export function pollWhileTransitioning(
	query: PollingQueryState<AgentDetailState | AgentDetailViewState>,
) {
	return pollWhileShown(query, isRetryableAgentDiscoveryError, (state) =>
		state.kind === "ready" &&
		(state.agent.managementStatus === "creating" ||
			state.agent.serviceAvailability === "starting" ||
			state.agent.serviceAvailability === "updating")
			? 2000
			: false,
	);
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
