import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useResultFocus } from "@/hooks/use-result-focus";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	agentManagementStatusLabels,
	agentServiceAvailabilityLabel,
} from "../agent-management-status.js";
import type { BrowserSessionState } from "../browser-session.js";
import type {
	AgentLifecycleCommand,
	AgentLifecycleCommandResult,
} from "./agent-administration.js";

type AdministrationSessionState = BrowserSessionState | { kind: "loading" };

type PendingLifecycleCommand = {
	readonly agentId: string;
	readonly command: AgentLifecycleCommand;
};

type RequestError = Error & { readonly retryable?: boolean };

type AgentLifecycleControlsProps = {
	agent: AgentProjectionV2;
	commandError?: RequestError | null;
	commandResult?: AgentLifecycleCommandResult;
	onCommand: (command: AgentLifecycleCommand) => void;
	pendingCommand?: PendingLifecycleCommand;
	session: AdministrationSessionState;
};

export const commandLabels = {
	stop: "停止 Agent",
	restart: "重启 Agent",
	retry_creation: "重试创建",
	disable: "停用 Agent",
} satisfies Record<AgentLifecycleCommand, string>;
export const commandProgressLabels = {
	stop: "停止中…",
	restart: "重启中…",
	retry_creation: "重试创建中…",
	disable: "停用中…",
} satisfies Record<AgentLifecycleCommand, string>;

function serviceAvailabilityMessage(
	availability: NonNullable<AgentProjectionV2["serviceAvailability"]>,
) {
	if (availability === "starting") {
		return "服务正在启动，个人历史暂时只读。";
	}
	if (availability === "updating") {
		return "服务正在更新，个人历史暂时只读。";
	}
	if (availability === "unavailable") {
		return "服务暂不可用，恢复前个人历史只读。";
	}
	return "服务已就绪。";
}

export function visibleLifecycleCommands(
	agent: AgentProjectionV2,
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

export const confirmationCopy = {
	stop: {
		title: () => "停止这个 Agent？",
		description: "停止后暂不能发送消息，个人历史与配置保留。",
		confirm: "停止 Agent",
	},
	restart: {
		title: (agentName: string) => `重启${agentName}？`,
		description: "重启期间暂不能发送消息，已有历史保留。",
		confirm: "确认重启",
	},
	retry_creation: {
		title: () => "重试创建 Agent？",
		description: "将重新尝试创建 Agent，请在创建完成后确认服务状态。",
		confirm: "确认重试创建",
	},
	disable: {
		title: () => "停用 Agent？",
		description: "停用将撤销运行资格。Owner 不能恢复，个人历史仍保留。",
		confirm: "确认停用",
	},
} satisfies Record<
	AgentLifecycleCommand,
	{
		title: (agentName: string) => string;
		description: string;
		confirm: string;
	}
>;

function LifecycleConfirmation({
	agentName,
	command,
	disabled,
	label,
	onCommand,
}: {
	agentName: string;
	command: AgentLifecycleCommand;
	disabled: boolean;
	label: string;
	onCommand: AgentLifecycleControlsProps["onCommand"];
}) {
	const copy = confirmationCopy[command];
	// 停止、停用为 danger；重启、重试创建为 primary。
	const destructive = command === "stop" || command === "disable";
	return (
		<ConfirmDialog
			disabled={disabled}
			trigger={
				<Button variant={destructive ? "destructive" : "outline"}>
					{label}
				</Button>
			}
			title={copy.title(agentName)}
			subject={{ name: agentName }}
			description={copy.description}
			confirmLabel={copy.confirm}
			tone={destructive ? "danger" : "default"}
			onConfirm={() => {
				if (disabled) return;
				onCommand(command);
			}}
		/>
	);
}

export function AgentLifecycleControls({
	agent,
	commandError = null,
	commandResult,
	onCommand,
	pendingCommand,
	session,
}: AgentLifecycleControlsProps) {
	const [localPendingCommand, setLocalPendingCommand] =
		useState<AgentLifecycleCommand | null>(null);
	const observedResult = commandResult ? JSON.stringify(commandResult) : null;
	const lastObservedResult = useRef(observedResult);
	const lastCommandError = useRef(commandError);
	useEffect(() => {
		const resultAdvanced = observedResult !== lastObservedResult.current;
		const errorAdvanced =
			commandError !== null && commandError !== lastCommandError.current;
		lastObservedResult.current = observedResult;
		lastCommandError.current = commandError;
		if (
			errorAdvanced ||
			(resultAdvanced && commandResult?.agentId === agent.agentId)
		) {
			setLocalPendingCommand(null);
		}
	}, [agent.agentId, commandError, commandResult?.agentId, observedResult]);
	const commands = visibleLifecycleCommands(agent, session);
	const serviceAvailability =
		agent.managementStatus === "available" ? agent.serviceAvailability : null;
	const matchingPendingCommand =
		pendingCommand?.agentId === agent.agentId ? pendingCommand : undefined;
	const isPending =
		matchingPendingCommand !== undefined || localPendingCommand !== null;
	const activeCommand = matchingPendingCommand?.command ?? localPendingCommand;
	const submittedResult =
		commandResult?.agentId === agent.agentId ? commandResult : undefined;
	const resultRef = useResultFocus(submittedResult);

	return (
		<section className="space-y-5">
			<div className="min-w-0 space-y-3">
				<h2 className="font-semibold text-foreground text-lg">生命周期</h2>
				<p className="text-muted-foreground text-sm">
					停止或停用后仍保留个人历史。
				</p>
				<dl className="space-y-2 text-sm">
					<div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
						<dt className="font-medium text-foreground">Agent 状态</dt>
						<dd className="text-foreground">
							{agentManagementStatusLabels[agent.managementStatus]}
						</dd>
					</div>
					{serviceAvailability ? (
						<div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
							<dt className="font-medium text-foreground">服务状态</dt>
							<dd className="text-foreground">
								{agentServiceAvailabilityLabel(serviceAvailability)}
							</dd>
						</div>
					) : null}
				</dl>
				{serviceAvailability ? (
					<p className="text-muted-foreground text-sm">
						{serviceAvailabilityMessage(serviceAvailability)}
					</p>
				) : null}
				{submittedResult ? (
					<p
						ref={resultRef}
						tabIndex={-1}
						className="font-medium text-foreground text-sm"
						role="status"
					>
						操作已提交：
						{
							agentManagementStatusLabels[
								"managementStatus" in submittedResult
									? submittedResult.managementStatus
									: (submittedResult.status ?? agent.managementStatus)
							]
						}
						。
					</p>
				) : null}
				{commandError ? (
					<Alert tone="danger" role="alert">
						<AlertDescription>
							{commandError.retryable === false
								? "权限或 Agent 状态已变化，请刷新页面。"
								: "操作未能提交，请稍后重试。"}
						</AlertDescription>
					</Alert>
				) : null}
			</div>
			{commands.length > 0 ? (
				<div className="actions flex flex-col items-start gap-3">
					{commands.map((command) => (
						<div
							key={`${agent.agentId}-${command}`}
							className={
								command === "stop" || command === "disable"
									? "lifecycle-danger-zone"
									: "lifecycle-action"
							}
						>
							{(command === "stop" || command === "disable") && (
								<div>
									<h3>{commandLabels[command]}</h3>
									<p>{confirmationCopy[command].description}</p>
								</div>
							)}
							<LifecycleConfirmation
								agentName={agent.name}
								command={command}
								disabled={isPending}
								label={
									activeCommand === command
										? commandProgressLabels[command]
										: commandLabels[command]
								}
								onCommand={(nextCommand) => {
									if (isPending) return;
									setLocalPendingCommand(nextCommand);
									onCommand(nextCommand);
								}}
							/>
						</div>
					))}
				</div>
			) : null}
		</section>
	);
}
