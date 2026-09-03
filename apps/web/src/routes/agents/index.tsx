import { createFileRoute } from "@tanstack/react-router";

import { AgentDiscoveryScreen } from "../../features/agent-discovery/agent-discovery-screen.js";
import { useAgentDiscovery } from "../../features/agent-discovery/use-agent-discovery.js";

export const Route = createFileRoute("/agents/")({
	component: AgentsRoute,
});

function AgentsRoute() {
	const query = useAgentDiscovery();

	return (
		<main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
			<AgentDiscoveryScreen
				state={
					query.isPending
						? { kind: "loading" }
						: query.isError || !query.data
							? { kind: "unavailable", retryable: true }
							: query.data
				}
			/>
		</main>
	);
}
