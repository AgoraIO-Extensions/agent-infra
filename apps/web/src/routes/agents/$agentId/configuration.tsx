import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";

import { useAdminAgent } from "../../../features/admin-agents/use-admin-agent.js";
import { AgentConfigurationWorkflow } from "../../../features/agent-configuration/agent-configuration-workflow.js";
import { isRetryableAgentDiscoveryError } from "../../../features/agent-discovery/agent-discovery.js";
import { useAgentDetail } from "../../../features/agent-discovery/use-agent-detail.js";
import { useApplicationSession } from "../../../features/application-shell.js";
import { projectDeploymentConfiguration } from "../../../features/my-agents/deployment-configuration.js";
import { useDeploymentConfiguration } from "../../../features/my-agents/use-deployment-configuration.js";
import { PageLoadingState } from "../../../features/page-loading-state.js";
import { ReadFailureCard } from "../../../features/page-state-card.js";

export const Route = createFileRoute("/agents/$agentId/configuration")({
	component: AgentConfigurationRoute,
});

function AgentConfigurationRoute() {
	const { agentId } = Route.useParams();
	const { session } = useApplicationSession();
	const visible = useAgentDetail(agentId);
	// 系统管理员不在使用范围内时，按使用范围读取得到 403/404（合并为无原因的不可访问）；
	// 这时改读服务端管理员投影，不扩大普通读取，也不在页面合成 Owner 等字段（#3033）。
	// 非管理员不发出管理员读取，服务端也会拒绝。
	const administratorProjection =
		session.user.roles.includes("system_admin") &&
		visible.data?.kind === "unavailable" &&
		!visible.data.retryable &&
		visible.data.reason === undefined;
	const administrator = useAdminAgent(agentId, administratorProjection);
	const query = administratorProjection ? administrator : visible;
	const deployment = useDeploymentConfiguration();
	const retryable = query.isError
		? isRetryableAgentDiscoveryError(query.error)
		: query.data?.kind === "unavailable" && query.data.retryable;
	if (visible.isPending || query.isPending || deployment.isPending) {
		return (
			<main className="platform-content management-content">
				<PageLoadingState title="Owner 配置" message="正在读取配置…" />
			</main>
		);
	}
	const { configuration: deploymentConfiguration } =
		projectDeploymentConfiguration(
			deployment.data,
			deployment.error,
			deployment.isError,
		);
	const deploymentModelCandidates =
		deploymentConfiguration.modelCatalog.status === "populated"
			? deploymentConfiguration.modelCatalog.endpoints.flatMap((endpoint) =>
					endpoint.models.map((model) => ({
						endpointId: endpoint.endpointId,
						modelId: model.modelId,
						reasoningLevels: model.reasoningLevels,
					})),
				)
			: undefined;
	// 端点显示名用于模型选择与摘要，页面不显示原始端点 ID（RK2-01）。
	const endpointNames = Object.fromEntries(
		deploymentConfiguration.modelCatalog.status === "populated"
			? deploymentConfiguration.modelCatalog.endpoints.map((endpoint) => [
					endpoint.endpointId,
					endpoint.displayName,
				])
			: [],
	);
	if (query.isError || !query.data || query.data.kind !== "ready") {
		const failure =
			!query.isError && query.data?.kind === "unavailable"
				? query.data
				: { retryable };
		return (
			<main className="platform-content management-content">
				<section aria-labelledby="agent-configuration-heading">
					<header className="page-heading">
						<div>
							<h1 id="agent-configuration-heading">Owner 配置</h1>
						</div>
					</header>
					{/* 与 Agent 详情共用读取结果与状态卡映射（P-01）。 */}
					<ReadFailureCard
						failure={failure}
						deniedDescription="Agent 不存在，或你没有访问权限。"
						unavailableDescription="暂时无法读取 Owner 配置，请稍后重试。"
						back={
							administratorProjection ? (
								// 管理员读取也失败：Agent 详情对其同样不可见，返回 Agent 管理（#3033）。
								<Link
									activeOptions={{ exact: true }}
									className={buttonVariants({ variant: "outline" })}
									to="/admin/agents"
								>
									返回 Agent 管理
								</Link>
							) : (
								<Link
									activeOptions={{ exact: true }}
									className={buttonVariants({ variant: "outline" })}
									params={{ agentId }}
									to="/agents/$agentId"
								>
									返回 Agent 详情
								</Link>
							)
						}
						onRetry={() => void query.refetch()}
						onStillValid={() => void query.refetch()}
						retrying={query.isFetching}
						retryLabel="重新加载配置"
					/>
				</section>
			</main>
		);
	}

	const agent = query.data.agent;
	// 标准模板只开放模板登记的环境变量与 Secret 键（PRD §5.5）；模板未读取到时名称自由输入，
	// 由服务端校验。
	const template =
		agent.source.kind === "standard"
			? deploymentConfiguration.templates.find(
					(item) =>
						agent.source.kind === "standard" &&
						item.templateId === agent.source.templateId,
				)
			: undefined;

	return (
		<main className="platform-content management-content">
			<AgentConfigurationWorkflow
				agent={agent}
				administratorProjection={administratorProjection}
				allowedEnvironmentKeys={template?.allowedEnvironmentKeys}
				allowedSecretKeys={template?.allowedSecretKeys}
				deploymentModelCandidates={deploymentModelCandidates}
				endpointNames={endpointNames}
			/>
		</main>
	);
}
