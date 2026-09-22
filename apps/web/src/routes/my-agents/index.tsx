import { createFileRoute } from "@tanstack/react-router";
import { useAgentDiscovery } from "../../features/agent-discovery/use-agent-discovery.js";

import { MyAgentsScreen } from "../../features/my-agents/my-agents-screen.js";
import { useMyAgentApplications } from "../../features/my-agents/use-my-agent-applications.js";

export const Route = createFileRoute("/my-agents/")({
	component: MyAgentsRoute,
});

function MyAgentsRoute() {
	const query = useMyAgentApplications();
	const owned = useAgentDiscovery("owner");

	return (
		<main className="platform-content management-content">
			<MyAgentsScreen
				ownedAgents={
					owned.data?.kind === "ready" ? owned.data.agents : undefined
				}
				ownedAgentsLoading={owned.isPending}
				ownedAgentsUnavailable={
					owned.isError || owned.data?.kind === "unavailable"
				}
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
