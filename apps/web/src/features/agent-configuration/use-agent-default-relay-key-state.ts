import { useQuery } from "@tanstack/react-query";

import { loadAgentDefaultRelayKey } from "./agent-configuration.js";

/**
 * Owner 才能读取默认 Key 状态。`isSet` 为真说明该 Agent 由默认 Key 管理模型（配置 V3）：
 * 更换模型集合必须重新提交 Key；读取失败时按未托管处理，页面保持原有行为（#2421）。
 */
export function useAgentDefaultRelayKeyState(
	agentId: string,
	enabled: boolean,
) {
	return useQuery({
		enabled,
		queryFn: () => loadAgentDefaultRelayKey(agentId),
		queryKey: ["agents", agentId, "default-relay-key"],
		retry: false,
	});
}
