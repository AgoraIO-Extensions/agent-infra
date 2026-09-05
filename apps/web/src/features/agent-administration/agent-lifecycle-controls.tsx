import type { AgentProjectionV1 } from "../../pilot/generated/types.gen.js";
import { agentServiceAvailabilityLabel } from "../agent-discovery/agent-discovery-screen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type {
	AgentLifecycleCommand,
	BrowserSessionState,
} from "./agent-administration.js";

type AdministrationSessionState = BrowserSessionState | { kind: "loading" };

type PendingLifecycleCommand = {
	readonly agentId: string;
	readonly command: AgentLifecycleCommand;
};

type RequestError = Error & { readonly retryable?: boolean };

type AgentLifecycleControlsProps = {
	agent: AgentProjectionV1;
	commandError?: RequestError | null;
	commandResult?: AgentProjectionV1;
	onCommand: (command: AgentLifecycleCommand) => void;
	pendingCommand?: PendingLifecycleCommand;
	session: AdministrationSessionState;
};

const commandLabels = {
	stop: "Stop Agent",
	restart: "Restart Agent",
	retry_creation: "Retry creation",
	disable: "Disable Agent",
} satisfies Record<AgentLifecycleCommand, string>;
const commandProgressLabels = {
	stop: "Stopping...",
	restart: "Restarting...",
	retry_creation: "Retrying creation...",
	disable: "Disabling...",
} satisfies Record<AgentLifecycleCommand, string>;

function serviceAvailabilityMessage(
	availability: NonNullable<AgentProjectionV1["serviceAvailability"]>,
) {
	if (availability === "starting") {
		return "Service is starting. History is read-only until it is ready.";
	}
	if (availability === "updating") {
		return "Service is updating. History is read-only until it is ready.";
	}
	if (availability === "unavailable") {
		return "Service is temporarily unavailable. History is read-only until it recovers.";
	}
	return "Service is ready.";
}

function visibleLifecycleCommands(
	agent: AgentProjectionV1,
	session: AdministrationSessionState,
): AgentLifecycleCommand[] {
	if (session.kind !== "ready") return [];

	const user = session.session.user;
	const isOwner = agent.configuration.owners.some(
		(owner) => owner.userId === user.userId,
	);
	const isAdministrator = user.roles.includes("system_admin");
	const commands: AgentLifecycleCommand[] = [];

	// These projections only select visible controls. The Platform still authorizes every command.
	if (isOwner && agent.managementStatus === "available") {
		commands.push("stop", "restart");
	}
	if (isOwner && agent.managementStatus === "stopped") {
		commands.push("restart");
	}
	if (
		(isOwner || isAdministrator) &&
		agent.managementStatus === "creation_failed"
	) {
		commands.push("retry_creation");
	}
	if (
		isAdministrator &&
		["creating", "available", "stopped", "creation_failed"].includes(
			agent.managementStatus,
		)
	) {
		commands.push("disable");
	}

	return commands;
}

export function AgentLifecycleControls({
	agent,
	commandError = null,
	commandResult,
	onCommand,
	pendingCommand,
	session,
}: AgentLifecycleControlsProps) {
	const commands = visibleLifecycleCommands(agent, session);
	const serviceAvailability =
		agent.managementStatus === "available" ? agent.serviceAvailability : null;
	const isPending = pendingCommand !== undefined;
	const submittedResult =
		commandResult?.agentId === agent.agentId ? commandResult : undefined;

	return (
		<section className="flex flex-col gap-4 border-slate-200 border-t pt-5 sm:flex-row sm:items-start sm:justify-between">
			<div className="min-w-0 space-y-3">
				<h2 className="font-semibold text-lg text-slate-950">
					Lifecycle controls
				</h2>
				<dl className="space-y-2 text-sm">
					<div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
						<dt className="font-medium text-slate-700">Agent status</dt>
						<dd className="text-slate-950">
							{agentManagementStatusLabels[agent.managementStatus]}
						</dd>
					</div>
					{serviceAvailability ? (
						<div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
							<dt className="font-medium text-slate-700">
								Service availability
							</dt>
							<dd className="text-slate-950">
								{agentServiceAvailabilityLabel(serviceAvailability)}
							</dd>
						</div>
					) : null}
				</dl>
				{serviceAvailability ? (
					<p className="text-slate-600 text-sm">
						{serviceAvailabilityMessage(serviceAvailability)}
					</p>
				) : null}
				{submittedResult ? (
					<p className="font-medium text-slate-950 text-sm" role="status">
						Lifecycle command submitted:{" "}
						{agentManagementStatusLabels[submittedResult.managementStatus]}.
					</p>
				) : null}
				{commandError ? (
					<p className="text-slate-600 text-sm" role="alert">
						{commandError.retryable === false
							? "Your permission or this Agent changed. Refresh the page."
							: "Unable to submit the lifecycle command. Please try again shortly."}
					</p>
				) : null}
			</div>
			{commands.length > 0 ? (
				<div className="flex flex-wrap gap-3">
					{commands.map((command) => (
						<button
							className="min-h-11 border border-slate-700 px-4 font-medium text-slate-800 text-sm transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-slate-900 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
							disabled={isPending}
							key={command}
							onClick={() => onCommand(command)}
							type="button"
						>
							{pendingCommand?.agentId === agent.agentId &&
							pendingCommand.command === command
								? commandProgressLabels[command]
								: commandLabels[command]}
						</button>
					))}
				</div>
			) : null}
		</section>
	);
}
