import { createFileRoute } from "@tanstack/react-router";
import { isRetryableAgentDiscoveryError } from "../../features/agent-discovery/agent-discovery.js";
import {
	AgentDiscoveryScreen,
	agentDiscoveryQueryMaxLength,
} from "../../features/agent-discovery/agent-discovery-screen.js";
import { useAgentDiscovery } from "../../features/agent-discovery/use-agent-discovery.js";
import { safeDeploymentUrl } from "../../features/application-shell.js";

export const Route = createFileRoute("/agents/")({
	validateSearch: (
		search: Record<string, unknown>,
	): { q?: string; mode?: "conversation" } => ({
		q:
			typeof search.q === "string" &&
			search.q.length <= agentDiscoveryQueryMaxLength
				? search.q
				: undefined,
		mode: search.mode === "conversation" ? "conversation" : undefined,
	}),
	component: AgentsRoute,
});

function AgentsRoute() {
	const { q, mode } = Route.useSearch();
	const navigate = Route.useNavigate();
	const query = useAgentDiscovery();
	const retryable = query.isError
		? isRetryableAgentDiscoveryError(query.error)
		: query.data?.kind === "unavailable" && query.data.retryable;
	return (
		<main className="platform-content management-content ia-agent-directory">
			<div className="space-y-6">
				<AgentDiscoveryScreen
					connectionUrl={safeDeploymentUrl(import.meta.env.VITE_CONNECTION_URL)}
					conversationSelection={mode === "conversation"}
					query={q ?? ""}
					onQueryChange={(nextQuery) => {
						void navigate({
							search: { q: nextQuery || undefined, mode },
							replace: true,
							resetScroll: false,
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
