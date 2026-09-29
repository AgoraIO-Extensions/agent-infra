import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";

import { AgentApplicationSubmissionScreen } from "../../../features/my-agents/agent-application-submission-screen.js";
import { projectDeploymentConfiguration } from "../../../features/my-agents/deployment-configuration.js";
import {
	getAgentApplicationEditAction,
	isRetryableMyAgentApplicationError,
} from "../../../features/my-agents/my-agent-applications.js";
import { useAgentApplicationSubmission } from "../../../features/my-agents/use-agent-application-submission.js";
import { useDeploymentConfiguration } from "../../../features/my-agents/use-deployment-configuration.js";
import { useMyAgentApplication } from "../../../features/my-agents/use-my-agent-application.js";

export const Route = createFileRoute("/my-agents/$applicationId/edit")({
	component: EditAgentApplicationRoute,
});

function EditAgentApplicationRoute() {
	const { applicationId } = Route.useParams();
	const query = useMyAgentApplication(applicationId);
	const submission = useAgentApplicationSubmission(applicationId);
	const deployment = useDeploymentConfiguration();
	const retryable =
		(query.isError && isRetryableMyAgentApplicationError(query.error)) ||
		(query.data?.kind === "unavailable" && query.data.retryable) ||
		false;
	if (query.isPending) {
		return <p aria-live="polite">正在读取申请…</p>;
	}
	if (query.isError || !query.data || query.data.kind !== "ready") {
		return (
			<main className="platform-content management-content">
				<section
					aria-labelledby="agent-application-edit-heading"
					className="space-y-4"
				>
					<h1
						id="agent-application-edit-heading"
						className="font-semibold text-2xl text-foreground"
					>
						申请暂不可用
					</h1>
					<Alert>
						<AlertDescription>
							{retryable ? "请稍后重试。" : "请联系管理员。"}
						</AlertDescription>
						{retryable ? (
							<Button
								className="mt-4"
								variant="outline"
								disabled={query.isFetching}
								onClick={() => void query.refetch()}
								type="button"
							>
								<RefreshCw aria-hidden="true" data-icon="inline-start" />
								{query.isFetching ? "正在重新加载…" : "重新加载申请"}
							</Button>
						) : null}
					</Alert>
				</section>
			</main>
		);
	}
	const application = query.data.application;
	const action = getAgentApplicationEditAction(application);
	if (!action) {
		return (
			<main className="platform-content management-content">
				<section
					aria-labelledby="agent-application-edit-heading"
					className="space-y-4"
				>
					<h1
						id="agent-application-edit-heading"
						className="font-semibold text-2xl text-foreground"
					>
						当前申请不可修改
					</h1>
					<Link
						className={buttonVariants({ variant: "link", className: "px-0" })}
						params={{ applicationId }}
						to="/my-agents/$applicationId"
					>
						返回申请详情
					</Link>
				</section>
			</main>
		);
	}
	if (deployment.isPending) {
		return <p aria-live="polite">正在读取部署选项…</p>;
	}
	const error =
		submission.isError && submission.error instanceof Error
			? submission.error
			: null;
	const {
		configuration: deploymentConfiguration,
		retryable: deploymentConfigurationRetryable,
	} = projectDeploymentConfiguration(
		deployment.data,
		deployment.error,
		deployment.isError,
	);

	return (
		<main className="platform-content management-content">
			<AgentApplicationSubmissionScreen
				action={action}
				application={application}
				error={error}
				mode="update"
				onSubmit={(body) => submission.update(applicationId, body)}
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
