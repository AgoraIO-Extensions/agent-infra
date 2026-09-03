import type { AgentProjectionV1 } from "../../pilot/generated/types.gen.js";
import type { AgentDetailState } from "./agent-discovery.js";
import { agentServiceAvailabilityLabel } from "./agent-discovery-screen.js";

type AgentDetailScreenProps = {
	state: AgentDetailState | { kind: "loading" };
};

const managementStatusLabels = {
	pending_approval: "Pending approval",
	withdrawn: "Withdrawn",
	rejected: "Rejected",
	creating: "Creating",
	available: "Available",
	stopped: "Stopped",
	creation_failed: "Creation failed",
	disabled: "Disabled",
} satisfies Record<AgentProjectionV1["managementStatus"], string>;

export function AgentDetailScreen({ state }: AgentDetailScreenProps) {
	if (state.kind === "loading") {
		return <p aria-live="polite">Loading Agent...</p>;
	}
	if (state.kind === "unavailable") {
		return (
			<section aria-labelledby="agent-detail-heading" className="space-y-4">
				<h1
					id="agent-detail-heading"
					className="font-semibold text-2xl text-slate-950"
				>
					Agent is unavailable
				</h1>
				<p className="text-slate-600" role="alert">
					{state.retryable
						? "Please try again shortly."
						: "This Agent is unavailable."}
				</p>
				<a
					className="text-slate-700 text-sm underline underline-offset-4"
					href="/agents"
				>
					Back to Agents
				</a>
			</section>
		);
	}

	const { agent } = state;
	return (
		<section aria-labelledby="agent-detail-heading" className="space-y-6">
			<header className="space-y-2 border-slate-200 border-b pb-5">
				<p className="font-medium text-slate-500 text-sm">Agent</p>
				<h1
					id="agent-detail-heading"
					className="font-semibold text-2xl text-slate-950"
				>
					{agent.name}
				</h1>
				<p className="max-w-2xl text-slate-600 leading-7">
					{agent.description}
				</p>
			</header>
			<dl className="divide-y divide-slate-200 border-slate-200 border-y">
				<div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-6">
					<dt className="font-medium text-slate-700 text-sm">Agent status</dt>
					<dd className="text-slate-950 text-sm">
						{managementStatusLabels[agent.managementStatus]}
					</dd>
				</div>
				{agent.serviceAvailability ? (
					<div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-6">
						<dt className="font-medium text-slate-700 text-sm">
							Service availability
						</dt>
						<dd className="text-slate-950 text-sm">
							{agentServiceAvailabilityLabel(agent.serviceAvailability)}
						</dd>
					</div>
				) : null}
			</dl>
			<a
				className="inline-flex min-h-11 items-center text-slate-700 text-sm underline underline-offset-4"
				href="/agents"
			>
				Back to Agents
			</a>
		</section>
	);
}
