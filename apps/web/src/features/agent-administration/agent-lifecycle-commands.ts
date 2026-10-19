import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import type { BrowserSessionState } from "../browser-session.js";
import type { AgentLifecycleCommand } from "./agent-administration.js";

type LifecycleSessionState = BrowserSessionState | { kind: "loading" };

/** 生命周期命令的按钮文字、进行中文字与确认文案；Owner 配置页的页脚、危险区与管理员操作区共用。 */
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

/**
 * 按服务端投影的管理状态与当前会话角色选出可见的命令。这里只决定显示哪些控件，
 * 每个命令仍由 Platform 授权。
 */
export function visibleLifecycleCommands(
	agent: AgentProjectionV2,
	session: LifecycleSessionState,
): AgentLifecycleCommand[] {
	if (session.kind !== "ready") return [];

	const user = session.session.user;
	const isOwner = agent.configuration.owners.some(
		(owner) => owner.userId === user.userId,
	);
	const isAdministrator = user.roles.includes("system_admin");
	const commands: AgentLifecycleCommand[] = [];

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
		description:
			"停止会释放运行资源，但保留配置、渠道绑定、平台会话历史与用户数据。",
		confirm: "停止 Agent",
	},
	restart: {
		title: (agentName: string) => `重启${agentName}？`,
		description:
			"重启会短暂释放并重新建立运行实例。历史会话保留，完成后状态会自动回到“就绪”。",
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
