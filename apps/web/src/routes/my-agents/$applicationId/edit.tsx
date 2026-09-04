import { createFileRoute, Link } from "@tanstack/react-router";

import { AgentApplicationSubmissionScreen } from "../../../features/my-agents/agent-application-submission-screen.js";
import { useAgentApplicationSubmission } from "../../../features/my-agents/use-agent-application-submission.js";
import { useMyAgentApplication } from "../../../features/my-agents/use-my-agent-application.js";

export const Route = createFileRoute("/my-agents/$applicationId/edit")({
	component: EditAgentApplicationRoute,
});

function EditAgentApplicationRoute() {
	const { applicationId } = Route.useParams();
	const query = useMyAgentApplication(applicationId);
	const submission = useAgentApplicationSubmission();
	if (query.isPending) {
		return <p aria-live="polite">Loading application...</p>;
	}
	if (query.isError || !query.data || query.data.kind !== "ready") {
		return (
			<main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
				<section
					aria-labelledby="agent-application-edit-heading"
					className="space-y-4"
				>
					<h1
						id="agent-application-edit-heading"
						className="font-semibold text-2xl text-slate-950"
					>
						Application is unavailable
					</h1>
					<p className="text-slate-600" role="alert">
						Please try again shortly.
					</p>
				</section>
			</main>
		);
	}
	const application = query.data.application;
	if (
		application.status !== "pending_approval" &&
		application.status !== "rejected"
	) {
		return (
			<main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
				<section
					aria-labelledby="agent-application-edit-heading"
					className="space-y-4"
				>
					<h1
						id="agent-application-edit-heading"
						className="font-semibold text-2xl text-slate-950"
					>
						Application is not editable
					</h1>
					<Link
						className="inline-flex min-h-11 items-center text-slate-700 text-sm underline underline-offset-4"
						params={{ applicationId }}
						to="/my-agents/$applicationId"
					>
						Back to application
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
		<main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
			<AgentApplicationSubmissionScreen
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
