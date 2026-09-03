import { Link } from "@tanstack/react-router";

import { agentManagementStatusLabels } from "../agent-management-status.js";
import type { MyAgentApplicationsState } from "./my-agent-applications.js";

type MyAgentsScreenProps = {
	state: MyAgentApplicationsState | { kind: "loading" };
};

export function MyAgentsScreen({ state }: MyAgentsScreenProps) {
	if (state.kind === "loading") {
		return <p aria-live="polite">Loading My Agents...</p>;
	}
	if (state.kind === "unavailable") {
		return (
			<section aria-labelledby="my-agents-heading">
				<h1
					id="my-agents-heading"
					className="font-semibold text-2xl text-slate-950"
				>
					My Agents are unavailable
				</h1>
				<p className="mt-4 text-slate-600" role="alert">
					{state.retryable
						? "Please try again shortly."
						: "Please contact an administrator."}
				</p>
			</section>
		);
	}

	if (state.applications.length === 0) {
		return (
			<section aria-labelledby="my-agents-heading">
				<h1
					id="my-agents-heading"
					className="font-semibold text-2xl text-slate-950"
				>
					My Agents
				</h1>
				<p className="mt-4 text-slate-600">No Agent applications yet.</p>
			</section>
		);
	}

	return (
		<section aria-labelledby="my-agents-heading">
			<h1
				id="my-agents-heading"
				className="font-semibold text-2xl text-slate-950"
			>
				My Agents
			</h1>
			<ul className="mt-4 divide-y divide-slate-200 border-slate-200 border-y">
				{state.applications.map((application) => (
					<li
						className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
						key={application.applicationId}
					>
						<Link
							className="min-w-0"
							params={{ applicationId: application.applicationId }}
							to="/my-agents/$applicationId"
						>
							<strong className="block truncate text-slate-950">
								{application.name}
							</strong>
							<span className="block truncate text-slate-600 text-sm">
								{application.description}
							</span>
						</Link>
						<div className="flex items-center gap-3 self-start sm:self-auto">
							<span className="border border-slate-300 px-2 py-1 text-slate-700 text-xs">
								{agentManagementStatusLabels[application.status]}
							</span>
							{application.agentId ? (
								<Link
									className="inline-flex min-h-11 items-center text-slate-700 text-sm underline underline-offset-4"
									params={{ agentId: application.agentId }}
									to="/agents/$agentId"
								>
									Open Agent
								</Link>
							) : null}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
