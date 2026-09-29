import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	ExternalLink,
	History,
	MessageSquare,
	Settings,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type { AgentDetailState } from "./agent-discovery.js";
import {
	agentChannelKindLabels,
	agentServiceAvailabilityLabel,
} from "./agent-discovery-screen.js";

type AgentDetailScreenProps = {
	ownerSettings?: { readonly agentId: string };
	state: AgentDetailState | { kind: "loading" };
};
const channelStatusLabels = {
	available: "可用",
	not_configured: "未配置",
	binding: "绑定中",
	bound: "已绑定",
	failed: "绑定失败",
} satisfies Record<
	AgentProjectionV2["configuration"]["channels"][number]["status"],
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

export function AgentDetailScreen({
	ownerSettings,
	state,
}: AgentDetailScreenProps) {
	if (state.kind === "loading")
		return <p aria-live="polite">正在加载 Agent 详情…</p>;
	if (state.kind === "unavailable")
		return (
			<section aria-labelledby="agent-detail-heading" className="space-y-4">
				<h1 id="agent-detail-heading" className="font-semibold text-[28px]">
					暂时无法访问 Agent
				</h1>
				<Alert>
					<AlertDescription>
						{state.retryable
							? "暂时无法读取 Agent 信息，请稍后重试。"
							: "此 Agent 暂时无法访问。"}
					</AlertDescription>
				</Alert>
				<Link
					className={buttonVariants({ variant: "link", className: "px-0" })}
					to="/agents"
				>
					<ArrowLeft aria-hidden="true" />
					返回 Agent 列表
				</Link>
			</section>
		);
	const { agent } = state;
	const selfManaged =
		agent.source.kind === "custom" &&
		agent.source.interactionMode === "self-managed";
	const interactionUrl =
		selfManaged &&
		agent.source.kind === "custom" &&
		agent.source.interactionMode === "self-managed" &&
		agent.source.identityResponsibility === "self-managed"
			? safeInteractionUrl(agent.interactionUrl)
			: undefined;
	const ready =
		agent.managementStatus === "available" &&
		agent.serviceAvailability === "ready";
	const defaultModel = agent.configuration.modelOptions.find(
		(option) => option.optionId === agent.configuration.defaultModelOptionId,
	);
	return (
		<section aria-labelledby="agent-detail-heading" className="space-y-6">
			<header className="page-heading flex flex-wrap items-start justify-between gap-6">
				<div className="min-w-0 flex-1">
					<h1
						id="agent-detail-heading"
						className="break-words font-semibold text-[28px]"
					>
						{agent.name}
					</h1>
					<p className="mt-2 max-w-2xl whitespace-pre-wrap break-words text-muted-foreground leading-7">
						{agent.description}
					</p>
				</div>
				<div className="actions flex flex-wrap gap-3">
					{!selfManaged &&
						(ready ? (
							<Link
								className={buttonVariants()}
								to="/agents/$agentId/conversations"
								params={{ agentId: agent.agentId }}
								search={{ conversation: undefined, view: undefined }}
							>
								<MessageSquare aria-hidden="true" />
								开始对话
							</Link>
						) : (
							<Button disabled>
								<MessageSquare aria-hidden="true" />
								开始对话
							</Button>
						))}
					{interactionUrl && (
						<a
							className={buttonVariants()}
							href={interactionUrl}
							rel="noopener noreferrer"
							target="_blank"
						>
							打开 Agent
							<ExternalLink aria-hidden="true" />
						</a>
					)}
				</div>
			</header>
			<div className="status-line flex flex-wrap items-center gap-3">
				<Badge variant="outline">
					{agentManagementStatusLabels[agent.managementStatus]}
				</Badge>
				{agent.serviceAvailability && (
					<Badge variant="secondary">
						{agentServiceAvailabilityLabel(agent.serviceAvailability)}
					</Badge>
				)}
				{!selfManaged && (
					<>
						<span className="text-muted-foreground text-sm">
							{ready
								? "每位员工拥有独立的个人会话。"
								: "历史保留，当前不可发送消息。"}
						</span>
						<Link
							className={buttonVariants({ variant: "ghost" })}
							to="/agents/$agentId/conversations"
							params={{ agentId: agent.agentId }}
							search={{ conversation: undefined, view: "history" }}
						>
							<History aria-hidden="true" />
							个人历史
						</Link>
					</>
				)}
			</div>
			<section
				className="detail-section space-y-4 border-border border-b py-6"
				aria-labelledby="about-agent-heading"
			>
				<h2 id="about-agent-heading" className="font-semibold text-lg">
					关于此 Agent
				</h2>
				<dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
					<dt className="text-muted-foreground">Owner</dt>
					<dd className="break-words">
						{agent.configuration.owners
							.map((owner) => owner.displayName)
							.join("、") || "未提供"}
					</dd>
					<dt className="text-muted-foreground">模板与入口</dt>
					<dd className="break-all">
						{agent.source.kind === "standard"
							? `标准模板 · ${agent.source.templateId}`
							: agent.source.interactionMode === "self-managed"
								? "自定义 Agent · 自有交互入口"
								: "自定义 Agent · 平台交互入口"}
					</dd>
					<dt className="text-muted-foreground">渠道</dt>
					<dd className="break-words">
						{agent.configuration.channels
							.map(
								(channel) =>
									`${agentChannelKindLabels[channel.kind]}：${channelStatusLabels[channel.status]}`,
							)
							.join("、") || "暂无平台渠道"}
					</dd>
					<dt className="text-muted-foreground">可用范围</dt>
					<dd className="break-words">
						{agent.configuration.availability
							.map((entry) =>
								entry.kind === "user"
									? `用户 ${entry.userId}`
									: `组织 ${entry.organizationId}`,
							)
							.join("、") || "未提供范围信息"}
					</dd>
					<dt className="text-muted-foreground">模型范围</dt>
					<dd className="break-words">
						{agent.configuration.modelOptions
							.map(
								(option) =>
									`${option.displayName} · ${option.reasoningLevels.join("、")}`,
							)
							.join("；") || "无可选择模型"}
					</dd>
					<dt className="text-muted-foreground">默认选项</dt>
					<dd className="break-words">
						{defaultModel
							? `${defaultModel.displayName}${agent.configuration.defaultReasoningLevel ? ` · ${agent.configuration.defaultReasoningLevel}` : ""}`
							: "未提供"}
					</dd>
				</dl>
			</section>
			<section
				className="detail-section space-y-3 border-border border-b py-6"
				aria-labelledby="agent-capability-heading"
			>
				<h2 id="agent-capability-heading" className="font-semibold text-lg">
					外部能力
				</h2>
				<p>
					{agent.capabilities.connection
						? "此 Agent 支持独立 Connection 直连，使用前需由当前主体完成授权。"
						: "当前 Agent 未提供 Connection 能力。"}
				</p>
				{agent.capabilities.connection && (
					<p className="text-muted-foreground text-sm">
						登录、OAuth、客户端授权和原调用查询均在独立 Connection
						中完成。能力说明不代表当前主体已经获得授权，Owner
						不能替其他主体授权。
					</p>
				)}
			</section>
			<div className="actions flex flex-wrap gap-3">
				<Link
					className={buttonVariants({ variant: "link", className: "px-0" })}
					to="/agents"
				>
					<ArrowLeft aria-hidden="true" />
					返回 Agent 列表
				</Link>
				{ownerSettings && (
					<Link
						className={buttonVariants({ variant: "outline" })}
						params={{ agentId: ownerSettings.agentId }}
						to="/agents/$agentId/configuration"
					>
						<Settings aria-hidden="true" />
						配置与管理
					</Link>
				)}
			</div>
		</section>
	);
}
