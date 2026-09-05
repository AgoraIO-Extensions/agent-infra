import { createFileRoute } from "@tanstack/react-router";

import { AgentApplicationSubmissionScreen } from "../../features/my-agents/agent-application-submission-screen.js";
import { useAgentApplicationSubmission } from "../../features/my-agents/use-agent-application-submission.js";

export const Route = createFileRoute("/my-agents/new")({
	component: NewAgentApplicationRoute,
});

function NewAgentApplicationRoute() {
	const submission = useAgentApplicationSubmission();
	const error =
		submission.isError && submission.error instanceof Error
			? submission.error
			: null;

	return (
		<main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
			<AgentApplicationSubmissionScreen
				error={error}
				mode="create"
				onSubmit={submission.create}
				result={submission.data}
				submitting={submission.isPending}
			/>
		</main>
	);
}
