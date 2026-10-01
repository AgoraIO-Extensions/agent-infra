import { Link } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import type {
	AgentProjectionV2,
	ConversationDetailProjectionV2,
} from "../../pilot/generated-v2/types.gen.js";
import type { AdminAgentsState } from "../admin-agents/admin-agents.js";
import type { PendingAgentApplicationsState } from "../agent-administration/agent-administration.js";
import {
	type AgentDiscoveryState,
	canStartPlatformConversation,
} from "../agent-discovery/agent-discovery.js";
import { agentServiceAvailabilityLabel } from "../agent-discovery/agent-discovery-screen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type {
	CollectionReadFailureReason,
	CollectionReadUnavailable,
} from "../collection-read-failure.js";
import type { MyAgentApplicationsState } from "../my-agents/my-agent-applications.js";

type Loading = { kind: "loading" };
type Unavailable = CollectionReadUnavailable;
export type WorkbenchRecentState =
	| Loading
	| Unavailable
	| {
			kind: "ready";
			conversations: ConversationDetailProjectionV2["conversation"][];
			nextCursor: string | null;
	  };

export type WorkbenchScreenProps = {
	agents: AgentDiscoveryState | Loading;
	ownerAgents: AgentDiscoveryState | Loading;
	applications: MyAgentApplicationsState | Loading;
	pending: PendingAgentApplicationsState | Loading;
	adminAgents: AdminAgentsState;
	recent: WorkbenchRecentState;
	administrator: boolean;
	onRetry: () => void;
	refreshing?: boolean;
	onLoadMoreRecent?: () => void;
};

function WorkbenchSection({
	eyebrow,
	title,
	action,
	children,
}: {
	eyebrow: string;
	title: string;
	action: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="workbench-section" aria-label={title}>
			<header className="workbench-section-head">
				<div>
					<p className="workbench-eyebrow">{eyebrow}</p>
					<h2>{title}</h2>
				</div>
				{action}
			</header>
			{children}
		</section>
	);
}

function ReadNotice({
	state,
	label,
	onRetry,
	refreshing,
}: {
	state:
		| Loading
		| Unavailable
		| { kind: "denied"; reason?: CollectionReadFailureReason }
		| {
				kind: "error";
				retryable: boolean;
				reason?: CollectionReadFailureReason;
		  };
	label: string;
	onRetry: () => void;
	refreshing?: boolean;
}) {
	if (state.kind === "loading") return <p role="status">正在加载{label}…</p>;
	const reason = state.reason;
	const message =
		reason === "authentication-required"
			? `${label}无法读取，请重新登录。`
			: state.kind === "denied" || reason === "denied"
				? `当前无权读取${label}。`
				: reason === "not-found"
					? `${label}读取入口不可用。`
					: reason === "invalid-response"
						? `${label}返回的数据无法读取。`
						: `${label}暂时无法读取。`;
	return (
		<Alert>
			<AlertDescription className="workbench-read-notice">
				<p>{message}</p>
				{state.kind !== "denied" && state.retryable && (
					<Button variant="outline" onClick={onRetry} disabled={refreshing}>
						重新加载{label}
					</Button>
				)}
			</AlertDescription>
		</Alert>
	);
}

function AgentStatus({ agent }: { agent: AgentProjectionV2 }) {
	const available = canStartPlatformConversation(agent);
	const failed =
		agent.managementStatus === "creation_failed" ||
		agent.managementStatus === "disabled";
	return (
		<Badge
			variant="outline"
			className={available ? "pill-live" : failed ? "pill-danger" : "pill-wait"}
		>
			{available
				? "可用"
				: agent.managementStatus === "available" &&
						agent.serviceAvailability !== null
					? agentServiceAvailabilityLabel(agent.serviceAvailability)
					: agentManagementStatusLabels[agent.managementStatus]}
		</Badge>
	);
}

export function WorkbenchScreen(props: WorkbenchScreenProps) {
	const {
		agents,
		ownerAgents,
		applications,
		pending,
		adminAgents,
		recent,
		administrator,
	} = props;
	const linkClass = buttonVariants({ variant: "outline" });
	return (
		<div className="ia-workbench">
			<header className="page-heading">
				<div>
					<p className="workbench-eyebrow">公司 Agent 平台 · M1</p>
					<h1>从可用 Agent 开始今天的工作。</h1>
					<p>
						发现和使用 Agent，跟进自己的创建申请；Owner
						维护配置，系统管理员处理资源审批与系统状态。
					</p>
				</div>
				<Link className={linkClass} to="/agents">
					浏览 Agent
				</Link>
			</header>
			<WorkbenchSection
				eyebrow="继续工作"
				title="最近的个人对话"
				action={
					<Link
						className={buttonVariants()}
						to="/agents"
						search={{ mode: "conversation" }}
					>
						新对话
					</Link>
				}
			>
				{recent.kind === "ready" ? (
					recent.conversations.length === 0 ? (
						<p>暂无个人对话。</p>
					) : (
						<div className="workbench-grid">
							{recent.conversations.map((conversation) => {
								const agent =
									agents.kind === "ready"
										? agents.agents.find(
												(candidate) =>
													candidate.agentId === conversation.agentId,
											)
										: undefined;
								const readOnly =
									!agent ||
									!canStartPlatformConversation(agent) ||
									conversation.status === "unavailable";
								return (
									<article
										className="workbench-card"
										key={conversation.conversationId}
									>
										{conversation.status === "unavailable" ? (
											<Badge variant="outline" className="pill-danger">
												会话不可用
											</Badge>
										) : agent ? (
											<AgentStatus agent={agent} />
										) : (
											<Badge variant="outline">状态暂时无法确认</Badge>
										)}
										<h3>{conversation.title ?? "未命名对话"}</h3>
										<p>
											{agent?.name ?? "所属 Agent 暂时无法读取"} ·{" "}
											<time dateTime={conversation.updatedAt}>
												{new Date(conversation.updatedAt).toLocaleString(
													"zh-CN",
													{ dateStyle: "medium", timeStyle: "short" },
												)}
											</time>
										</p>
										{readOnly && <p>历史仍可查看，当前不能继续发送消息。</p>}
										<Link
											className={readOnly ? linkClass : buttonVariants()}
											to="/chat/$agentId/{-$conversationId}"
											params={{
												agentId: conversation.agentId,
												conversationId: conversation.conversationId,
											}}
											search={{
												view: undefined,
											}}
										>
											{readOnly ? "查看历史" : "继续对话"}
										</Link>
									</article>
								);
							})}
						</div>
					)
				) : (
					<ReadNotice {...props} state={recent} label="最近的个人对话" />
				)}
				{recent.kind === "ready" && recent.nextCursor !== null && (
					<Button
						className="mt-4"
						variant="outline"
						onClick={props.onLoadMoreRecent}
						disabled={props.refreshing || !props.onLoadMoreRecent}
					>
						加载更多对话
					</Button>
				)}
			</WorkbenchSection>
			<WorkbenchSection
				eyebrow="当前可用范围"
				title="可用 Agent"
				action={
					<Link className={linkClass} to="/agents">
						查看全部 Agent
					</Link>
				}
			>
				{agents.kind === "ready" ? (
					agents.agents.length === 0 ? (
						<p>当前暂无可访问的 Agent。</p>
					) : (
						<div className="workbench-grid workbench-agent-grid">
							{agents.agents.slice(0, 3).map((agent) => (
								<article className="workbench-card" key={agent.agentId}>
									<div className="workbench-agent-top">
										<span className="workbench-agent-symbol">
											<Bot size={20} aria-hidden="true" />
										</span>
										<AgentStatus agent={agent} />
									</div>
									<div className="workbench-agent-copy">
										<h3>{agent.name}</h3>
										<p>{agent.description}</p>
									</div>
									<Link
										className={linkClass}
										to="/agents/$agentId"
										params={{ agentId: agent.agentId }}
									>
										查看详情
									</Link>
								</article>
							))}
						</div>
					)
				) : (
					<ReadNotice {...props} state={agents} label="可用 Agent" />
				)}
			</WorkbenchSection>
			<WorkbenchSection
				eyebrow="我的申请"
				title="创建状态"
				action={
					<Link className={linkClass} to="/my-agents">
						查看我的 Agent
					</Link>
				}
			>
				{applications.kind === "ready" ? (
					applications.applications.length === 0 ? (
						<p>暂无创建申请。</p>
					) : (
						<div className="workbench-applications">
							{applications.applications.slice(0, 3).map((application) => (
								<article
									className="workbench-card workbench-application-row"
									key={application.applicationId}
								>
									<div className="workbench-application-copy">
										<div className="workbench-application-title">
											<Badge
												variant="outline"
												className={
													application.status === "rejected"
														? "pill-danger"
														: application.status === "pending_approval"
															? "pill-wait"
															: undefined
												}
											>
												{agentManagementStatusLabels[application.status]}
											</Badge>
											<h3>{application.name}</h3>
										</div>
										<p>{application.description}</p>
									</div>
									<Link
										className={buttonVariants({ variant: "ghost" })}
										to="/my-agents/$applicationId"
										params={{ applicationId: application.applicationId }}
									>
										查看申请状态
									</Link>
								</article>
							))}
						</div>
					)
				) : (
					<ReadNotice {...props} state={applications} label="我的申请" />
				)}
			</WorkbenchSection>
			<WorkbenchSection
				eyebrow="Owner 关注"
				title="需要你处理"
				action={
					<Link className={buttonVariants()} to="/my-agents/new">
						创建 Agent
					</Link>
				}
			>
				{ownerAgents.kind !== "ready" && (
					<ReadNotice {...props} state={ownerAgents} label="Owner 创建状态" />
				)}
				{applications.kind !== "ready" && (
					<ReadNotice {...props} state={applications} label="待处理申请" />
				)}
				<div className="workbench-grid">
					{applications.kind === "ready" &&
						applications.applications
							.filter((application) => application.status === "rejected")
							.slice(0, 3)
							.map((application) => (
								<article
									className="workbench-card"
									key={application.applicationId}
								>
									<Badge variant="outline" className="pill-danger">
										已驳回
									</Badge>
									<h3>{application.name}</h3>
									<p>{application.decision?.reason ?? "暂未提供驳回原因。"}</p>
									<Link
										className={linkClass}
										to="/my-agents/$applicationId/edit"
										params={{ applicationId: application.applicationId }}
									>
										修改并重新提交
									</Link>
								</article>
							))}
					{ownerAgents.kind === "ready" &&
						ownerAgents.agents
							.filter((agent) => agent.managementStatus === "creation_failed")
							.slice(0, 3)
							.map((agent) => (
								<article className="workbench-card" key={agent.agentId}>
									<AgentStatus agent={agent} />
									<h3>{agent.name}</h3>
									<p>暂未提供创建失败原因。</p>
									<Link
										className={linkClass}
										to="/agents/$agentId/configuration"
										params={{ agentId: agent.agentId }}
									>
										配置与管理
									</Link>
								</article>
							))}
				</div>
				{ownerAgents.kind === "ready" &&
					applications.kind === "ready" &&
					ownerAgents.agents.every(
						(agent) => agent.managementStatus !== "creation_failed",
					) &&
					applications.applications.every(
						(application) => application.status !== "rejected",
					) && <p>暂无需要你处理的事项。</p>}
			</WorkbenchSection>
			{administrator && (
				<WorkbenchSection
					eyebrow="系统管理"
					title="需要管理员处理"
					action={
						<Link className={buttonVariants()} to="/admin/approvals">
							处理创建审批
						</Link>
					}
				>
					<div className="workbench-grid">
						{pending.kind === "ready" ? (
							<article className="workbench-card">
								<Badge variant="outline" className="pill-wait">
									{pending.applications.length} 项待审批
								</Badge>
								<h3>创建资源申请</h3>
								<p>检查申请来源、Owner、可用范围与资源占用。</p>
								<Link className={linkClass} to="/admin/approvals">
									进入审批
								</Link>
							</article>
						) : (
							<ReadNotice {...props} state={pending} label="待审批申请" />
						)}
						{adminAgents.kind === "ready" ? (
							adminAgents.agents.every(
								(agent) => agent.managementStatus !== "creation_failed",
							) ? (
								<p>暂无创建失败的 Agent。</p>
							) : (
								<article className="workbench-card">
									<Badge variant="outline" className="pill-danger">
										创建失败
									</Badge>
									<h3>Agent 创建状态</h3>
									<p>
										{
											adminAgents.agents.filter(
												(agent) => agent.managementStatus === "creation_failed",
											).length
										}{" "}
										个 Agent 创建失败
									</p>
									<Link
										className={linkClass}
										to="/admin/agents"
										search={{ status: "creation_failed" }}
									>
										查看失败清单
									</Link>
								</article>
							)
						) : (
							<ReadNotice
								{...props}
								state={adminAgents}
								label="管理员 Agent 状态"
							/>
						)}
					</div>
				</WorkbenchSection>
			)}
		</div>
	);
}
