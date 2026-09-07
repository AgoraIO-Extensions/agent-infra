import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useResultFocus } from "@/hooks/use-result-focus";

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
	const resultRef = useResultFocus(decision);
	return decision ? (
		<p
			ref={resultRef}
			tabIndex={-1}
			className="mt-4 font-medium text-slate-950 text-sm"
			role="status"
		>
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
	const reasonId = useId();
	const deciding = pendingDecision !== undefined;
	const currentDecision =
		pendingDecision?.applicationId === application.applicationId
			? pendingDecision.decision
			: undefined;

	return (
		<div className="flex min-w-0 flex-col gap-3 sm:min-w-72">
			<Button
				disabled={deciding}
				onClick={() =>
					onDecision(application.applicationId, { decision: "approve" })
				}
				type="button"
			>
				{currentDecision?.decision === "approve"
					? "Approving..."
					: "Approve application"}
			</Button>
			<form
				className="flex flex-col gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (deciding) return;
					const trimmedReason = reason.trim();
					if (!trimmedReason) return;
					onDecision(application.applicationId, {
						decision: "reject",
						reason: trimmedReason,
					});
				}}
			>
				<Label htmlFor={reasonId}>Rejection reason</Label>
				<Textarea
					id={reasonId}
					className="min-h-20"
					disabled={deciding}
					onChange={(event) => setReason(event.target.value)}
					required
					value={reason}
				/>
				<Button
					variant="outline"
					className="self-start"
					disabled={deciding || !reason.trim()}
					type="submit"
				>
					{currentDecision?.decision === "reject"
						? "Rejecting..."
						: "Reject application"}
				</Button>
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
										<Badge variant="outline">
											{agentManagementStatusLabels[application.status]}
										</Badge>
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
