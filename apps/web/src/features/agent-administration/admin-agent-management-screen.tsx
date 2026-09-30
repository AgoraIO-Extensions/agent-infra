import { Link } from "@tanstack/react-router";
import { ArrowLeft, RefreshCw, Settings2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import type { AgentDiscoveryState } from "../agent-discovery/agent-discovery.js";
import { agentServiceAvailabilityLabel } from "../agent-discovery/agent-discovery-screen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import { AgentLifecycleWorkflow } from "./agent-lifecycle-workflow.js";

type AdminAgentManagementScreenProps = {
	state:
		| AgentDiscoveryState
		| { kind: "loading" }
		| { kind: "contract-pending" };
	onRetry?: () => void;
	retrying?: boolean;
};

export function AdminAgentManagementScreen({
	state,
	onRetry,
	retrying = false,
}: AdminAgentManagementScreenProps) {
	return (
		<section className="space-y-6" aria-labelledby="admin-agents-heading">
			<header className="page-heading flex flex-wrap items-end justify-between gap-5">
				<div className="min-w-0">
					<p className="mb-2 text-muted-foreground text-sm">系统管理员</p>
					<h1
						id="admin-agents-heading"
						className="break-words font-semibold text-[28px]"
					>
						管理 Agent 的系统状态。
					</h1>
					<p className="mt-2 max-w-2xl text-muted-foreground">
						处理创建失败与系统级停用。Owner 的停止和重启在“我的 Agent”中完成。
					</p>
				</div>
				<Link
					className={buttonVariants({ variant: "outline" })}
					to="/admin/approvals"
				>
					<Settings2 aria-hidden="true" />
					创建审批
				</Link>
			</header>
			{state.kind === "contract-pending" ? (
				<Alert>
					<AlertDescription>
						Agent 列表暂不可用。请在创建审批页处理待办。
					</AlertDescription>
				</Alert>
			) : state.kind === "loading" ? (
				<p role="status">正在读取 Agent…</p>
			) : state.kind === "unavailable" ? (
				<Alert>
					<AlertDescription>
						{state.retryable
							? "暂时无法读取 Agent，请稍后重试。"
							: "当前无法查看 Agent，请联系平台管理员。"}
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
			) : state.agents.length === 0 ? (
				<Empty>
					<EmptyTitle>暂无可管理 Agent</EmptyTitle>
					<EmptyDescription>服务端授权的 Agent 会显示在这里。</EmptyDescription>
				</Empty>
			) : (
				<ul
					className="divide-y divide-border border-border border-y"
					aria-label="系统 Agent 列表"
				>
					{state.agents.map((agent) => (
						<li key={agent.agentId} className="space-y-5 py-6">
							<div className="flex flex-wrap items-start justify-between gap-4">
								<div className="min-w-0 space-y-2">
									<div className="flex flex-wrap items-center gap-3">
										<h2 className="break-words font-semibold text-lg">
											{agent.name}
										</h2>
										<Badge variant="outline">
											{agentManagementStatusLabels[agent.managementStatus]}
										</Badge>
										{agent.serviceAvailability ? (
											<Badge variant="secondary">
												{agentServiceAvailabilityLabel(
													agent.serviceAvailability,
												)}
											</Badge>
										) : null}
									</div>
									<p className="break-words text-muted-foreground text-sm">
										{agent.description}
									</p>
								</div>
								<Link
									className={buttonVariants({
										variant: "link",
										className: "px-0",
									})}
									params={{ agentId: agent.agentId }}
									to="/agents/$agentId"
								>
									查看详情
								</Link>
							</div>
							<div className="border-border border-l-2 pl-4">
								<AgentLifecycleWorkflow agent={agent} />
							</div>
						</li>
					))}
				</ul>
			)}
			<Link
				className={buttonVariants({ variant: "link", className: "px-0" })}
				to="/"
			>
				<ArrowLeft aria-hidden="true" />
				返回工作台
			</Link>
		</section>
	);
}
