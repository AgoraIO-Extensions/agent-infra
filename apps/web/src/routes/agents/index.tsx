import { createFileRoute, Link } from "@tanstack/react-router";

import { useBrowserSession } from "../../features/agent-administration/use-browser-session.js";
import { AgentDiscoveryScreen } from "../../features/agent-discovery/agent-discovery-screen.js";
import { useAgentDiscovery } from "../../features/agent-discovery/use-agent-discovery.js";

export const Route = createFileRoute("/agents/")({
	component: AgentsRoute,
});

function AgentsRoute() {
	const query = useAgentDiscovery();
	const session = useBrowserSession();
	const canReviewApplications =
		session.state.kind === "ready" &&
		session.state.session.user.roles.includes("system_admin");

	return (
		<main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
			<div className="space-y-6">
				{canReviewApplications ? (
					<nav aria-label="Administrator navigation">
						<Link
							className="inline-flex min-h-11 items-center text-slate-700 text-sm underline underline-offset-4"
							to="/admin/approvals"
						>
							Agent approvals
						</Link>
					</nav>
				) : null}
				<AgentDiscoveryScreen
					state={
						query.isPending
							? { kind: "loading" }
							: query.isError || !query.data
								? { kind: "unavailable", retryable: true }
								: query.data
					}
				/>
			</div>
		</main>
	);
}
