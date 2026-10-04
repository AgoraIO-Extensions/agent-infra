import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";

import { AgentConfigurationWorkflow } from "../../../features/agent-configuration/agent-configuration-workflow.js";
import { isRetryableAgentDiscoveryError } from "../../../features/agent-discovery/agent-discovery.js";
import { useAgentDetail } from "../../../features/agent-discovery/use-agent-detail.js";
import { PageLoadingState } from "../../../features/page-loading-state.js";

export const Route = createFileRoute("/agents/$agentId/configuration")({
	component: AgentConfigurationRoute,
});

function AgentConfigurationRoute() {
	const { agentId } = Route.useParams();
	const query = useAgentDetail(agentId);
	const retryable = query.isError
		? isRetryableAgentDiscoveryError(query.error)
		: query.data?.kind === "unavailable" && query.data.retryable;
	if (query.isPending) {
		return (
			<main className="platform-content management-content">
				<PageLoadingState title="Owner 配置" message="正在读取配置…" />
			</main>
		);
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
					<Alert>
						<AlertDescription>
							{retryable ? "请稍后重试。" : "请联系管理员。"}
						</AlertDescription>
					</Alert>
					{retryable ? (
						<Button
							variant="outline"
							disabled={query.isFetching}
							onClick={() => void query.refetch()}
							type="button"
						>
							<RefreshCw aria-hidden="true" data-icon="inline-start" />
							{query.isFetching ? "正在重新加载…" : "重新加载配置"}
						</Button>
					) : null}
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
