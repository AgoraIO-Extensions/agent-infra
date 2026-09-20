import { useQuery } from "@tanstack/react-query";
import type { AgentDiscoveryScope } from "./agent-discovery.js";
import { loadAgentDiscovery } from "./agent-discovery.js";

export function useAgentDiscovery(scope: AgentDiscoveryScope = "visible") {
	return useQuery({
		queryKey: ["agents", scope],
		queryFn: () => loadAgentDiscovery(undefined, scope),
	});
}
