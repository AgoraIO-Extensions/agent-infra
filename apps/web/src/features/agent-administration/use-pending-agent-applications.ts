import { useQuery } from "@tanstack/react-query";

import {
	isRetryableAgentAdministrationError,
	loadPendingAgentApplications,
} from "./agent-administration.js";

export function usePendingAgentApplications() {
	const query = useQuery({
		queryKey: ["admin", "agent-applications"],
		queryFn: () => loadPendingAgentApplications(),
		retry: false,
	});

	return {
		...query,
		state: query.isPending
			? ({ kind: "loading" } as const)
			: query.isError || !query.data
				? ({
						kind: "unavailable",
						retryable:
							(query.isError &&
								isRetryableAgentAdministrationError(query.error)) ||
							false,
					} as const)
				: query.data,
	};
}
