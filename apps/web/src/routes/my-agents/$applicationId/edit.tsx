import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";

import { checkAgentDefaultRelayKey } from "../../../features/agent-configuration/agent-configuration.js";
import { useAgentDefaultRelayKeyState } from "../../../features/agent-configuration/use-agent-default-relay-key-state.js";
import { AgentApplicationSubmissionScreen } from "../../../features/my-agents/agent-application-submission-screen.js";
import { projectDeploymentConfiguration } from "../../../features/my-agents/deployment-configuration.js";
import {
	agentApplicationEditActionLabels,
	getAgentApplicationEditAction,
	isRetryableMyAgentApplicationError,
} from "../../../features/my-agents/my-agent-applications.js";
import { useAgentApplicationSubmission } from "../../../features/my-agents/use-agent-application-submission.js";
import { useDeploymentConfiguration } from "../../../features/my-agents/use-deployment-configuration.js";
import { useMyAgentApplication } from "../../../features/my-agents/use-my-agent-application.js";
import { PageLoadingState } from "../../../features/page-loading-state.js";

export const Route = createFileRoute("/my-agents/$applicationId/edit")({
	component: EditAgentApplicationRoute,
});

function EditAgentApplicationRoute() {
	const { applicationId } = Route.useParams();
	const query = useMyAgentApplication(applicationId);
	const submission = useAgentApplicationSubmission(applicationId);
	const deployment = useDeploymentConfiguration();
	// 标准模板申请的模型由默认 Key 管理时，更换模型需要重新提交 Key（#2421）。
	const loadedApplication =
		query.data?.kind === "ready" ? query.data.application : undefined;
	const defaultRelayKey = useAgentDefaultRelayKeyState(
		loadedApplication?.agentId ?? "",
		loadedApplication?.agentId != null &&
			loadedApplication.source.kind === "standard",
	);
	const retryable = query.isError
		? isRetryableMyAgentApplicationError(query.error)
		: query.data?.kind === "unavailable" && query.data.retryable;
	if (query.isPending) {
		return (
			<main className="platform-content management-content">
				<PageLoadingState title="修改申请" message="正在读取申请…" />
			</main>
		);
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
					<Alert tone="danger" role="alert">
						<AlertDescription>
							{retryable ? "请稍后重试。" : "请联系管理员。"}
						</AlertDescription>
						{retryable ? (
							<AlertAction>
								<Button
									variant="outline"
									disabled={query.isFetching}
									onClick={() => void query.refetch()}
									type="button"
								>
									<RefreshCw aria-hidden="true" data-icon="inline-start" />
									{query.isFetching ? "正在重新加载…" : "重新加载申请"}
								</Button>
							</AlertAction>
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
						className={buttonVariants({ variant: "ghost", size: "sm" })}
						params={{ applicationId }}
						to="/my-agents/$applicationId"
					>
						<ArrowLeft aria-hidden="true" />
						返回申请详情
					</Link>
				</section>
			</main>
		);
	}
	if (deployment.isPending || defaultRelayKey.isLoading) {
		return (
			<main className="platform-content management-content">
				<PageLoadingState
					title={agentApplicationEditActionLabels[action]}
					message="正在读取部署选项…"
				/>
			</main>
		);
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
				defaultRelayKeyManaged={defaultRelayKey.data?.isSet === true}
				onCheckDefaultRelayKey={
					application.agentId
						? (keyValue) =>
								checkAgentDefaultRelayKey(
									application.agentId as string,
									keyValue,
								)
						: undefined
				}
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
