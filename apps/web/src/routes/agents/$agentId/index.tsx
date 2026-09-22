import { createFileRoute } from "@tanstack/react-router";
import { isAgentConfigurationOwner } from "../../../features/agent-configuration/agent-configuration.js";
import { AgentDetailScreen } from "../../../features/agent-discovery/agent-detail-screen.js";
import { useAgentDetail } from "../../../features/agent-discovery/use-agent-detail.js";
import { useBrowserSession } from "../../../features/use-browser-session.js";

export const Route = createFileRoute("/agents/$agentId/")({
	component: AgentDetailRoute,
});

function AgentDetailRoute() {
	const { agentId } = Route.useParams();
	const query = useAgentDetail(agentId);
	const session = useBrowserSession();
	const agent = query.data?.kind === "ready" ? query.data.agent : undefined;
	const canManage =
		agent &&
		session.state.kind === "ready" &&
		(isAgentConfigurationOwner(agent, session.state.session) ||
			session.state.session.user.roles.includes("system_admin"));
	const ownerSettings = canManage ? { agentId } : undefined;

	return (
		<main className="platform-content management-content">
			<div className="space-y-6">
				<AgentDetailScreen
					state={
						query.isPending
							? { kind: "loading" }
							: query.isError || !query.data
								? { kind: "unavailable", retryable: true }
								: query.data
					}
					ownerSettings={ownerSettings}
				/>
			</div>
		</main>
	);
}
