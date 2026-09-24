import { createFileRoute } from "@tanstack/react-router";
import { Button } from "../../components/ui/button.js";

import { AgentApplicationSubmissionScreen } from "../../features/my-agents/agent-application-submission-screen.js";
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
	if (deployment.isError || deployment.data?.kind !== "ready") {
		return (
			<main className="platform-content management-content">
				<section className="space-y-4" aria-live="assertive">
					<p>部署选项暂不可用，请重试。</p>
					<Button
						variant="outline"
						onClick={() => void deployment.refetch()}
						type="button"
					>
						重新加载
					</Button>
				</section>
			</main>
		);
	}
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
				deploymentConfiguration={deployment.data.configuration}
				onRefreshDeploymentConfiguration={() => void deployment.refetch()}
				refreshingDeploymentConfiguration={deployment.isFetching}
			/>
		</main>
	);
}
