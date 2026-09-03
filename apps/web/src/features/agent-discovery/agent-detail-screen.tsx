import { Link } from "@tanstack/react-router";

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

const channelKindLabels = {
	web: "Web",
	wecom_bot: "WeCom bot",
	wecom_app: "WeCom app",
} satisfies Record<
	AgentProjectionV1["configuration"]["channels"][number]["kind"],
	string
>;

const channelStatusLabels = {
	available: "available",
	not_configured: "not configured",
	binding: "binding",
	bound: "bound",
	failed: "failed",
} satisfies Record<
	AgentProjectionV1["configuration"]["channels"][number]["status"],
	string
>;

function safeInteractionUrl(input: string | null) {
	if (!input) return undefined;
	try {
		const url = new URL(input);
		return url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

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
				<Link
					className="text-slate-700 text-sm underline underline-offset-4"
					to="/agents"
				>
					Back to Agents
				</Link>
			</section>
		);
	}

	const { agent } = state;
	const interactionUrl =
		agent.source.kind === "custom" &&
		agent.source.interactionMode === "self-managed" &&
		agent.source.identityResponsibility === "self-managed"
			? safeInteractionUrl(agent.interactionUrl)
			: undefined;
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
				<div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-6">
					<dt className="font-medium text-slate-700 text-sm">Owners</dt>
					<dd className="text-slate-950 text-sm">
						{agent.configuration.owners
							.map((owner) => owner.displayName)
							.join(", ")}
					</dd>
				</div>
				<div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-6">
					<dt className="font-medium text-slate-700 text-sm">Channels</dt>
					<dd className="text-slate-950 text-sm">
						{agent.configuration.channels.length > 0
							? agent.configuration.channels
									.map(
										(channel) =>
											`${channelKindLabels[channel.kind]}: ${channelStatusLabels[channel.status]}`,
									)
									.join(", ")
							: "No platform channels"}
					</dd>
				</div>
				<div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-6">
					<dt className="font-medium text-slate-700 text-sm">Model options</dt>
					<dd className="text-slate-950 text-sm">
						{agent.configuration.modelOptions.length > 0
							? agent.configuration.modelOptions
									.map((option) => {
										const defaultSuffix =
											option.optionId ===
											agent.configuration.defaultModelOptionId
												? ` (default${agent.configuration.defaultReasoningLevel ? `: ${agent.configuration.defaultReasoningLevel}` : ""})`
												: "";
										return `${option.displayName}${defaultSuffix}: ${option.reasoningLevels.join(", ")}`;
									})
									.join("; ")
							: "No selectable models"}
					</dd>
				</div>
				<div className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between sm:gap-6">
					<dt className="font-medium text-slate-700 text-sm">
						Connection actions
					</dt>
					<dd className="text-slate-950 text-sm">
						{!agent.capabilities.connection
							? "Not required"
							: agent.configuration.actions.length === 0
								? "Connection capability available"
								: agent.configuration.actions
										.map(
											(action) =>
												`${action.providerId} / ${action.actionId} (${action.actionVersion})`,
										)
										.join(", ")}
					</dd>
				</div>
			</dl>
			<div className="flex flex-wrap gap-4">
				<Link
					className="inline-flex min-h-11 items-center text-slate-700 text-sm underline underline-offset-4"
					to="/agents"
				>
					Back to Agents
				</Link>
				{interactionUrl ? (
					<a
						className="inline-flex min-h-11 items-center text-slate-700 text-sm underline underline-offset-4"
						href={interactionUrl}
						rel="noopener noreferrer"
						target="_blank"
					>
						Open Agent
					</a>
				) : null}
			</div>
		</section>
	);
}
