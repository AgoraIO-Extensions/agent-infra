import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";

import { AgentConfigurationWorkflow } from "../../../features/agent-configuration/agent-configuration-workflow.js";
import { useAgentDetail } from "../../../features/agent-discovery/use-agent-detail.js";

export const Route = createFileRoute("/agents/$agentId/configuration")({
	component: AgentConfigurationRoute,
});

function AgentConfigurationRoute() {
	const { agentId } = Route.useParams();
	const query = useAgentDetail(agentId);
	if (query.isPending) {
		return <p aria-live="polite">正在读取配置…</p>;
	}
	if (query.isError || !query.data || query.data.kind !== "ready") {
		return (
			<main className="platform-content management-content">
				<section
					aria-labelledby="agent-configuration-heading"
					className="space-y-4"
				>
					<h1
						id="agent-configuration-heading"
						className="font-semibold text-2xl text-foreground"
					>
						配置暂不可用
					</h1>
					<p className="text-muted-foreground" role="alert">
						请稍后重试。
					</p>
					<Link
						className={buttonVariants({ variant: "link", className: "px-0" })}
						params={{ agentId }}
						to="/agents/$agentId"
					>
						返回 Agent 详情
					</Link>
				</section>
			</main>
		);
	}

	return (
		<main className="platform-content management-content">
			<AgentConfigurationWorkflow agent={query.data.agent} />
		</main>
	);
}
