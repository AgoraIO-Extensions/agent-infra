import { type QueryClient, useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import { loadBrowserSession } from "./browser-session.js";

export const BrowserSessionQueryContext = createContext<
	QueryClient | undefined
>(undefined);

export function useBrowserSession() {
	const sessionClient = useContext(BrowserSessionQueryContext);
	const query = useQuery(
		{
			queryKey: ["browser-session"],
			queryFn: () => loadBrowserSession(),
		},
		sessionClient,
	);

	return {
		...query,
		state: query.isPending
			? ({ kind: "loading" } as const)
			: query.isError || !query.data
				? ({ kind: "unavailable", retryable: true } as const)
				: query.data,
	};
}
