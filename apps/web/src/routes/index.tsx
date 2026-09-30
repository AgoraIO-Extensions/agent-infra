import { createFileRoute } from "@tanstack/react-router";
import { isRetryableAgentDiscoveryError } from "../features/agent-discovery/agent-discovery.js";
import { useAgentDiscovery } from "../features/agent-discovery/use-agent-discovery.js";
import { useApplicationSession } from "../features/application-shell.js";
import { isRetryableMyAgentApplicationError } from "../features/my-agents/my-agent-applications.js";
import { useMyAgentApplications } from "../features/my-agents/use-my-agent-applications.js";
import { WorkspaceScreen } from "../features/workspace/workspace-screen.js";

export const Route = createFileRoute("/")({
	component: WorkspaceRoute,
});

function WorkspaceRoute() {
	const session = useApplicationSession();
	const agents = useAgentDiscovery();
	const applications = useMyAgentApplications();
	const agentState = agents.isPending
		? ({ kind: "loading" } as const)
		: agents.isError
			? {
					kind: "unavailable" as const,
					retryable: isRetryableAgentDiscoveryError(agents.error),
				}
			: (agents.data ?? { kind: "unavailable", retryable: true as const });
	const applicationState = applications.isPending
		? ({ kind: "loading" } as const)
		: applications.isError
			? {
					kind: "unavailable" as const,
					retryable: isRetryableMyAgentApplicationError(applications.error),
				}
			: (applications.data ?? {
					kind: "unavailable",
					retryable: true as const,
				});
	return (
		<WorkspaceScreen
			agents={agentState}
			applications={applicationState}
			isAdmin={session.session.user.roles.includes("system_admin")}
			onRetryAgents={() => void agents.refetch()}
			onRetryApplications={() => void applications.refetch()}
			retryingAgents={agents.isFetching}
			retryingApplications={applications.isFetching}
		/>
	);
}
