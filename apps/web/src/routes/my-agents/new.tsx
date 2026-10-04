import { createFileRoute } from "@tanstack/react-router";

import { AgentApplicationSubmissionScreen } from "../../features/my-agents/agent-application-submission-screen.js";
import { projectDeploymentConfiguration } from "../../features/my-agents/deployment-configuration.js";
import { useAgentApplicationSubmission } from "../../features/my-agents/use-agent-application-submission.js";
import { useDeploymentConfiguration } from "../../features/my-agents/use-deployment-configuration.js";
import { PageLoadingState } from "../../features/page-loading-state.js";

export const Route = createFileRoute("/my-agents/new")({
	component: NewAgentApplicationRoute,
});

function NewAgentApplicationRoute() {
	const submission = useAgentApplicationSubmission();
	const deployment = useDeploymentConfiguration();
	if (deployment.isPending) {
		return (
			<main className="platform-content management-content">
				<PageLoadingState
					title="创建一个新的 Agent。"
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
				error={error}
				mode="create"
				onSubmit={submission.create}
				result={submission.data}
				submitting={submission.isPending}
				deploymentConfiguration={deploymentConfiguration}
				deploymentConfigurationRetryable={deploymentConfigurationRetryable}
				onRefreshDeploymentConfiguration={() => void deployment.refetch()}
				refreshingDeploymentConfiguration={deployment.isFetching}
			/>
		</main>
	);
}
