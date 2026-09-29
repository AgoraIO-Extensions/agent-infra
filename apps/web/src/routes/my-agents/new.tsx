import { createFileRoute } from "@tanstack/react-router";

import { AgentApplicationSubmissionScreen } from "../../features/my-agents/agent-application-submission-screen.js";
import { unavailableDeploymentConfiguration } from "../../features/my-agents/deployment-configuration.js";
import { useAgentApplicationSubmission } from "../../features/my-agents/use-agent-application-submission.js";
import { useDeploymentConfiguration } from "../../features/my-agents/use-deployment-configuration.js";

export const Route = createFileRoute("/my-agents/new")({
	component: NewAgentApplicationRoute,
});

function NewAgentApplicationRoute() {
	const submission = useAgentApplicationSubmission();
	const deployment = useDeploymentConfiguration();
	if (deployment.isPending) {
		return (
			<main className="platform-content management-content">
				<p aria-live="polite">正在读取部署选项…</p>
			</main>
		);
	}
	const deploymentConfiguration =
		deployment.data?.kind === "ready"
			? deployment.data.configuration
			: unavailableDeploymentConfiguration;
	const deploymentConfigurationRetryable =
		deployment.isError ||
		deployment.data?.kind === "ready" ||
		(deployment.data?.kind === "unavailable" && deployment.data.retryable);
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
