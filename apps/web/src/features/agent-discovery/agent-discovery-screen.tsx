import { Link } from "@tanstack/react-router";
import { ArrowRight, Bot, Search } from "lucide-react";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type { AgentDiscoveryState } from "./agent-discovery.js";

type AgentDiscoveryScreenProps = {
	query?: string;
	onQueryChange?: (query: string) => void;
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

export function AgentDiscoveryScreen({
	query: controlledQuery,
	onQueryChange,
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
		`${agent.name}\n${agent.description}`.toLocaleLowerCase().includes(search),
	);
	return (
		<section aria-labelledby="agents-heading" className="space-y-6">
			<header className="page-heading">
				<div>
					<h1 id="agents-heading" className="font-semibold text-[28px]">
						Agent
					</h1>
					<p className="mt-2 text-muted-foreground">
						发现并使用你有权访问的 Agent。
					</p>
				</div>
			</header>
			{state.kind === "loading" ? (
				<p aria-live="polite">正在加载 Agent…</p>
			) : state.kind === "unavailable" ? (
				<p role="alert" className="text-muted-foreground">
					{state.retryable
						? "Agent 列表暂时无法读取，请稍后重试。"
						: "Agent 列表暂时无法访问，请联系管理员。"}
				</p>
			) : (
				<>
					<div className="flex list-tools flex-wrap items-end justify-between gap-4 border-border border-b pb-6">
						<div className="field w-full space-y-2 sm:max-w-sm">
							<Label htmlFor={searchId}>搜索 Agent</Label>
							<div className="search relative">
								<Search
									aria-hidden="true"
									className="pointer-events-none absolute top-3 left-3 size-5 text-muted-foreground"
								/>
								<Input
									id={searchId}
									className="pl-10"
									type="search"
									placeholder="按名称或用途搜索"
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
						<p className="hint text-muted-foreground text-sm" role="status">
							{agents.length} 个获授权 Agent
							{search ? `，匹配 ${visible.length} 个` : ""}
						</p>
					</div>
					{!agents.length ? (
						<p className="py-8 text-muted-foreground">
							暂无你有权访问的 Agent。
						</p>
					) : !visible.length ? (
						<p className="py-8 text-muted-foreground">未找到匹配的 Agent。</p>
					) : (
						<ul className="agent-list divide-y divide-border">
							{visible.map((agent) => (
								<li
									className="agent-row flex flex-wrap items-start gap-5 py-7 sm:items-center"
									key={agent.agentId}
								>
									<div className="agent-symbol flex size-12 shrink-0 items-center justify-center rounded border border-border bg-muted">
										<Bot aria-hidden="true" className="size-6" />
									</div>
									<div className="agent-summary min-w-0 flex-1 space-y-2">
										<div className="line-title flex flex-wrap items-center gap-3">
											<h2 className="break-words font-semibold text-lg">
												{agent.name}
											</h2>
											<Badge variant="outline">
												{agentManagementStatusLabels[agent.managementStatus]}
											</Badge>
											{agent.serviceAvailability && (
												<Badge variant="secondary">
													{agentServiceAvailabilityLabel(
														agent.serviceAvailability,
													)}
												</Badge>
											)}
										</div>
										<p className="break-words text-muted-foreground">
											{agent.description}
										</p>
										<div className="metadata flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground text-sm">
											<span>
												{agent.source.kind === "standard"
													? `标准模板 · ${agent.source.templateId}`
													: "自定义 Agent"}
											</span>
											<span>
												Owner ·{" "}
												{agent.configuration.owners
													.map((owner) => owner.displayName)
													.join("、") || "未提供"}
											</span>
											<span>
												{agent.configuration.channels
													.filter((channel) =>
														["available", "bound"].includes(channel.status),
													)
													.map(
														(channel) => agentChannelKindLabels[channel.kind],
													)
													.join("、") ||
													(agent.source.kind === "custom" &&
													agent.source.interactionMode === "self-managed"
														? "自有交互入口"
														: "暂无可用渠道")}
											</span>
										</div>
									</div>
									<Link
										className={buttonVariants({
											variant: "outline",
											className: "min-w-0",
										})}
										params={{ agentId: agent.agentId }}
										to="/agents/$agentId"
										aria-label={`查看 ${agent.name} 详情`}
									>
										查看详情
										<ArrowRight aria-hidden="true" />
									</Link>
								</li>
							))}
						</ul>
					)}
					<p className="quiet-note text-muted-foreground text-sm">
						仅显示当前身份获授权的 Agent。
					</p>
				</>
			)}
		</section>
	);
}
