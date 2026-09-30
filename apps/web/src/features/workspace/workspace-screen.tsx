import { Link } from "@tanstack/react-router";
import { Bot, CheckCheck, Plus, RefreshCw, Settings2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import type { AgentDiscoveryState } from "../agent-discovery/agent-discovery.js";
import { agentServiceAvailabilityLabel } from "../agent-discovery/agent-discovery-screen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type { MyAgentApplicationsState } from "../my-agents/my-agent-applications.js";

type WorkspaceState<T> = T | { kind: "loading" };

type WorkspaceScreenProps = {
	agents: WorkspaceState<AgentDiscoveryState>;
	applications: WorkspaceState<MyAgentApplicationsState>;
	isAdmin: boolean;
	onRetryAgents?: () => void;
	onRetryApplications?: () => void;
	retryingAgents?: boolean;
	retryingApplications?: boolean;
};

function AgentState({ state }: { state: WorkspaceState<AgentDiscoveryState> }) {
	if (state.kind === "loading") return <p role="status">正在读取可用 Agent…</p>;
	if (state.kind === "unavailable")
		return (
			<p className="text-muted-foreground">暂时无法读取 Agent，请稍后重试。</p>
		);
	if (state.agents.length === 0)
		return (
			<Empty className="py-8">
				<EmptyTitle>暂无可用 Agent</EmptyTitle>
				<EmptyDescription>有权访问的 Agent 会显示在这里。</EmptyDescription>
			</Empty>
		);
	return (
		<ul
			className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
			aria-label="可用 Agent"
		>
			{state.agents.slice(0, 3).map((agent) => {
				const ready =
					agent.managementStatus === "available" &&
					agent.serviceAvailability === "ready";
				return (
					<li
						key={agent.agentId}
						className="flex min-w-0 flex-col gap-4 border border-border bg-background p-5"
					>
						<div className="flex items-start justify-between gap-3">
							<span className="flex size-10 shrink-0 items-center justify-center border border-border bg-muted">
								<Bot aria-hidden="true" className="size-5" />
							</span>
							<Badge variant="outline">
								{agentManagementStatusLabels[agent.managementStatus]}
							</Badge>
						</div>
						<div className="min-w-0 space-y-2">
							<h3 className="break-words font-semibold text-lg">
								{agent.name}
							</h3>
							<p className="break-words text-muted-foreground text-sm">
								{agent.description}
							</p>
							{agent.serviceAvailability ? (
								<p className="text-muted-foreground text-sm">
									服务：
									{agentServiceAvailabilityLabel(agent.serviceAvailability)}
								</p>
							) : null}
						</div>
						<div className="mt-auto flex flex-wrap gap-2">
							<Link
								className={buttonVariants({ variant: "outline", size: "sm" })}
								params={{ agentId: agent.agentId }}
								to="/agents/$agentId"
							>
								查看详情
							</Link>
							{ready ? (
								<Link
									className={buttonVariants({ size: "sm" })}
									params={{ agentId: agent.agentId }}
									search={{ conversation: undefined, view: undefined }}
									to="/agents/$agentId/conversations"
								>
									开始对话
								</Link>
							) : null}
						</div>
					</li>
				);
			})}
		</ul>
	);
}

function ApplicationState({
	state,
	onRetry,
	retrying,
}: {
	state: WorkspaceState<MyAgentApplicationsState>;
	onRetry?: () => void;
	retrying: boolean;
}) {
	if (state.kind === "loading") return <p role="status">正在读取我的申请…</p>;
	if (state.kind === "unavailable")
		return (
			<Alert>
				<AlertDescription className="flex flex-wrap items-center justify-between gap-3">
					<span>暂时无法读取申请。</span>
					{state.retryable && onRetry ? (
						<Button
							variant="outline"
							disabled={retrying}
							onClick={onRetry}
							type="button"
						>
							<RefreshCw aria-hidden="true" data-icon="inline-start" />
							{retrying ? "正在重新加载…" : "重新加载申请"}
						</Button>
					) : null}
				</AlertDescription>
			</Alert>
		);
	if (state.applications.length === 0)
		return (
			<Empty className="py-8">
				<EmptyTitle>暂无申请</EmptyTitle>
				<EmptyDescription>
					提交申请后，可在这里查看审批与创建进度。
				</EmptyDescription>
			</Empty>
		);
	return (
		<ul
			className="divide-y divide-border border-border border-y"
			aria-label="我的申请"
		>
			{state.applications.slice(0, 3).map((application) => (
				<li
					key={application.applicationId}
					className="flex flex-wrap items-center justify-between gap-4 py-4"
				>
					<div className="min-w-0">
						<Link
							className="font-medium hover:underline"
							params={{ applicationId: application.applicationId }}
							to="/my-agents/$applicationId"
						>
							{application.name}
						</Link>
						<p className="break-words text-muted-foreground text-sm">
							{application.description}
						</p>
					</div>
					<Badge variant="outline">
						{agentManagementStatusLabels[application.status]}
					</Badge>
				</li>
			))}
		</ul>
	);
}

export function WorkspaceScreen({
	agents,
	applications,
	isAdmin,
	onRetryAgents,
	onRetryApplications,
	retryingAgents = false,
	retryingApplications = false,
}: WorkspaceScreenProps) {
	return (
		<main className="platform-content management-content">
			<div className="space-y-10">
				<header className="page-heading flex flex-wrap items-end justify-between gap-5">
					<div className="min-w-0">
						<h1 className="break-words font-semibold text-[28px]">工作台</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground">
							发现和使用 Agent，跟进自己的创建申请；Owner
							维护配置，系统管理员处理资源审批与系统状态。
						</p>
					</div>
					<div className="flex flex-wrap gap-3">
						<Link
							className={buttonVariants({ variant: "outline" })}
							to="/agents"
						>
							<Bot aria-hidden="true" />
							浏览 Agent
						</Link>
						<Link className={buttonVariants()} to="/my-agents/new">
							<Plus aria-hidden="true" />
							申请 Agent
						</Link>
					</div>
				</header>

				<section
					className="space-y-4"
					aria-labelledby="workspace-agents-heading"
				>
					<div className="flex flex-wrap items-end justify-between gap-3">
						<div>
							<p className="text-muted-foreground text-sm">当前可用范围</p>
							<h2
								id="workspace-agents-heading"
								className="font-semibold text-xl"
							>
								可用 Agent
							</h2>
						</div>
						<Link className={buttonVariants({ variant: "link" })} to="/agents">
							查看全部
						</Link>
					</div>
					{agents.kind === "unavailable" && onRetryAgents ? (
						<Alert>
							<AlertDescription className="flex flex-wrap items-center justify-between gap-3">
								<span>暂时无法读取可用 Agent。</span>
								{agents.retryable ? (
									<Button
										variant="outline"
										disabled={retryingAgents}
										onClick={onRetryAgents}
										type="button"
									>
										<RefreshCw aria-hidden="true" data-icon="inline-start" />
										{retryingAgents ? "正在重新加载…" : "重新加载 Agent"}
									</Button>
								) : null}
							</AlertDescription>
						</Alert>
					) : (
						<AgentState state={agents} />
					)}
				</section>

				<section
					className="space-y-4 border-border border-t pt-8"
					aria-labelledby="workspace-applications-heading"
				>
					<div className="flex flex-wrap items-end justify-between gap-3">
						<div>
							<p className="text-muted-foreground text-sm">我的申请</p>
							<h2
								id="workspace-applications-heading"
								className="font-semibold text-xl"
							>
								创建状态
							</h2>
						</div>
						<Link
							className={buttonVariants({ variant: "link" })}
							to="/my-agents"
						>
							查看我的 Agent
						</Link>
					</div>
					<ApplicationState
						onRetry={onRetryApplications}
						retrying={retryingApplications}
						state={applications}
					/>
				</section>

				{isAdmin ? (
					<section
						className="space-y-4 border-border border-t pt-8"
						aria-labelledby="workspace-admin-heading"
					>
						<div>
							<p className="text-muted-foreground text-sm">系统管理</p>
							<h2
								id="workspace-admin-heading"
								className="font-semibold text-xl"
							>
								需要管理员处理
							</h2>
						</div>
						<div className="grid gap-4 md:grid-cols-2">
							<Link
								className="group flex min-h-28 items-start gap-4 border border-border bg-background p-5 hover:border-foreground"
								to="/admin/approvals"
							>
								<CheckCheck aria-hidden="true" className="mt-1 size-5" />
								<span className="min-w-0">
									<strong className="block">创建审批</strong>
									<span className="mt-1 block text-muted-foreground text-sm">
										审核来源、Owner、范围和资源占用。
									</span>
								</span>
							</Link>
							<Link
								className="group flex min-h-28 items-start gap-4 border border-border bg-background p-5 hover:border-foreground"
								to="/admin/agents"
							>
								<Settings2 aria-hidden="true" className="mt-1 size-5" />
								<span className="min-w-0">
									<strong className="block">Agent 管理</strong>
									<span className="mt-1 block text-muted-foreground text-sm">
										查看状态并处理停止、重启、停用和创建失败。
									</span>
								</span>
							</Link>
						</div>
					</section>
				) : null}
			</div>
		</main>
	);
}
