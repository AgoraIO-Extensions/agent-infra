import { useQuery } from "@tanstack/react-query";

import { loadBrowserSession } from "./agent-administration.js";

export function useBrowserSession() {
	const query = useQuery({
		queryKey: ["browser-session"],
		queryFn: () => loadBrowserSession(),
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
