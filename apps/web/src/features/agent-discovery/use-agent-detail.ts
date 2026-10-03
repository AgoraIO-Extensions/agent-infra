import { useQuery } from "@tanstack/react-query";

import { loadAgentDetail } from "./agent-discovery.js";

export function useAgentDetail(agentId: string) {
	return useQuery({
		queryKey: ["agents", agentId],
		queryFn: () => loadAgentDetail(agentId),
		retry: false,
		refetchInterval: (query) => {
			const state = query.state.data;
			if (query.state.status !== "success" || state?.kind !== "ready")
				return false;
			return state.agent.managementStatus === "creating" ||
				state.agent.serviceAvailability === "starting" ||
				state.agent.serviceAvailability === "updating"
				? 2000
				: false;
		},
	});
}
