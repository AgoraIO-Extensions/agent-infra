import { useQuery } from "@tanstack/react-query";

import { loadAgentDiscovery } from "./agent-discovery.js";

export function useAgentDiscovery() {
	return useQuery({
		queryKey: ["agents"],
		queryFn: loadAgentDiscovery,
	});
}
