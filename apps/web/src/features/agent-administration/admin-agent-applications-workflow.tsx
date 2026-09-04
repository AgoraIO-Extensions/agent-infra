import { AdminAgentApplicationsScreen } from "./admin-agent-applications-screen.js";
import { useAgentApplicationDecision } from "./use-agent-application-decision.js";
import { useBrowserSession } from "./use-browser-session.js";
import { usePendingAgentApplications } from "./use-pending-agent-applications.js";

export function AdminAgentApplicationsWorkflow() {
	const session = useBrowserSession();
	const applications = usePendingAgentApplications();
	const decision = useAgentApplicationDecision();

	return (
		<AdminAgentApplicationsScreen
			decisionError={decision.error}
			decisionResult={decision.data}
			onDecision={(applicationId, nextDecision) =>
				decision.mutate(applicationId, nextDecision)
			}
			pendingDecision={decision.isPending ? decision.variables : undefined}
			session={session.state}
			state={applications.state}
		/>
	);
}
