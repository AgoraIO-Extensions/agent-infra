import { createFileRoute, Link } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";

import { AgentApplicationSubmissionScreen } from "../../../features/my-agents/agent-application-submission-screen.js";
import { getAgentApplicationEditAction } from "../../../features/my-agents/my-agent-applications.js";
import { useAgentApplicationSubmission } from "../../../features/my-agents/use-agent-application-submission.js";
import { useMyAgentApplication } from "../../../features/my-agents/use-my-agent-application.js";

export const Route = createFileRoute("/my-agents/$applicationId/edit")({
	component: EditAgentApplicationRoute,
});

function EditAgentApplicationRoute() {
	const { applicationId } = Route.useParams();
	const query = useMyAgentApplication(applicationId);
	const submission = useAgentApplicationSubmission(applicationId);
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
						<AlertDescription>请稍后重试。</AlertDescription>
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
	const error =
		submission.isError && submission.error instanceof Error
			? submission.error
			: null;

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
			/>
		</main>
	);
}
