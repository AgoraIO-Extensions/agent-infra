import { useState } from "react";

import type {
	AgentApplicationProjectionV1,
	BrowserSessionProjectionV1,
} from "../../pilot/generated/types.gen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type {
	AgentApplicationDecision,
	BrowserSessionState,
	PendingAgentApplicationsState,
} from "./agent-administration.js";

type AdministrationSessionState = BrowserSessionState | { kind: "loading" };

type PendingDecision = {
	readonly applicationId: string;
	readonly decision: AgentApplicationDecision;
};

type RequestError = Error & { readonly retryable?: boolean };

type AdminAgentApplicationsScreenProps = {
	decisionError?: RequestError | null;
	decisionResult?: AgentApplicationProjectionV1;
	onDecision: (
		applicationId: string,
		decision: AgentApplicationDecision,
	) => void;
	pendingDecision?: PendingDecision;
	session: AdministrationSessionState;
	state: PendingAgentApplicationsState | { kind: "loading" };
};

function isSystemAdministrator(session: BrowserSessionProjectionV1) {
	// This controls visibility only. The Platform authorizes every decision command.
	return session.user.roles.includes("system_admin");
}

function resourceSummary(application: AgentApplicationProjectionV1) {
	const { estimatedResources } = application.resourceProfile;
	return `${estimatedResources.cpuMillicores}m CPU, ${estimatedResources.memoryMiB} MiB memory, ${estimatedResources.storageGiB} GiB storage`;
}

function DecisionFeedback({
	decision,
}: {
	decision?: AgentApplicationProjectionV1;
}) {
	return decision ? (
		<p className="mt-4 font-medium text-slate-950 text-sm" role="status">
			Decision submitted for {decision.name}:{" "}
			{agentManagementStatusLabels[decision.status]}.
		</p>
	) : null;
}

function ApplicationDecisionControls({
	application,
	onDecision,
	pendingDecision,
}: {
	application: AgentApplicationProjectionV1;
	onDecision: AdminAgentApplicationsScreenProps["onDecision"];
	pendingDecision?: PendingDecision;
}) {
	const [reason, setReason] = useState("");
	const deciding = pendingDecision !== undefined;
	const currentDecision =
		pendingDecision?.applicationId === application.applicationId
			? pendingDecision.decision
			: undefined;

	return (
		<div className="flex min-w-0 flex-col gap-3 sm:min-w-72">
			<button
				className="min-h-11 border border-slate-900 bg-slate-900 px-4 font-medium text-sm text-white transition-colors hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-slate-900 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:bg-slate-400"
				disabled={deciding}
				onClick={() =>
					onDecision(application.applicationId, { decision: "approve" })
				}
				type="button"
			>
				{currentDecision?.decision === "approve"
					? "Approving..."
					: "Approve application"}
			</button>
			<form
				className="flex flex-col gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					const trimmedReason = reason.trim();
					if (!trimmedReason) return;
					onDecision(application.applicationId, {
						decision: "reject",
						reason: trimmedReason,
					});
				}}
			>
				<label className="font-medium text-slate-700 text-sm">
					Rejection reason
					<textarea
						className="mt-1 block min-h-20 w-full border border-slate-300 bg-white px-3 py-2 text-slate-950 text-sm outline-none focus:border-slate-900 focus-visible:outline-2 focus-visible:outline-slate-900 focus-visible:outline-offset-2 disabled:bg-slate-100"
						disabled={deciding}
						onChange={(event) => setReason(event.target.value)}
						required
						value={reason}
					/>
				</label>
				<button
					className="min-h-11 self-start border border-slate-700 px-4 font-medium text-slate-800 text-sm transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-slate-900 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
					disabled={deciding || !reason.trim()}
					type="submit"
				>
					{currentDecision?.decision === "reject"
						? "Rejecting..."
						: "Reject application"}
				</button>
			</form>
		</div>
	);
}

export function AdminAgentApplicationsScreen({
	decisionError = null,
	decisionResult,
	onDecision,
	pendingDecision,
	session,
	state,
}: AdminAgentApplicationsScreenProps) {
	if (session.kind === "loading") {
		return <p aria-live="polite">Loading Agent approvals...</p>;
	}
	if (session.kind !== "ready" || !isSystemAdministrator(session.session)) {
		return <p role="alert">Approvals are unavailable.</p>;
	}
	if (state.kind === "loading") {
		return <p aria-live="polite">Loading Agent approvals...</p>;
	}
	if (state.kind === "unavailable") {
		return (
			<section aria-labelledby="agent-approvals-heading">
				<h1
					id="agent-approvals-heading"
					className="font-semibold text-2xl text-slate-950"
				>
					Agent approvals are unavailable
				</h1>
				<DecisionFeedback decision={decisionResult} />
				<p className="mt-4 text-slate-600" role="alert">
					{state.retryable
						? "Please try again shortly."
						: "Please contact an administrator."}
				</p>
			</section>
		);
	}

	return (
		<section aria-labelledby="agent-approvals-heading">
			<h1
				id="agent-approvals-heading"
				className="font-semibold text-2xl text-slate-950"
			>
				Agent approvals
			</h1>
			<DecisionFeedback decision={decisionResult} />
			{state.applications.length === 0 ? (
				<p className="mt-4 text-slate-600">No pending Agent applications.</p>
			) : (
				<ul className="mt-4 divide-y divide-slate-200 border-slate-200 border-y">
					{state.applications.map((application) => {
						return (
							<li
								className="flex flex-col gap-4 py-4 sm:flex-row sm:items-start sm:justify-between"
								key={application.applicationId}
							>
								<div className="min-w-0 space-y-2">
									<div className="flex flex-wrap items-center gap-2">
										<strong className="text-slate-950">
											{application.name}
										</strong>
										<span className="border border-slate-300 px-2 py-1 text-slate-700 text-xs">
											{agentManagementStatusLabels[application.status]}
										</span>
									</div>
									<p className="text-slate-600 text-sm">
										{application.description}
									</p>
									<dl className="text-slate-700 text-sm">
										<div>
											<dt className="inline font-medium">Resource profile: </dt>
											<dd className="inline">
												{application.resourceProfile.displayName}
											</dd>
										</div>
										<div>
											<dt className="inline font-medium">
												Estimated resources:{" "}
											</dt>
											<dd className="inline">{resourceSummary(application)}</dd>
										</div>
									</dl>
								</div>
								{application.status === "pending_approval" ? (
									<ApplicationDecisionControls
										application={application}
										onDecision={onDecision}
										pendingDecision={pendingDecision}
									/>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
			{decisionError ? (
				<p className="mt-4 text-slate-600" role="alert">
					{decisionError.retryable === false
						? "Your permission or this application changed. Refresh the page."
						: "Unable to submit the application decision. Please try again shortly."}
				</p>
			) : null}
		</section>
	);
}
