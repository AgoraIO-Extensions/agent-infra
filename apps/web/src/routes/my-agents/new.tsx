import { createFileRoute } from "@tanstack/react-router";
import { connectionEntryUrl } from "../../features/connection-entry.js";

import {
	AgentApplicationSubmissionScreen,
	createApplicationHeading,
} from "../../features/my-agents/agent-application-submission-screen.js";
import { projectDeploymentConfiguration } from "../../features/my-agents/deployment-configuration.js";
import { useAgentApplicationSubmission } from "../../features/my-agents/use-agent-application-submission.js";
import { useShownDeploymentConfiguration } from "../../features/my-agents/use-deployment-configuration.js";
import { PageLoadingState } from "../../features/page-loading-state.js";
import { useBrowserSession } from "../../features/use-browser-session.js";

export const Route = createFileRoute("/my-agents/new")({
	component: NewAgentApplicationRoute,
});

function NewAgentApplicationRoute() {
	const session = useBrowserSession();
	const submission = useAgentApplicationSubmission();
	// 部署状态说明与提交拦截按当前读取结果（N12-01）；读取失败时模型端点与模型的显示名沿用最近一次读到的
	// 目录（#3418 N14-06）。
	const { query: deployment, shown: shownDeployment } =
		useShownDeploymentConfiguration();
	if (deployment.isPending) {
		return (
			<main className="platform-content management-content">
				<PageLoadingState
					title={createApplicationHeading}
					message="正在读取部署选项…"
				/>
			</main>
		);
	}
	const {
		configuration: deploymentConfiguration,
		retryable: deploymentConfigurationRetryable,
	} = projectDeploymentConfiguration(
		deployment.data,
		deployment.error,
		deployment.isError,
	);
	const error =
		submission.isError && submission.error instanceof Error
			? submission.error
			: null;

	return (
		<main className="platform-content management-content">
			<AgentApplicationSubmissionScreen
				connectionUrl={
					session.state.kind === "ready"
						? connectionEntryUrl(session.state.connection)
						: undefined
				}
				error={error}
				mode="create"
				onSubmit={submission.create}
				result={submission.data}
				submitting={submission.isPending}
				deploymentConfiguration={deploymentConfiguration}
				deploymentConfigurationRetryable={deploymentConfigurationRetryable}
				lastReadModelEndpoints={
					shownDeployment?.kind === "ready"
						? shownDeployment.configuration.modelCatalog.endpoints
						: undefined
				}
				onRefreshDeploymentConfiguration={() => void deployment.refetch()}
				refreshingDeploymentConfiguration={deployment.isFetching}
			/>
		</main>
	);
}
