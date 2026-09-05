import { useQuery } from "@tanstack/react-query";

import { loadPendingAgentApplications } from "./agent-administration.js";

export function usePendingAgentApplications() {
	const query = useQuery({
		queryKey: ["admin", "agent-applications"],
		queryFn: () => loadPendingAgentApplications(),
	});

	return {
		...query,
		state: query.isPending
			? ({ kind: "loading" } as const)
			: query.isError || !query.data
				? ({ kind: "unavailable", retryable: true } as const)
				: query.data,
	};
}
