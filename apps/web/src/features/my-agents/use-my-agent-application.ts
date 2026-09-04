import { useQuery } from "@tanstack/react-query";

import { loadMyAgentApplication } from "./my-agent-applications.js";

export function useMyAgentApplication(applicationId: string) {
	return useQuery({
		queryKey: ["my-agents", applicationId],
		queryFn: () => loadMyAgentApplication(applicationId),
	});
}
