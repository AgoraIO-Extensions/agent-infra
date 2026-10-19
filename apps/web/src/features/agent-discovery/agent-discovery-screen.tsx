import { Link } from "@tanstack/react-router";
import { ArrowRight, Bot, Plus, Search } from "lucide-react";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { SearchInput } from "@/components/ui/search-input";
import { LoadingLine } from "@/components/ui/spinner";
import { distinctObjectNames } from "@/lib/accessible-name";
import { cn } from "@/lib/utils";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	agentAvailabilityStatus,
	agentConversationSourceLabel,
	agentManagementStatusLabels,
	agentServiceAvailabilityLabel,
} from "../agent-management-status.js";
import { AgentMark } from "../agent-mark.js";
import { PageStateCard } from "../page-state-card.js";
import { RecoveryButton } from "../recovery-button.js";
import {
	type TemplateNameLookup,
	templateDisplayName,
} from "../template-display-name.js";
import {
	type AgentDiscoveryState,
	canStartPlatformConversation,
} from "./agent-discovery.js";

type AgentDiscoveryScreenProps = {
	conversationSelection?: boolean;
	query?: string;
	onQueryChange?: (query: string) => void;
	onRetry?: () => void;
	/** 目录读取返回 401 时的「重新登录」：由壳层重新确认浏览器会话。 */
	onRelogin?: () => void;
	retrying?: boolean;
	state: AgentDiscoveryState | { kind: "loading" };
	/** 模板显示名（部署配置）；未提供或读不到时显示「标准模板」（F-02）。 */
	templateName?: TemplateNameLookup;
};

export const agentDiscoveryQueryMaxLength = 256;

export const agentChannelKindLabels = {
	web: "Web",
	wecom_bot: "企微机器人",
	wecom_app: "企微应用",
} satisfies Record<
	AgentProjectionV2["configuration"]["channels"][number]["kind"],
	string
>;

function selfManagedInteraction(agent: AgentProjectionV2) {
	return (
		agent.source.kind === "custom" &&
		agent.source.interactionMode === "self-managed"
	);
}

/** 卡片底部第二行：可选择的模型显示名；自有交互入口的 Agent 由其自行管理模型。 */
function agentModelSummary(agent: AgentProjectionV2) {
	if (selfManagedInteraction(agent)) return "由 Agent 自行管理";
	return (
		agent.configuration.modelOptions
			.map((option) => option.displayName)
			.join(" · ") || "无可选择模型"
	);
}

/**
 * 「模型」筛选项：value 是 modelId（按它去重与筛选），文字是模型显示名，不外露 modelId。
 * 同一 modelId 取第一次出现的显示名；不同模型显示名相同时按出现顺序加「（第 N 次）」区分。
 */
function modelFilterOptions(agents: readonly AgentProjectionV2[]) {
	const names = new Map<string, string>();
	for (const agent of agents)
		for (const option of agent.configuration.modelOptions)
			if (!names.has(option.modelId))
				names.set(option.modelId, option.displayName);
	const labels = distinctObjectNames([...names.values()]);
	return [...names.keys()].map((modelId, index) => ({
		modelId,
		label: labels[index] ?? "",
	}));
}

/**
 * 目录读取失败按原因显示公共状态卡（设计 .state-card，A-03）：401 / 403 / 404 / 响应无效 / 503
 * 各一张。读取失败用 role="alert"，403 是权限边界不设 role（由 PageStateCard 按 kind 决定）。
 */
function DirectoryUnavailable({
	state,
	onRetry,
	onRelogin,
	retrying,
}: {
	state: Extract<AgentDiscoveryState, { kind: "unavailable" }>;
	onRetry?: () => void;
	onRelogin?: () => void;
	retrying: boolean;
}) {
	if (state.reason === "authentication-required")
		return (
			<PageStateCard
				kind="login"
				title="登录已过期"
				// 经壳层重读会话；会话仍有效时由目录页重新读取列表（useSessionRecheck）。
				action={
					onRelogin ? (
						<RecoveryButton
							recoveryKey="重新登录"
							busy={retrying}
							onClick={onRelogin}
						>
							重新登录
						</RecoveryButton>
					) : null
				}
			/>
		);
	if (state.reason === "denied")
		return (
			<PageStateCard
				kind="unauthorized"
				description="你没有访问 Agent 目录的权限。"
			/>
		);
	// 列表入口 404 是读取失败（不是地址错误），用 unavailable 的播报语义，但没有可重试的操作。
	if (state.reason === "not-found")
		return (
			<PageStateCard
				kind="unavailable"
				title="目录入口不可用"
				description="当前部署没有提供 Agent 目录的读取入口。"
				action={null}
			/>
		);
	if (state.reason === "invalid-response")
		return (
			<PageStateCard
				kind="invalid"
				title="目录数据无法读取"
				description="服务返回的 Agent 列表无法识别，页面不会展示其中的内容。"
			/>
		);
	return (
		<PageStateCard
			kind="unavailable"
			description={
				state.retryable
					? "暂时无法读取 Agent 列表，请稍后重试。"
					: "暂时无法读取 Agent 列表。"
			}
			onRetry={state.retryable ? onRetry : undefined}
			retrying={retrying}
			retryLabel="重新加载 Agent"
		/>
	);
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
	onRelogin,
	retrying = false,
	state,
	templateName,
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
	const models = modelFilterOptions(agents);
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
				agentConversationSourceLabel(agent, templateName),
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
					{/* tabIndex=-1：「重新登录」「重新加载 Agent」恢复后焦点落在这里（RecoveryButton）。 */}
					<h1
						id="agents-heading"
						tabIndex={-1}
						className="font-semibold text-[28px]"
					>
						{conversationSelection
							? "选择 Agent 开始对话"
							: "选择要使用的 Agent。"}
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
					<SearchInput
						wrapperClassName="directory-search w-full"
						label="搜索 Agent"
						id={searchId}
						placeholder="搜索名称、模板或渠道"
						maxLength={agentDiscoveryQueryMaxLength}
						value={query}
						onChange={(event) => {
							const nextQuery = event.target.value;
							if (!isControlled) setLocalQuery(nextQuery);
							onQueryChange?.(nextQuery);
						}}
					/>
					<Field>
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
					</Field>
					<Field>
						<Label htmlFor={`${searchId}-template`}>模板</Label>
						<NativeSelect
							id={`${searchId}-template`}
							value={templateFilter}
							onChange={(event) => setTemplateFilter(event.target.value)}
						>
							<NativeSelectOption value="all">全部模板</NativeSelectOption>
							{templates.map((template) => (
								<NativeSelectOption key={template} value={template}>
									{template === "custom"
										? "自定义 Agent"
										: templateDisplayName(template, templateName)}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<Field>
						<Label htmlFor={`${searchId}-model`}>模型</Label>
						<NativeSelect
							id={`${searchId}-model`}
							value={modelFilter}
							onChange={(event) => setModelFilter(event.target.value)}
						>
							<NativeSelectOption value="all">全部模型</NativeSelectOption>
							{models.map((model) => (
								<NativeSelectOption key={model.modelId} value={model.modelId}>
									{model.label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
				</div>
			) : null}
			{state.kind === "loading" ? (
				<LoadingLine>正在加载 Agent…</LoadingLine>
			) : state.kind === "unavailable" ? (
				<DirectoryUnavailable
					state={state}
					onRetry={onRetry}
					onRelogin={onRelogin}
					retrying={retrying}
				/>
			) : (
				<>
					<div className="directory-section-head">
						<div>
							<h2 id="agent-catalog-heading">可用范围</h2>
							<p className="directory-section-description">已授权的 Agent</p>
						</div>
						{/* 计数是筛选后的结果数；筛选变化时由 role=status 播报。 */}
						<div role="status">
							<Badge variant="chip" tone="gray">
								{visible.length} 个结果
							</Badge>
						</div>
					</div>
					{!agents.length ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia>
									<Bot aria-hidden="true" />
								</EmptyMedia>
								<EmptyTitle>暂无你有权访问的 Agent</EmptyTitle>
								<EmptyDescription>
									目录只展示当前账号有权访问的 Agent。
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : !visible.length ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia>
									<Search aria-hidden="true" />
								</EmptyMedia>
								<EmptyTitle>没有匹配的 Agent</EmptyTitle>
								<EmptyDescription>
									换一个名称、模板或渠道关键词再试。
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
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
							</EmptyContent>
						</Empty>
					) : (
						<ul
							aria-labelledby="agent-catalog-heading"
							className="agent-list grid grid-cols-1 gap-4 min-[768px]:grid-cols-3"
						>
							{visible.map((agent) => {
								const availability = agentAvailabilityStatus(agent);
								return (
									<Card
										render={<li />}
										className="directory-card flex flex-col gap-4"
										key={agent.agentId}
									>
										<div className="flex items-start justify-between gap-3">
											<AgentMark name={agent.name} agentId={agent.agentId} />
											{/* A-02：只显示一个派生可用性状态。 */}
											<Badge variant="chip" tone={availability.tone}>
												{availability.label}
											</Badge>
										</div>
										<div className="min-w-0 space-y-1">
											<h3 className="break-words">{agent.name}</h3>
											<p className="break-words text-muted-foreground">
												{agent.description}
											</p>
										</div>
										<div className="directory-tags flex flex-wrap gap-2">
											<Badge variant="tag">
												{agentConversationSourceLabel(agent, templateName)}
											</Badge>
											<Badge variant="tag">{agentChannelSummary(agent)}</Badge>
										</div>
										<div className="directory-card-foot mt-auto">
											<div className="directory-card-foot-main">
												<small>
													Owner ·{" "}
													{agent.configuration.owners
														.map((owner) => owner.displayName)
														.join("、") || "未提供"}
												</small>
												<small>{agentModelSummary(agent)}</small>
											</div>
											<div className="directory-card-foot-side">
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
										</div>
									</Card>
								);
							})}
						</ul>
					)}
				</>
			)}
		</section>
	);
}
