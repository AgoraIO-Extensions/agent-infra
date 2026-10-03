import { createFileRoute } from "@tanstack/react-router";
import { AdminAgentApplicationsWorkflow } from "../../features/agent-administration/admin-agent-applications-workflow.js";

export const Route = createFileRoute("/admin/approvals")({
	component: AdminApprovalsRoute,
});

function AdminApprovalsRoute() {
	return (
		<main className="platform-content management-content">
			<AdminAgentApplicationsWorkflow />
		</main>
	);
}
