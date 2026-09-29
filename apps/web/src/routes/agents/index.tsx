import { createFileRoute } from "@tanstack/react-router";
import { isRetryableAgentDiscoveryError } from "../../features/agent-discovery/agent-discovery.js";
import {
	AgentDiscoveryScreen,
	agentDiscoveryQueryMaxLength,
} from "../../features/agent-discovery/agent-discovery-screen.js";
import { useAgentDiscovery } from "../../features/agent-discovery/use-agent-discovery.js";

export const Route = createFileRoute("/agents/")({
	validateSearch: (search: Record<string, unknown>): { q?: string } => ({
		q:
			typeof search.q === "string" &&
			search.q.length <= agentDiscoveryQueryMaxLength
				? search.q
				: undefined,
	}),
	component: AgentsRoute,
});

function AgentsRoute() {
	const { q } = Route.useSearch();
	const navigate = Route.useNavigate();
	const query = useAgentDiscovery();
	const retryable =
		isRetryableAgentDiscoveryError(query.error) ||
		(query.data?.kind === "unavailable" && query.data.retryable);
	return (
		<main className="platform-content management-content">
			<div className="space-y-6">
				<AgentDiscoveryScreen
					query={q ?? ""}
					onQueryChange={(nextQuery) => {
						void navigate({
							search: { q: nextQuery || undefined },
							replace: true,
						});
					}}
					state={
						query.isPending
							? { kind: "loading" }
							: query.isError || !query.data
								? { kind: "unavailable", retryable }
								: query.data
					}
					onRetry={() => void query.refetch()}
					retrying={query.isFetching}
				/>
			</div>
		</main>
	);
}
