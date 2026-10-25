import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";

import { isAgentConfigurationOwner } from "../../../features/agent-configuration/agent-configuration.js";
import { AgentSkillBindingScreen } from "../../../features/agent-configuration/agent-skill-binding-screen.js";
import { isRetryableAgentDiscoveryError } from "../../../features/agent-discovery/agent-discovery.js";
import { useAgentDetail } from "../../../features/agent-discovery/use-agent-detail.js";
import { readFailed } from "../../../features/background-read.js";
import { PageLoadingState } from "../../../features/page-loading-state.js";
import { ReadFailureCard } from "../../../features/page-state-card.js";
import { readSkillHubAgentCurrentVersion } from "../../../features/skill-hub/skill-hub-management.js";
import { useBrowserSession } from "../../../features/use-browser-session.js";

export const Route = createFileRoute("/agents/$agentId/skills")({
	component: AgentSkillsRoute,
});

/** Agent 的 Skill 页（O-02）：从 Owner 配置「管理 Skill 绑定」进入。 */
function AgentSkillsRoute() {
	const { agentId } = Route.useParams();
	const query = useAgentDetail(agentId);
	const session = useBrowserSession();
	const agent = query.data?.kind === "ready" ? query.data.agent : undefined;
	// 当前 Agent Version 只对当前 Owner 返回（#2903）：确认是 Owner 后才读取，
	// 纯管理员与员工不发请求。读取失败时 agentVersion 为 null，页面沿用原状态卡。
	const isOwner =
		agent !== undefined &&
		session.state.kind === "ready" &&
		isAgentConfigurationOwner(agent, session.state.session);
	const currentVersion = useQuery({
		queryKey: ["agents", agentId, "skills", "current-version"],
		queryFn: () => readSkillHubAgentCurrentVersion(agentId),
		enabled: isOwner,
		retry: false,
	});
	if (query.isPending) {
		return (
			<main className="platform-content management-content">
				<PageLoadingState title="Agent 的 Skill" message="正在读取 Agent…" />
			</main>
		);
	}
	// 后台重读（回到标签页、绑定轮询时的 Agent 重读）的可重试失败不替换页面（#3387）。
	const failed = readFailed(query, isRetryableAgentDiscoveryError);
	if (failed || query.data?.kind !== "ready") {
		const failure =
			!failed && query.data?.kind === "unavailable"
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
				// 绑定读写路径只使用服务端给出的当前版本，不让用户手填。
				agentVersion={currentVersion.data?.agentVersion ?? null}
				agentVersionPending={isOwner && currentVersion.isPending}
				session={session.state}
				onRefreshAgent={() => void query.refetch()}
			/>
		</main>
	);
}
