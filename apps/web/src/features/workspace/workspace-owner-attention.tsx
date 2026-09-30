import { Link } from "@tanstack/react-router";
import { Plus, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import type { AgentDiscoveryState } from "../agent-discovery/agent-discovery.js";
import type { MyAgentApplicationsState } from "../my-agents/my-agent-applications.js";

export type WorkspaceOwnerAttentionProps = {
	ownedAgents: AgentDiscoveryState | { kind: "loading" };
	applications: MyAgentApplicationsState | { kind: "loading" };
	onRetryOwnedAgents?: () => void;
	onRetryApplications?: () => void;
	retryingOwnedAgents?: boolean;
	retryingApplications?: boolean;
};

export function WorkspaceOwnerAttention({
	ownedAgents,
	applications,
	onRetryOwnedAgents,
	onRetryApplications,
	retryingOwnedAgents = false,
	retryingApplications = false,
}: WorkspaceOwnerAttentionProps) {
	const rejectedApplications =
		applications.kind === "ready"
			? applications.applications.filter(
					(application) => application.status === "rejected",
				)
			: [];
	const failedAgents =
		ownedAgents.kind === "ready"
			? ownedAgents.agents.filter(
					(agent) => agent.managementStatus === "creation_failed",
				)
			: [];
	const dataReady =
		ownedAgents.kind === "ready" && applications.kind === "ready";

	if (
		dataReady &&
		ownedAgents.agents.length === 0 &&
		rejectedApplications.length === 0
	)
		return null;

	return (
		<section
			className="space-y-4 border-border border-t pt-7"
			aria-labelledby="workspace-owner-attention-heading"
			aria-busy={
				ownedAgents.kind === "loading" || applications.kind === "loading"
			}
			data-od-id="owner-attention"
		>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0">
					<p className="workspace-eyebrow text-muted-foreground text-sm">
						Owner 关注
					</p>
					<h2
						id="workspace-owner-attention-heading"
						className="font-semibold text-xl"
					>
						需要你处理
					</h2>
				</div>
				<Link className={buttonVariants()} to="/my-agents/new">
					<Plus aria-hidden="true" />
					创建 Agent
				</Link>
			</div>

			{ownedAgents.kind === "loading" ? (
				<p role="status" className="text-muted-foreground text-sm">
					正在读取待办 Agent…
				</p>
			) : null}
			{ownedAgents.kind === "unavailable" ? (
				<Alert>
					<AlertDescription className="flex min-w-0 flex-wrap items-center justify-between gap-3">
						<span>暂时无法读取待办 Agent。</span>
						{ownedAgents.retryable && onRetryOwnedAgents ? (
							<Button
								variant="outline"
								disabled={retryingOwnedAgents}
								onClick={onRetryOwnedAgents}
								type="button"
							>
								<RefreshCw aria-hidden="true" data-icon="inline-start" />
								{retryingOwnedAgents
									? "正在重新加载待办 Agent…"
									: "重新加载待办 Agent"}
							</Button>
						) : null}
					</AlertDescription>
				</Alert>
			) : null}

			{applications.kind === "loading" ? (
				<p role="status" className="text-muted-foreground text-sm">
					正在读取申请待办…
				</p>
			) : null}
			{applications.kind === "unavailable" ? (
				<Alert>
					<AlertDescription className="flex min-w-0 flex-wrap items-center justify-between gap-3">
						<span>暂时无法读取申请待办。</span>
						{applications.retryable && onRetryApplications ? (
							<Button
								variant="outline"
								disabled={retryingApplications}
								onClick={onRetryApplications}
								type="button"
							>
								<RefreshCw aria-hidden="true" data-icon="inline-start" />
								{retryingApplications
									? "正在重新加载申请待办…"
									: "重新加载申请待办"}
							</Button>
						) : null}
					</AlertDescription>
				</Alert>
			) : null}

			{rejectedApplications.length > 0 || failedAgents.length > 0 ? (
				<ul
					className="grid gap-4 min-[821px]:grid-cols-2"
					aria-label="Owner 待办"
				>
					{rejectedApplications.map((application) => (
						<li
							key={`application:${application.applicationId}`}
							className="workspace-card flex min-w-0 flex-col gap-4 border border-border bg-background p-5"
							data-od-id="owner-task-rejected"
						>
							<div className="min-w-0">
								<Badge variant="destructive">已驳回</Badge>
								<h3 className="mt-2 font-semibold text-lg [overflow-wrap:anywhere]">
									{application.name}
								</h3>
							</div>
							<p className="min-w-0 text-muted-foreground text-sm [overflow-wrap:anywhere]">
								{application.decision?.reason?.trim() ||
									"申请已被驳回，暂未提供具体原因。请查看申请并修改后重新提交。"}
							</p>
							<div className="mt-auto">
								<Link
									className={buttonVariants({ variant: "outline", size: "sm" })}
									params={{ applicationId: application.applicationId }}
									to="/my-agents/$applicationId"
								>
									查看原因并修改
								</Link>
							</div>
						</li>
					))}
					{failedAgents.map((agent) => (
						<li
							key={`agent:${agent.agentId}`}
							className="workspace-card flex min-w-0 flex-col gap-4 border border-border bg-background p-5"
							data-od-id="owner-task-failed"
						>
							<div className="min-w-0">
								<Badge variant="destructive">创建失败</Badge>
								<h3 className="mt-2 font-semibold text-lg [overflow-wrap:anywhere]">
									{agent.name}
								</h3>
							</div>
							<p className="min-w-0 text-muted-foreground text-sm [overflow-wrap:anywhere]">
								Agent 创建失败。请查看当前状态，按页面提供的操作重试。
							</p>
							<div className="mt-auto">
								<Link
									className={buttonVariants({ variant: "outline", size: "sm" })}
									params={{ agentId: agent.agentId }}
									to="/agents/$agentId/configuration"
								>
									查看状态并重试
								</Link>
							</div>
						</li>
					))}
				</ul>
			) : null}

			{dataReady &&
			rejectedApplications.length === 0 &&
			failedAgents.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					当前没有需要你处理的事项。
				</p>
			) : null}
		</section>
	);
}
