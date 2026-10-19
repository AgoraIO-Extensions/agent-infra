import { createFileRoute } from "@tanstack/react-router";
import { isAgentConfigurationOwner } from "../../../features/agent-configuration/agent-configuration.js";
import { AgentDetailScreen } from "../../../features/agent-discovery/agent-detail-screen.js";
import { isRetryableAgentDiscoveryError } from "../../../features/agent-discovery/agent-discovery.js";
import { useAgentDetail } from "../../../features/agent-discovery/use-agent-detail.js";
import { connectionEntryUrl } from "../../../features/connection-entry.js";
import { useTemplateNameLookup } from "../../../features/template-display-name.js";
import { useBrowserSession } from "../../../features/use-browser-session.js";

export const Route = createFileRoute("/agents/$agentId/")({
	component: AgentDetailRoute,
});

function AgentDetailRoute() {
	const { agentId } = Route.useParams();
	const query = useAgentDetail(agentId);
	const session = useBrowserSession();
	const templateName = useTemplateNameLookup();
	const retryable = query.isError
		? isRetryableAgentDiscoveryError(query.error)
		: query.data?.kind === "unavailable" && query.data.retryable;
	const agent = query.data?.kind === "ready" ? query.data.agent : undefined;
	const canManage =
		agent &&
		session.state.kind === "ready" &&
		(isAgentConfigurationOwner(agent, session.state.session) ||
			session.state.session.user.roles.includes("system_admin"));
	const ownerSettings = canManage ? { agentId } : undefined;
	// 「可用 Skill」指向 Agent 的 Skill 页，该页只对当前 Owner 开放（D-03）。
	const skillBindings =
		agent &&
		session.state.kind === "ready" &&
		isAgentConfigurationOwner(agent, session.state.session)
			? { agentId }
			: undefined;
	// 与壳层「我的 Connection」同一个入口函数；会话未就绪时没有入口（D-01）。
	const connectionUrl =
		session.state.kind === "ready"
			? connectionEntryUrl(session.state.connection)
			: undefined;

	return (
		<main className="platform-content management-content">
			<div className="space-y-6">
				<AgentDetailScreen
					state={
						query.isPending
							? { kind: "loading" }
							: query.isError || !query.data
								? { kind: "unavailable", retryable }
								: query.data
					}
					browserCapability={agent?.capabilities.browser}
					connectionUrl={connectionUrl}
					onRetry={() => void query.refetch()}
					retrying={query.isFetching}
					ownerSettings={ownerSettings}
					skillBindings={skillBindings}
					templateName={templateName}
				/>
			</div>
		</main>
	);
}
