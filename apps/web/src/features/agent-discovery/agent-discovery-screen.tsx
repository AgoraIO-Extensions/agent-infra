import { Link } from "@tanstack/react-router";
import { ArrowRight, Bot, Plus, RefreshCw, Search } from "lucide-react";
import { useId, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import {
	type AgentDiscoveryState,
	canStartPlatformConversation,
} from "./agent-discovery.js";

type AgentDiscoveryScreenProps = {
	conversationSelection?: boolean;
	query?: string;
	onQueryChange?: (query: string) => void;
	onRetry?: () => void;
	retrying?: boolean;
	state: AgentDiscoveryState | { kind: "loading" };
};

export const agentDiscoveryQueryMaxLength = 256;

export function agentServiceAvailabilityLabel(
	availability: NonNullable<AgentProjectionV2["serviceAvailability"]>,
) {
	if (availability === "starting") return "启动中";
	if (availability === "updating") return "更新中";
	if (availability === "unavailable") return "暂时不可用";
	return "就绪";
}

export const agentChannelKindLabels = {
	web: "Web",
	wecom_bot: "企微机器人",
	wecom_app: "企微应用",
} satisfies Record<
	AgentProjectionV2["configuration"]["channels"][number]["kind"],
	string
>;

function agentSourceLabel(agent: AgentProjectionV2) {
	return agent.source.kind === "standard"
		? `标准模板 · ${agent.source.templateId}`
		: "自定义 Agent";
}

function agentChannelSummary(agent: AgentProjectionV2) {
	return (
		agent.configuration.channels
			.filter((channel) => ["available", "bound"].includes(channel.status))
			.map((channel) => agentChannelKindLabels[channel.kind])
			.join("、") ||
		(agent.source.kind === "custom" &&
		agent.source.interactionMode === "self-managed"
			? "自有交互入口"
			: "暂无可用渠道")
	);
}

export function AgentDiscoveryScreen({
	conversationSelection = false,
	query: controlledQuery,
	onQueryChange,
	onRetry,
	retrying = false,
	state,
}: AgentDiscoveryScreenProps) {
	const [localQuery, setLocalQuery] = useState(controlledQuery ?? "");
	const isControlled =
		controlledQuery !== undefined && onQueryChange !== undefined;
	const query = isControlled ? controlledQuery : localQuery;
	const searchId = useId();
	const [statusFilter, setStatusFilter] = useState("all");
	const [templateFilter, setTemplateFilter] = useState("all");
	const [modelFilter, setModelFilter] = useState("all");
	const search = query.trim().toLocaleLowerCase();
	// Search narrows the already authorized response; it never discovers another
	// collection or treats a client-side filter as authorization.
	const agents = state.kind === "ready" ? state.agents : [];
	const templates = [
		...new Set(
			agents.map((agent) =>
				agent.source.kind === "standard" ? agent.source.templateId : "custom",
			),
		),
	];
	const models = [
		...new Set(
			agents.flatMap((agent) =>
				agent.configuration.modelOptions.map((option) => option.modelId),
			),
		),
	];
	const visible = agents.filter(
		(agent) =>
			(statusFilter === "all" ||
				agent.serviceAvailability === statusFilter ||
				agent.managementStatus === statusFilter) &&
			(templateFilter === "all" ||
				(agent.source.kind === "standard"
					? agent.source.templateId
					: "custom") === templateFilter) &&
			(modelFilter === "all" ||
				agent.configuration.modelOptions.some(
					(option) => option.modelId === modelFilter,
				)) &&
			[
				agent.name,
				agent.description,
				agentSourceLabel(agent),
				agentChannelSummary(agent),
			]
				.join("\n")
				.toLocaleLowerCase()
				.includes(search),
	);
	return (
		<section aria-labelledby="agents-heading">
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">工作区 / Agent 目录</p>
					<h1 id="agents-heading" className="font-semibold text-[28px]">
						{conversationSelection
							? "选择 Agent 开始对话"
							: "找到适合这项工作的 Agent。"}
					</h1>
					<p className="mt-2 text-muted-foreground">
						{conversationSelection
							? "选择当前可用的 Agent，继续文本对话。"
							: "目录只展示当前账号有权访问的入口。每个 Agent 的会话与权限相互隔离。"}
					</p>
				</div>
				<Link className={buttonVariants()} to="/my-agents/new">
					<Plus aria-hidden="true" />
					创建申请
				</Link>
			</header>
			{state.kind === "ready" ? (
				<div className="directory-filters">
					<div className="directory-search w-full space-y-2">
						<Label className="sr-only" htmlFor={searchId}>
							搜索 Agent
						</Label>
						<div className="search relative">
							<Search
								aria-hidden="true"
								className="pointer-events-none absolute top-3 left-3 size-5 text-muted-foreground"
							/>
							<Input
								id={searchId}
								className="pl-10"
								type="search"
								placeholder="搜索名称、模板或渠道"
								maxLength={agentDiscoveryQueryMaxLength}
								value={query}
								onChange={(event) => {
									const nextQuery = event.target.value;
									if (!isControlled) setLocalQuery(nextQuery);
									onQueryChange?.(nextQuery);
								}}
							/>
						</div>
					</div>
					<div className="directory-filter">
						<Label htmlFor={`${searchId}-status`}>状态</Label>
						<NativeSelect
							id={`${searchId}-status`}
							value={statusFilter}
							onChange={(event) => setStatusFilter(event.target.value)}
						>
							<NativeSelectOption value="all">全部状态</NativeSelectOption>
							{["ready", "starting", "updating", "unavailable"].map(
								(status) => (
									<NativeSelectOption key={status} value={status}>
										{agentServiceAvailabilityLabel(
											status as NonNullable<
												AgentProjectionV2["serviceAvailability"]
											>,
										)}
									</NativeSelectOption>
								),
							)}
							{["creating", "creation_failed", "stopped", "disabled"].map(
								(status) => (
									<NativeSelectOption key={status} value={status}>
										{
											agentManagementStatusLabels[
												status as AgentProjectionV2["managementStatus"]
											]
										}
									</NativeSelectOption>
								),
							)}
						</NativeSelect>
					</div>
					<div className="directory-filter">
						<Label htmlFor={`${searchId}-template`}>模板</Label>
						<NativeSelect
							id={`${searchId}-template`}
							value={templateFilter}
							onChange={(event) => setTemplateFilter(event.target.value)}
						>
							<NativeSelectOption value="all">全部模板</NativeSelectOption>
							{templates.map((template) => (
								<NativeSelectOption key={template} value={template}>
									{template === "custom" ? "自定义 Agent" : template}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					<div className="directory-filter">
						<Label htmlFor={`${searchId}-model`}>模型</Label>
						<NativeSelect
							id={`${searchId}-model`}
							value={modelFilter}
							onChange={(event) => setModelFilter(event.target.value)}
						>
							<NativeSelectOption value="all">全部模型</NativeSelectOption>
							{models.map((model) => (
								<NativeSelectOption key={model} value={model}>
									{model}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
				</div>
			) : null}
			{state.kind === "loading" ? (
				<p aria-live="polite">正在加载 Agent…</p>
			) : state.kind === "unavailable" ? (
				<Alert>
					<AlertDescription>
						{state.retryable
							? "Agent 列表暂时无法读取，请稍后重试。"
							: "Agent 列表暂时无法访问，请联系管理员。"}
					</AlertDescription>
					{state.retryable && onRetry ? (
						<Button
							className="mt-4"
							variant="outline"
							disabled={retrying}
							onClick={onRetry}
							type="button"
						>
							<RefreshCw aria-hidden="true" data-icon="inline-start" />
							{retrying ? "正在重新加载…" : "重新加载 Agent"}
						</Button>
					) : null}
				</Alert>
			) : (
				<>
					<div className="directory-section-head">
						<div>
							<p className="directory-eyebrow">可发现</p>
							<h2 id="agent-catalog-heading">我的可用 Agent</h2>
						</div>
						<p className="hint text-muted-foreground text-sm" role="status">
							{agents.length} 个获授权 Agent
							{search ||
							statusFilter !== "all" ||
							templateFilter !== "all" ||
							modelFilter !== "all"
								? `，匹配 ${visible.length} 个`
								: ""}
						</p>
					</div>
					{!agents.length ? (
						<Empty className="py-8">
							<EmptyDescription>暂无你有权访问的 Agent。</EmptyDescription>
						</Empty>
					) : !visible.length ? (
						<Empty className="py-8">
							<EmptyDescription>未找到匹配的 Agent。</EmptyDescription>
							<Button
								variant="outline"
								onClick={() => {
									setLocalQuery("");
									onQueryChange?.("");
									setStatusFilter("all");
									setTemplateFilter("all");
									setModelFilter("all");
								}}
							>
								清除筛选
							</Button>
						</Empty>
					) : (
						<ul
							aria-labelledby="agent-catalog-heading"
							className="agent-list grid grid-cols-1 gap-4 min-[768px]:grid-cols-3"
						>
							{visible.map((agent) => (
								<li
									className="directory-card flex min-w-0 flex-col gap-4 border border-border bg-background p-[18px]"
									key={agent.agentId}
								>
									<div className="flex items-start justify-between gap-3">
										<span className="directory-symbol flex shrink-0 items-center justify-center border border-foreground bg-background">
											<Bot aria-hidden="true" className="size-5" />
										</span>
										<div className="flex flex-wrap justify-end gap-2">
											<Badge
												variant="outline"
												data-status={agent.managementStatus}
											>
												{agentManagementStatusLabels[agent.managementStatus]}
											</Badge>
											{agent.serviceAvailability && (
												<Badge
													variant="secondary"
													data-status={agent.serviceAvailability}
												>
													{agentServiceAvailabilityLabel(
														agent.serviceAvailability,
													)}
												</Badge>
											)}
										</div>
									</div>
									<div className="min-w-0 space-y-1">
										<h3 className="break-words font-semibold text-lg">
											{agent.name}
										</h3>
										<p className="break-words text-muted-foreground">
											{agent.description}
										</p>
									</div>
									<div className="directory-tags flex flex-wrap gap-2">
										<Badge variant="outline">{agentSourceLabel(agent)}</Badge>
										<Badge variant="outline">
											{agentChannelSummary(agent)}
										</Badge>
									</div>
									<div className="directory-card-foot mt-auto flex flex-wrap items-center gap-3 border-border border-t pt-3">
										<span className="min-w-0 break-words text-muted-foreground text-xs">
											Owner ·{" "}
											{agent.configuration.owners
												.map((owner) => owner.displayName)
												.join("、") || "未提供"}
										</span>
										{conversationSelection &&
										canStartPlatformConversation(agent) ? (
											<Link
												className={buttonVariants({ className: "min-w-0" })}
												params={{
													agentId: agent.agentId,
													conversationId: undefined,
												}}
												search={{ view: undefined }}
												to="/chat/$agentId/{-$conversationId}"
											>
												开始对话
												<ArrowRight aria-hidden="true" />
											</Link>
										) : (
											<Link
												className={cn(
													buttonVariants({
														variant: "ghost",
														className: "min-w-0",
													}),
												)}
												params={{ agentId: agent.agentId }}
												to="/agents/$agentId"
												aria-label={`查看 ${agent.name} 详情`}
											>
												查看详情
												<ArrowRight aria-hidden="true" />
											</Link>
										)}
									</div>
								</li>
							))}
						</ul>
					)}
				</>
			)}
		</section>
	);
}
