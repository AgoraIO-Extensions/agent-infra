import { useQuery } from "@tanstack/react-query";

import { loadAgentDetail } from "./agent-discovery.js";

export function useAgentDetail(agentId: string) {
	return useQuery({
		queryKey: ["agents", agentId],
		queryFn: () => loadAgentDetail(agentId),
	});
}
