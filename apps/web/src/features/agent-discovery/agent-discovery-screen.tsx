import type { AgentProjectionV1 } from "../../pilot/generated/types.gen.js";
import type { AgentDiscoveryState } from "./agent-discovery.js";

type AgentDiscoveryScreenProps = {
	state: AgentDiscoveryState | { kind: "loading" };
};

export function agentServiceAvailabilityLabel(
	availability: NonNullable<AgentProjectionV1["serviceAvailability"]>,
) {
	if (availability === "starting") return "Starting";
	if (availability === "updating") return "Updating";
	if (availability === "unavailable") return "Unavailable";
	return "Ready";
}

export function AgentDiscoveryScreen({ state }: AgentDiscoveryScreenProps) {
	if (state.kind === "loading") {
		return <p aria-live="polite">Loading Agents...</p>;
	}
	if (state.kind === "unavailable") {
		return (
			<section aria-labelledby="agents-heading">
				<h1
					id="agents-heading"
					className="font-semibold text-2xl text-slate-950"
				>
					Agents are unavailable
				</h1>
				<p className="mt-4 text-slate-600" role="alert">
					{state.retryable
						? "Please try again shortly."
						: "Please contact an administrator."}
				</p>
			</section>
		);
	}
	if (state.agents.length === 0) {
		return (
			<section aria-labelledby="agents-heading">
				<h1
					id="agents-heading"
					className="font-semibold text-2xl text-slate-950"
				>
					Agents
				</h1>
				<p className="mt-4 text-slate-600">No Agents are available to you.</p>
			</section>
		);
	}

	return (
		<section aria-labelledby="agents-heading">
			<h1 id="agents-heading" className="font-semibold text-2xl text-slate-950">
				Agents
			</h1>
			<ul className="mt-4 divide-y divide-slate-200 border-slate-200 border-y">
				{state.agents.map((agent) => (
					<li
						className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
						key={agent.agentId}
					>
						<a className="min-w-0" href={`/agents/${agent.agentId}`}>
							<strong className="block truncate text-slate-950">
								{agent.name}
							</strong>
							<span className="block truncate text-slate-600 text-sm">
								{agent.description}
							</span>
						</a>
						{agent.serviceAvailability ? (
							<span className="self-start border border-slate-300 px-2 py-1 text-slate-700 text-xs sm:self-auto">
								{agentServiceAvailabilityLabel(agent.serviceAvailability)}
							</span>
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}
