import { Link } from "@tanstack/react-router";
import { ArrowRight, Bot, RefreshCw, Search } from "lucide-react";
import { useId, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import {
	type AgentDiscoveryState,
	canStartPlatformConversation,
} from "./agent-discovery.js";

type AgentDiscoveryScreenProps = {
	connectionUrl?: string;
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
	connectionUrl,
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
	const search = query.trim().toLocaleLowerCase();
	// Search narrows the already authorized response; it never discovers another
	// collection or treats a client-side filter as authorization.
	const agents = state.kind === "ready" ? state.agents : [];
	const visible = agents.filter((agent) =>
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
					<p className="directory-eyebrow">当前用户可用范围</p>
					<h1 id="agents-heading" className="font-semibold text-[28px]">
						{conversationSelection
							? "选择 Agent 开始对话"
							: "选择一个 Agent 开始工作。"}
					</h1>
					<p className="mt-2 text-muted-foreground">
						{conversationSelection
							? "选择当前可用的 Agent，继续文本对话。"
							: "发现并使用你有权访问的 Agent。"}
					</p>
				</div>
				{state.kind === "ready" ? (
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
				) : null}
			</header>
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
							{search ? `，匹配 ${visible.length} 个` : ""}
						</p>
					</div>
					{!agents.length ? (
						<Empty className="py-8">
							<EmptyDescription>暂无你有权访问的 Agent。</EmptyDescription>
						</Empty>
					) : !visible.length ? (
						<Empty className="py-8">
							<EmptyDescription>未找到匹配的 Agent。</EmptyDescription>
						</Empty>
					) : (
						<ul
							aria-labelledby="agent-catalog-heading"
							className="agent-list grid grid-cols-1 gap-4 min-[821px]:grid-cols-3"
						>
							{visible.map((agent) => (
								<li
									className="directory-card flex min-w-0 flex-col gap-4 border border-border bg-background p-5"
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
														variant: "outline",
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
					<section aria-label="使用引导" className="directory-guidance">
						<article className="directory-guidance-card">
							<p className="directory-eyebrow">使用前</p>
							<h3>确认你的 Connection 授权</h3>
							<p className="text-muted-foreground">
								外部账号及授权在独立的 Connection 系统中管理。使用前请到
								Connection 确认你的授权。
							</p>
							{connectionUrl ? (
								<a
									className={cn(
										buttonVariants({
											variant: "outline",
											className: "min-w-0 max-w-full break-words",
										}),
									)}
									href={connectionUrl}
									target="_blank"
									rel="noreferrer"
								>
									查看我的 Connection
								</a>
							) : (
								<p className="text-muted-foreground">
									暂时无法打开 Connection，请联系管理员确认访问入口。
								</p>
							)}
						</article>
						<article className="directory-guidance-card">
							<p className="directory-eyebrow">没有找到</p>
							<h3>可见范围由 Owner 维护</h3>
							<p className="text-muted-foreground">
								联系 Agent Owner，确认你的员工账号或所属组织是否在该 Agent
								的可用范围内。
							</p>
							<Link
								className={cn(
									buttonVariants({
										variant: "outline",
										className: "min-w-0 max-w-full break-words",
									}),
								)}
								to="/my-agents"
							>
								查看我的申请
							</Link>
						</article>
					</section>
					<p className="quiet-note text-muted-foreground text-sm">
						仅显示当前身份获授权的 Agent。
					</p>
				</>
			)}
		</section>
	);
}
