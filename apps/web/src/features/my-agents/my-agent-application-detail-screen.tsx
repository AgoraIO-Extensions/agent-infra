import { Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import { useResultFocus } from "@/hooks/use-result-focus";

import type { AgentApplicationProjectionV1 } from "../../pilot/generated/types.gen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import {
	agentApplicationEditActionLabels,
	getAgentApplicationEditAction,
	type MyAgentApplicationState,
} from "./my-agent-applications.js";

type MyAgentApplicationDetailScreenProps = {
	onWithdraw: () => void;
	state: MyAgentApplicationState | { kind: "loading" };
	withdrawalError?: boolean;
	withdrawalResult?: AgentApplicationProjectionV1;
	withdrawing: boolean;
};

export function MyAgentApplicationDetailScreen({
	onWithdraw,
	state,
	withdrawalError = false,
	withdrawalResult,
	withdrawing,
}: MyAgentApplicationDetailScreenProps) {
	const submittedResult =
		state.kind === "ready" &&
		withdrawalResult?.applicationId === state.application.applicationId
			? withdrawalResult
			: undefined;
	const resultRef = useResultFocus(submittedResult);
	if (state.kind === "loading") {
		return <p aria-live="polite">Loading My Agent...</p>;
	}
	if (state.kind === "unavailable") {
		return (
			<section
				aria-labelledby="my-agent-application-detail-heading"
				className="space-y-4"
			>
				<h1
					id="my-agent-application-detail-heading"
					className="font-semibold text-2xl text-slate-950"
				>
					Application is unavailable
				</h1>
				<p className="text-slate-600" role="alert">
					{state.retryable
						? "Please try again shortly."
						: "This application is unavailable."}
				</p>
				<Link
					className={buttonVariants({ variant: "link", className: "px-0" })}
					to="/my-agents"
				>
					Back to My Agents
				</Link>
			</section>
		);
	}

	const { application } = state;
	const editAction = getAgentApplicationEditAction(application);
	return (
		<section
			aria-labelledby="my-agent-application-detail-heading"
			className="space-y-6"
		>
			<header className="space-y-2 border-slate-200 border-b pb-5">
				<p className="font-medium text-slate-500 text-sm">Application</p>
				<h1
					id="my-agent-application-detail-heading"
					className="font-semibold text-2xl text-slate-950"
				>
					{application.name}
				</h1>
				<p className="max-w-2xl text-slate-600 leading-7">
					{application.description}
				</p>
			</header>
			<dl className="divide-y divide-slate-200 border-slate-200 border-y">
				<div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-6">
					<dt className="font-medium text-slate-700 text-sm">
						Application status
					</dt>
					<dd className="text-slate-950 text-sm">
						{agentManagementStatusLabels[application.status]}
					</dd>
				</div>
				<div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-6">
					<dt className="font-medium text-slate-700 text-sm">Submitted</dt>
					<dd className="text-slate-950 text-sm">
						<time dateTime={application.submittedAt}>
							{application.submittedAt}
						</time>
					</dd>
				</div>
				{application.decision ? (
					<>
						<div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-6">
							<dt className="font-medium text-slate-700 text-sm">
								Decision date
							</dt>
							<dd className="text-slate-950 text-sm">
								<time dateTime={application.decision.decidedAt}>
									{application.decision.decidedAt}
								</time>
							</dd>
						</div>
						{application.decision.reason ? (
							<div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-6">
								<dt className="font-medium text-slate-700 text-sm">
									Decision reason
								</dt>
								<dd className="text-slate-950 text-sm">
									{application.decision.reason}
								</dd>
							</div>
						) : null}
					</>
				) : null}
			</dl>
			<div className="flex flex-wrap gap-4">
				<Link
					className={buttonVariants({ variant: "link", className: "px-0" })}
					to="/my-agents"
				>
					Back to My Agents
				</Link>
				{application.agentId ? (
					<Link
						className={buttonVariants({ variant: "link", className: "px-0" })}
						params={{ agentId: application.agentId }}
						to="/agents/$agentId"
					>
						Open Agent
					</Link>
				) : null}
				{editAction ? (
					<Link
						className={buttonVariants({ variant: "link", className: "px-0" })}
						params={{ applicationId: application.applicationId }}
						to="/my-agents/$applicationId/edit"
					>
						{agentApplicationEditActionLabels[editAction]}
					</Link>
				) : null}
				{application.status === "pending_approval" ? (
					<Button disabled={withdrawing} onClick={onWithdraw} type="button">
						{withdrawing ? "Withdrawing..." : "Withdraw application"}
					</Button>
				) : null}
			</div>
			{submittedResult ? (
				<p
					ref={resultRef}
					tabIndex={-1}
					className="font-medium text-slate-950 text-sm"
					role="status"
				>
					Withdrawal submitted:{" "}
					{agentManagementStatusLabels[submittedResult.status]}.
				</p>
			) : null}
			{withdrawalError ? (
				<p className="text-slate-600" role="alert">
					Unable to withdraw application.
				</p>
			) : null}
		</section>
	);
}
