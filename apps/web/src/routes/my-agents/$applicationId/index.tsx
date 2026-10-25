import { createFileRoute } from "@tanstack/react-router";

import { readFailed } from "../../../features/background-read.js";
import { AgentCreationFailureNotice } from "../../../features/my-agents/agent-creation-failure.js";
import { MyAgentApplicationDetailScreen } from "../../../features/my-agents/my-agent-application-detail-screen.js";
import { isRetryableMyAgentApplicationError } from "../../../features/my-agents/my-agent-applications.js";
import { useMyAgentApplication } from "../../../features/my-agents/use-my-agent-application.js";
import { useWithdrawMyAgentApplication } from "../../../features/my-agents/use-withdraw-my-agent-application.js";
import { useTemplateNameLookup } from "../../../features/template-display-name.js";

export const Route = createFileRoute("/my-agents/$applicationId/")({
	component: MyAgentApplicationRoute,
});

function MyAgentApplicationRoute() {
	const { applicationId } = Route.useParams();
	const query = useMyAgentApplication(applicationId);
	const withdrawal = useWithdrawMyAgentApplication(applicationId);
	const templateName = useTemplateNameLookup();
	const retryable = query.isError
		? isRetryableMyAgentApplicationError(query.error)
		: query.data?.kind === "unavailable" && query.data.retryable;
	const application =
		query.data?.kind === "ready" ? query.data.application : undefined;
	// 创建失败时读取服务端给出的失败类别（#3034）；读不到时不展示任何原因。
	// 提示在审批进度卡片内，与驳回原因同样距进度列表 18px（#3152）。
	const creationFailure =
		application?.status === "creation_failed" && application.agentId ? (
			<AgentCreationFailureNotice
				agentId={application.agentId}
				className="application-creation-failure"
			/>
		) : undefined;

	return (
		<main className="platform-content management-content">
			<MyAgentApplicationDetailScreen
				onRetry={() => void query.refetch()}
				onWithdraw={() => withdrawal.mutate()}
				retrying={query.isFetching}
				state={
					query.isPending
						? { kind: "loading" }
						: // 后台重读的可重试失败不替换已显示的申请（#3387）。
							readFailed(query, isRetryableMyAgentApplicationError) ||
								!query.data
							? { kind: "unavailable", retryable }
							: query.data
				}
				withdrawalError={withdrawal.isError}
				withdrawalResult={withdrawal.data}
				withdrawing={withdrawal.isPending}
				templateName={templateName}
				creationFailure={creationFailure}
			/>
		</main>
	);
}
