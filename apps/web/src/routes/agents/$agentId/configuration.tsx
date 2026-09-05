import { createFileRoute, Link } from "@tanstack/react-router";

import { AgentConfigurationWorkflow } from "../../../features/agent-configuration/agent-configuration-workflow.js";
import { useAgentDetail } from "../../../features/agent-discovery/use-agent-detail.js";

export const Route = createFileRoute("/agents/$agentId/configuration")({
	component: AgentConfigurationRoute,
});

function AgentConfigurationRoute() {
	const { agentId } = Route.useParams();
	const query = useAgentDetail(agentId);
	if (query.isPending) {
		return <p aria-live="polite">Loading configuration...</p>;
	}
	if (query.isError || !query.data || query.data.kind !== "ready") {
		return (
			<main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
				<section
					aria-labelledby="agent-configuration-heading"
					className="space-y-4"
				>
					<h1
						id="agent-configuration-heading"
						className="font-semibold text-2xl text-slate-950"
					>
						Configuration is unavailable
					</h1>
					<p className="text-slate-600" role="alert">
						Please try again shortly.
					</p>
					<Link
						className="inline-flex min-h-11 items-center text-slate-700 text-sm underline underline-offset-4"
						params={{ agentId }}
						to="/agents/$agentId"
					>
						Back to Agent
					</Link>
				</section>
			</main>
		);
	}

	return (
		<main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
			<AgentConfigurationWorkflow agent={query.data.agent} />
		</main>
	);
}
