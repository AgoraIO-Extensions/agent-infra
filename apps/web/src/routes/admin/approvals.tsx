import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";

import { AdminAgentApplicationsWorkflow } from "../../features/agent-administration/admin-agent-applications-workflow.js";

export const Route = createFileRoute("/admin/approvals")({
	component: AdminApprovalsRoute,
});

function AdminApprovalsRoute() {
	return (
		<main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
			<div className="space-y-6">
				<nav aria-label="Agent navigation">
					<Link
						className={buttonVariants({ variant: "link", className: "px-0" })}
						to="/agents"
					>
						Agents
					</Link>
				</nav>
				<AdminAgentApplicationsWorkflow />
			</div>
		</main>
	);
}
