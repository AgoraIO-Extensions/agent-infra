import { useQuery } from "@tanstack/react-query";

import { loadAgentAvailability } from "./agent-configuration.js";

/**
 * Owner 读取完整可用范围（含独立应用，Spec §9.2.2）。读不到时页面按旧行为只编辑人员条目，
 * 保存走 V2，服务端原样保留应用条目。窗口聚焦不重读，避免覆盖正在编辑的草稿。
 */
export function useAgentAvailabilityScope(agentId: string, enabled: boolean) {
	return useQuery({
		enabled,
		queryFn: () => loadAgentAvailability(agentId),
		queryKey: ["agents", agentId, "availability"],
		refetchOnWindowFocus: false,
		retry: false,
	});
}
