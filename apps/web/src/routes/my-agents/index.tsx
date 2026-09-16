import { createFileRoute } from "@tanstack/react-router";
import { isAgentConfigurationOwner } from "../../features/agent-configuration/agent-configuration.js";
import { useAgentDiscovery } from "../../features/agent-discovery/use-agent-discovery.js";
import { useApplicationSession } from "../../features/application-shell.js";

import { MyAgentsScreen } from "../../features/my-agents/my-agents-screen.js";
import { useMyAgentApplications } from "../../features/my-agents/use-my-agent-applications.js";

export const Route = createFileRoute("/my-agents/")({
	component: MyAgentsRoute,
});

function MyAgentsRoute() {
	const query = useMyAgentApplications();
	const discovery = useAgentDiscovery();
	const { session } = useApplicationSession();

	return (
		<main className="platform-content management-content">
			<MyAgentsScreen
				ownedAgents={
					!discovery.isError && discovery.data?.kind === "ready"
						? discovery.data.agents.filter((agent) =>
								isAgentConfigurationOwner(agent, session),
							)
						: undefined
				}
				ownedAgentsLoading={discovery.isPending}
				ownedAgentsUnavailable={
					discovery.isError || discovery.data?.kind === "unavailable"
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
