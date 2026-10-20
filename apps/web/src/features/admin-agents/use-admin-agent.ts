import { useQuery } from "@tanstack/react-query";
import { pollWhileTransitioning } from "../agent-discovery/use-agent-detail.js";
import { loadAdminAgent } from "./admin-agents.js";

/**
 * 系统管理员读取单个 Agent 的服务端管理员投影（#3033）。只在调用方确认当前会话是系统管理员、
 * 且按使用范围读不到时启用；授权仍由服务端每次重新判断。
 * 查询键在 ["agents", agentId] 之下：生命周期命令失效 ["agents"] 时一并重读。
 */
export function useAdminAgent(agentId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["agents", agentId, "administrator"],
		queryFn: ({ signal }) => loadAdminAgent(agentId, undefined, signal),
		enabled,
		retry: false,
		refetchInterval: pollWhileTransitioning,
	});
}
