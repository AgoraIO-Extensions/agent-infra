import { createFileRoute } from "@tanstack/react-router";

import { AgentLifecycleWorkflow } from "../../features/agent-administration/agent-lifecycle-workflow.js";
import { useBrowserSession } from "../../features/agent-administration/use-browser-session.js";
import { isAgentConfigurationOwner } from "../../features/agent-configuration/agent-configuration.js";
import { AgentDetailScreen } from "../../features/agent-discovery/agent-detail-screen.js";
import { useAgentDetail } from "../../features/agent-discovery/use-agent-detail.js";

export const Route = createFileRoute("/agents/$agentId")({
	component: AgentDetailRoute,
});

function AgentDetailRoute() {
	const { agentId } = Route.useParams();
	const query = useAgentDetail(agentId);
	const session = useBrowserSession();
	const agent = query.data?.kind === "ready" ? query.data.agent : undefined;
	const ownerSettings =
		agent &&
		session.state.kind === "ready" &&
		isAgentConfigurationOwner(agent, session.state.session)
			? { agentId }
			: undefined;

	return (
		<main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
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
				{agent ? <AgentLifecycleWorkflow agent={agent} /> : null}
			</div>
		</main>
	);
}
