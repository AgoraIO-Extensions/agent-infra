import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";

import { AgentSkillBindingScreen } from "../../../features/agent-configuration/agent-skill-binding-screen.js";
import { isRetryableAgentDiscoveryError } from "../../../features/agent-discovery/agent-discovery.js";
import { useAgentDetail } from "../../../features/agent-discovery/use-agent-detail.js";
import { PageLoadingState } from "../../../features/page-loading-state.js";
import { ReadFailureCard } from "../../../features/page-state-card.js";
import { useBrowserSession } from "../../../features/use-browser-session.js";

export const Route = createFileRoute("/agents/$agentId/skills")({
	component: AgentSkillsRoute,
});

/** Agent 的 Skill 页（O-02）：从 Owner 配置「管理 Skill 绑定」进入。 */
function AgentSkillsRoute() {
	const { agentId } = Route.useParams();
	const query = useAgentDetail(agentId);
	const session = useBrowserSession();
	if (query.isPending) {
		return (
			<main className="platform-content management-content">
				<PageLoadingState title="Agent 的 Skill" message="正在读取 Agent…" />
			</main>
		);
	}
	if (query.isError || query.data?.kind !== "ready") {
		const failure =
			!query.isError && query.data?.kind === "unavailable"
				? query.data
				: {
						retryable: query.isError
							? isRetryableAgentDiscoveryError(query.error)
							: false,
					};
		return (
			<main className="platform-content management-content">
				<section aria-labelledby="agent-skill-heading">
					<header className="page-heading">
						<div>
							<h1 id="agent-skill-heading">Agent 的 Skill</h1>
						</div>
					</header>
					{/* 与 Agent 详情、Owner 配置共用读取结果与状态卡映射（P-01）。 */}
					<ReadFailureCard
						failure={failure}
						deniedDescription="Agent 不存在，或你没有访问权限。"
						unavailableDescription="暂时无法读取 Agent，请稍后重试。"
						back={
							<Link
								activeOptions={{ exact: true }}
								className={buttonVariants({ variant: "outline" })}
								to="/agents"
							>
								返回 Agent 目录
							</Link>
						}
						onRetry={() => void query.refetch()}
						onStillValid={() => void query.refetch()}
						retrying={query.isFetching}
						retryLabel="重新加载 Agent"
					/>
				</section>
			</main>
		);
	}
	return (
		<main className="platform-content management-content">
			<AgentSkillBindingScreen
				agent={query.data.agent}
				// Agent 与配置投影尚未返回当前 Agent Version（O-02 待确认 1）：不发绑定请求，
				// 也不让用户手填；契约补齐后从投影传入。
				agentVersion={null}
				session={session.state}
				onRefreshAgent={() => void query.refetch()}
			/>
		</main>
	);
}
