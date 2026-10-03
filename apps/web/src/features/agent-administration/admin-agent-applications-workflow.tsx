import { useApplicationSession } from "../application-shell.js";
import { AdminAgentApplicationsScreen } from "./admin-agent-applications-screen.js";
import { useAgentApplicationDecision } from "./use-agent-application-decision.js";
import { usePendingAgentApplications } from "./use-pending-agent-applications.js";

export function AdminAgentApplicationsWorkflow() {
	const { identityKey, session } = useApplicationSession();
	const applications = usePendingAgentApplications({
		identityKey,
		enabled: session.user.roles.includes("system_admin"),
	});
	const decision = useAgentApplicationDecision();

	return (
		<AdminAgentApplicationsScreen
			decisionError={decision.error}
			decisionResult={decision.data}
			onDecision={(applicationId, nextDecision) =>
				decision.mutate(applicationId, nextDecision)
			}
			pendingDecision={decision.isPending ? decision.variables : undefined}
			session={{ kind: "ready", session }}
			state={applications.state}
			onRetry={() => void applications.refetch()}
			retrying={applications.isFetching}
		/>
	);
}
