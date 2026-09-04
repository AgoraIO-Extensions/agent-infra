import { useQuery } from "@tanstack/react-query";

import { loadMyAgentApplications } from "./my-agent-applications.js";

export function useMyAgentApplications() {
	return useQuery({
		queryKey: ["my-agents"],
		queryFn: () => loadMyAgentApplications(),
	});
}
