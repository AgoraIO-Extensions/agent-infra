import { Link } from "@tanstack/react-router";
import { ArrowRight, MessageSquare, Plus } from "lucide-react";
import type { ReactNode } from "react";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { LoadingLine } from "@/components/ui/spinner";
import { Timestamp } from "@/components/ui/timestamp";
import { distinctObjectNames, withObjectName } from "@/lib/accessible-name";
import { cjkSpaced } from "@/lib/cjk-spacing";
import { statusTone } from "@/lib/status-tone";
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
import { agentChannelSummary } from "../agent-discovery/agent-discovery-screen.js";
import {
	agentAvailabilityStatus,
	agentManagementStatusLabels,
	agentServiceAvailabilityLabel,
} from "../agent-management-status.js";
import { AgentMark } from "../agent-mark.js";
import type {
	CollectionReadFailureReason,
	CollectionReadUnavailable,
} from "../collection-read-failure.js";
import { conversationDisplayTitle } from "../conversation/conversation-display-title.js";
import type { MyAgentApplicationsState } from "../my-agents/my-agent-applications.js";
import { ReloginButton } from "../page-state-card.js";
import { RecoveryButton } from "../recovery-button.js";
import {
	type TemplateNameLookup,
	templateDisplayName,
} from "../template-display-name.js";
import { RecentUnavailableAgentsNotice } from "./recent-unavailable-agents-notice.js";

/** 工作台只列最近几条个人对话（设计稿原型 3 条）；全部历史在对话页「最近对话」面板。 */
export const workbenchRecentLimit = 3;

type Loading = { kind: "loading" };
type Unavailable = CollectionReadUnavailable;
export type WorkbenchRecentState =
	| Loading
	| Unavailable
	| {
			kind: "ready";
			conversations: ConversationDetailProjectionV2["conversation"][];
			nextCursor: string | null;
			/** 已读取各页中渠道资格无法确认、对话未列出的 Agent（#3379）；缺省为没有。 */
			unavailableAgentIds?: readonly string[];
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
	/** 任一分区返回 401 时页面唯一的「重新登录」：由壳层重新确认浏览器会话。 */
	onRelogin?: () => void;
	refreshing?: boolean;
	/** 模板显示名（部署配置）；未提供或读不到时显示「标准模板」（F-02）。 */
	templateName?: TemplateNameLookup;
};

type ReadState =
	| Loading
	| Unavailable
	| { kind: "denied"; reason?: CollectionReadFailureReason }
	| {
			kind: "error";
			retryable: boolean;
			reason?: CollectionReadFailureReason;
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
					<h2>{title}</h2>
					<p className="workbench-section-description">{eyebrow}</p>
				</div>
				{action}
			</header>
			{children}
		</section>
	);
}

/** 分区读取失败的标题；label 以拉丁字母或数字结尾时与中文之间补空格（「可用 Agent 无法读取」）。 */
function readFailureMessage(state: Exclude<ReadState, Loading>, label: string) {
	const reason = state.reason;
	return reason === "authentication-required"
		? cjkSpaced`${label}无法读取，请重新登录。`
		: state.kind === "denied" || reason === "denied"
			? cjkSpaced`当前无权读取${label}。`
			: reason === "not-found"
				? cjkSpaced`${label}读取入口不可用。`
				: reason === "invalid-response"
					? cjkSpaced`${label}返回的数据无法读取。`
					: cjkSpaced`${label}暂时无法读取。`;
}

const requiresLogin = (state: { kind: string; reason?: unknown }) =>
	state.kind !== "ready" &&
	state.kind !== "loading" &&
	state.reason === "authentication-required";

/**
 * 分区读取反馈（设计 .notice）：原因写在 strong 标题里。可重试失败用信息变体并给
 * outline「重新加载」；401、403、404 与响应无效不给按钮，401 的主操作只在页面级提示里出现一次。
 */
function ReadNotice({
	state,
	label,
	onRetry,
	refreshing,
}: {
	state: ReadState;
	label: string;
	onRetry: () => void;
	refreshing?: boolean;
}) {
	if (state.kind === "loading")
		return <LoadingLine>{cjkSpaced`正在加载${label}…`}</LoadingLine>;
	const denied = state.kind === "denied";
	const retryable =
		!denied && state.retryable && state.reason !== "authentication-required";
	const retryLabel = cjkSpaced`重新加载${label}`;
	return (
		// 无权读取是权限边界，不打断读屏；其余读取失败用 role="alert"。
		<Alert
			tone={denied ? "warn" : retryable ? "info" : "danger"}
			role={denied ? undefined : "alert"}
		>
			<AlertTitle>{readFailureMessage(state, label)}</AlertTitle>
			{retryable && (
				<AlertAction>
					{/* 恢复成功后焦点落到工作台 h1；重新加载仍失败时焦点留在按钮上。 */}
					<RecoveryButton
						variant="outline"
						recoveryKey={retryLabel}
						busy={refreshing}
						onClick={onRetry}
					>
						{retryLabel}
					</RecoveryButton>
				</AlertAction>
			)}
		</Alert>
	);
}

/** 与 /agents 卡、详情和 Owner 配置页头同一条派生规则：就绪 green（设计 a.availability，G4-01）。 */
function AgentStatus({ agent }: { agent: AgentProjectionV2 }) {
	const status = agentAvailabilityStatus(agent);
	return <Badge tone={status.tone}>{status.label}</Badge>;
}

/**
 * 最近对话行的会话可用性（设计 renderWorkbench recent、H4-03）：可开始对话写「可用」green，
 * 其余沿用服务状态或管理状态的标签。只用于最近对话行；「可用 Agent」卡仍是 AgentStatus（G5-01）。
 */
function ConversationAvailabilityStatus({
	agent,
}: {
	agent: AgentProjectionV2;
}) {
	const available = canStartPlatformConversation(agent);
	const status = available
		? "ready"
		: agent.managementStatus === "available"
			? (agent.serviceAvailability ?? "unavailable")
			: agent.managementStatus;
	return (
		<Badge tone={statusTone(status)}>
			{available
				? "可用"
				: agent.managementStatus === "available" &&
						agent.serviceAvailability !== null
					? agentServiceAvailabilityLabel(agent.serviceAvailability)
					: agentManagementStatusLabels[agent.managementStatus]}
		</Badge>
	);
}

function RecentConversations({
	agents,
	recent,
}: Pick<WorkbenchScreenProps, "agents" | "recent"> & {
	recent: Extract<WorkbenchRecentState, { kind: "ready" }>;
}) {
	if (recent.conversations.length === 0)
		return (
			<Empty className="workbench-empty">
				<EmptyHeader>
					<EmptyMedia>
						<MessageSquare aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle>暂无个人对话</EmptyTitle>
					<EmptyDescription>选择一个 Agent 开始新的个人对话。</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	// 标题重复（含多条「未命名对话」）时按出现顺序编号，链接名称仍可区分（N-12）。
	const objectNames = distinctObjectNames(
		recent.conversations
			.slice(0, workbenchRecentLimit)
			.map((conversation) => conversationDisplayTitle(conversation.title)),
	);
	return (
		<div className="workbench-list">
			{recent.conversations
				.slice(0, workbenchRecentLimit)
				.map((conversation, index) => {
					// Agent 列表仍在读取时不下结论：不显示状态文字、元信息只放时间，
					// 只有列表确认失败（或列表里没有该 Agent）才显示「暂时无法确认」。
					const agentsLoading = agents.kind === "loading";
					const agent =
						agents.kind === "ready"
							? agents.agents.find(
									(candidate) => candidate.agentId === conversation.agentId,
								)
							: undefined;
					const conversationUnavailable = conversation.status === "unavailable";
					const readOnly =
						(agent !== undefined && !canStartPlatformConversation(agent)) ||
						conversationUnavailable;
					const title = conversationDisplayTitle(conversation.title);
					// 设计 #workbench：只有首行可继续的会话写「继续对话」，其余可用会话写「打开对话」（Y-11）；
					// Agent 未确认可用时也写「打开对话」。三种文案都是四个字：加载期到就绪后按钮宽度不变（NI-28）。
					const action = readOnly
						? "查看历史"
						: agent && index === 0
							? "继续对话"
							: "打开对话";
					return (
						<article
							className="workbench-list-row workbench-recent-row"
							key={`${conversation.agentId}\u0000${conversation.conversationId}`}
						>
							<div className="workbench-list-main">
								<div className="workbench-tag-row">
									{conversationUnavailable ? (
										<Badge tone="red">会话不可用</Badge>
									) : agent ? (
										<ConversationAvailabilityStatus agent={agent} />
									) : agentsLoading ? (
										<span
											className="workbench-chip-placeholder"
											data-slot="chip-placeholder"
											aria-hidden="true"
										/>
									) : (
										<Badge tone="gray">状态暂时无法确认</Badge>
									)}
								</div>
								<h3>{title}</h3>
								<small>
									{agent
										? `${agent.name} · `
										: agentsLoading
											? null
											: "所属 Agent 暂时无法读取 · "}
									<Timestamp value={conversation.updatedAt} />
									{readOnly && " · 历史只读"}
								</small>
							</div>
							<div className="workbench-list-side">
								<Link
									className={buttonVariants({
										variant: readOnly ? "ghost" : "outline",
									})}
									to="/chat/$agentId/{-$conversationId}"
									params={{
										agentId: conversation.agentId,
										conversationId: conversation.conversationId,
									}}
									search={{
										view: undefined,
									}}
									aria-label={withObjectName(action, objectNames[index])}
								>
									{action}
								</Link>
							</div>
						</article>
					);
				})}
		</div>
	);
}

/** 待处理的一行：strong 标题 + 说明（或读取反馈），操作放在右侧。 */
function TaskRow({
	title,
	children,
	action,
}: {
	title: string;
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="workbench-list-row workbench-task-row">
			<div className="workbench-list-main">
				<h3>{title}</h3>
				{children}
			</div>
			{action && <div className="workbench-list-side">{action}</div>}
		</div>
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
		onRetry,
		onRelogin,
		refreshing,
		templateName,
	} = props;
	const sections = [
		recent,
		agents,
		ownerAgents,
		applications,
		...(administrator ? [pending, adminAgents] : []),
	];
	const notice = { onRetry, refreshing };
	const loginRequired = sections.some(requiresLogin);
	const latest =
		recent.kind === "ready" ? recent.conversations.at(0) : undefined;
	const rejected =
		applications.kind === "ready"
			? applications.applications
					.filter((application) => application.status === "rejected")
					.slice(0, 3)
			: [];
	const creationFailed =
		ownerAgents.kind === "ready"
			? ownerAgents.agents
					.filter((agent) => agent.managementStatus === "creation_failed")
					.slice(0, 3)
			: [];
	const administratorFailures =
		adminAgents.kind === "ready"
			? adminAgents.agents.filter(
					(agent) => agent.managementStatus === "creation_failed",
				).length
			: 0;
	return (
		<div className="ia-workbench">
			<header className="page-heading">
				<div>
					<p className="workbench-eyebrow">公司内部工作区 · M1</p>
					{/* tabIndex=-1：页面级「重新登录」或分区「重新加载…」恢复后焦点落在这里。401 的
					    「重新登录」一次恢复多个分区，没有唯一的「恢复分区」，因此统一落到页面 h1。 */}
					<h1 tabIndex={-1}>选择一个 Agent 开始工作。</h1>
					<p>最近对话、可用 Agent 和待处理事项都在这里。</p>
				</div>
				<Link
					className={buttonVariants()}
					to="/agents"
					search={{ mode: "conversation" }}
				>
					<Plus aria-hidden="true" /> 新建对话
				</Link>
			</header>
			{loginRequired && (
				// 会话过期时全页只有这一个主操作；各分区只说明原因，不再各放按钮。
				<Alert tone="danger" role="alert" className="workbench-login-notice">
					<AlertTitle>登录已过期</AlertTitle>
					<AlertDescription>
						当前会话已过期，需要重新登录后再进入工作区。
					</AlertDescription>
					{onRelogin && (
						<AlertAction>
							{/* 与状态卡、Agent 目录的「重新登录」同一按钮，带 LogIn 图标（#3327 N10-1-04）。 */}
							<ReloginButton busy={refreshing} onClick={onRelogin} />
						</AlertAction>
					)}
				</Alert>
			)}
			<div className="workbench-overview">
				<WorkbenchSection
					eyebrow="只显示你的历史记录"
					title="最近对话"
					action={
						latest && (
							<Link
								className={buttonVariants({ variant: "ghost" })}
								to="/chat/$agentId/{-$conversationId}"
								params={{
									agentId: latest.agentId,
									conversationId: latest.conversationId,
								}}
								search={{ view: undefined }}
							>
								{/* 设计 linkBtn icon:'arrow'：箭头在文字前（Y-05）。 */}
								<ArrowRight aria-hidden="true" />
								查看全部
							</Link>
						)
					}
				>
					{recent.kind === "ready" ? (
						<>
							<RecentUnavailableAgentsNotice
								agentIds={recent.unavailableAgentIds}
								className="mb-3"
							/>
							<RecentConversations agents={agents} recent={recent} />
						</>
					) : (
						<ReadNotice {...notice} state={recent} label="最近对话" />
					)}
				</WorkbenchSection>
				<aside className="workbench-attention" aria-label="待处理">
					<header className="workbench-section-head">
						<div>
							<h2>待处理</h2>
							<p className="workbench-section-description">按你的权限显示</p>
						</div>
					</header>
					<div className="workbench-task-lists">
						{administrator && (
							<section aria-label="需要管理员处理" className="workbench-list">
								<TaskRow
									title="创建审批"
									action={
										<Link
											className={buttonVariants({ variant: "ghost" })}
											to="/admin/approvals"
											aria-label={withObjectName("进入", "创建审批")}
										>
											进入
										</Link>
									}
								>
									{pending.kind === "ready" ? (
										<small>
											{pending.applications.length} 项申请等待系统管理员审阅
										</small>
									) : (
										<ReadNotice
											{...notice}
											state={pending}
											label="待审批申请"
										/>
									)}
								</TaskRow>
							</section>
						)}
						<section aria-label="需要你处理" className="workbench-list">
							{/* 设计 #workbench 待处理：「Owner 待办」进申请详情（查看原因、修改后重新提交，PRD §6.3），
							    「运行状态」进 Owner 配置（Owner 可以重试，PRD §6.3）（Y-09）。 */}
							{applications.kind !== "ready" ? (
								<TaskRow title="Owner 待办">
									<ReadNotice
										{...notice}
										state={applications}
										label="待处理申请"
									/>
								</TaskRow>
							) : rejected.length ? (
								rejected.map((application) => (
									<TaskRow
										key={application.applicationId}
										title="Owner 待办"
										action={
											<Link
												className={buttonVariants({ variant: "ghost" })}
												to="/my-agents/$applicationId"
												params={{ applicationId: application.applicationId }}
												aria-label={withObjectName("查看", application.name)}
											>
												查看
											</Link>
										}
									>
										<small>
											{cjkSpaced`${application.name}被驳回，可修改后重提`}
										</small>
									</TaskRow>
								))
							) : (
								<TaskRow title="Owner 待办">
									<small>暂无需要修改的申请。</small>
								</TaskRow>
							)}
							{ownerAgents.kind !== "ready" ? (
								<TaskRow title="运行状态">
									<ReadNotice
										{...notice}
										state={ownerAgents}
										label="Owner 创建状态"
									/>
								</TaskRow>
							) : creationFailed.length ? (
								creationFailed.map((agent) => (
									<TaskRow
										key={agent.agentId}
										title="运行状态"
										action={
											<Link
												className={buttonVariants({ variant: "ghost" })}
												to="/agents/$agentId/configuration"
												params={{ agentId: agent.agentId }}
												aria-label={withObjectName("处理", agent.name)}
											>
												处理
											</Link>
										}
									>
										<small>{cjkSpaced`${agent.name}创建失败，可重试`}</small>
									</TaskRow>
								))
							) : (
								<TaskRow title="运行状态">
									<small>暂无创建失败的 Agent。</small>
								</TaskRow>
							)}
							{/* 系统管理员代替 Owner 重试创建失败的 Agent（PRD §2.3）：导出稿已回写这一行（Y-09）。 */}
							{administrator &&
								(adminAgents.kind !== "ready" ? (
									<TaskRow title="运行状态">
										<ReadNotice
											{...notice}
											state={adminAgents}
											label="管理员 Agent 状态"
										/>
									</TaskRow>
								) : (
									administratorFailures > 0 && (
										<TaskRow
											title="运行状态"
											action={
												<Link
													className={buttonVariants({ variant: "ghost" })}
													to="/admin/agents"
													search={{ status: "creation_failed" }}
												>
													查看失败清单
												</Link>
											}
										>
											<small>{administratorFailures} 个 Agent 创建失败</small>
										</TaskRow>
									)
								))}
						</section>
					</div>
				</aside>
			</div>
			<WorkbenchSection
				eyebrow="按账号和组织权限过滤"
				title="可用 Agent"
				action={
					<Link className={buttonVariants({ variant: "ghost" })} to="/agents">
						<ArrowRight aria-hidden="true" />
						查看目录
					</Link>
				}
			>
				{agents.kind === "ready" ? (
					agents.agents.length === 0 ? (
						<p>当前暂无可访问的 Agent。</p>
					) : (
						<div className="workbench-grid workbench-agent-grid">
							{agents.agents.slice(0, 3).map((agent) => (
								<Card className="workbench-card" key={agent.agentId}>
									<div className="workbench-agent-top">
										<AgentMark name={agent.name} agentId={agent.agentId} />
										<AgentStatus agent={agent} />
									</div>
									<div className="workbench-agent-copy">
										<h3>{agent.name}</h3>
										<p>{agent.description}</p>
									</div>
									<div className="workbench-agent-tags">
										<Badge variant="tag">
											{agent.source.kind === "standard"
												? templateDisplayName(
														agent.source.templateId,
														templateName,
													)
												: "自定义 Agent"}
										</Badge>
										{/* 设计只有一个渠道 tag「Web · 企微机器人」：与 /agents 卡片、详情「渠道」行共用可用渠道摘要，不列未配置的渠道（A2-01）。 */}
										<Badge variant="tag">{agentChannelSummary(agent)}</Badge>
									</div>
									<Link
										className={buttonVariants({ variant: "ghost" })}
										to="/agents/$agentId"
										params={{ agentId: agent.agentId }}
										aria-label={withObjectName("查看详情", agent.name)}
									>
										{/* 设计 ghost 按钮带前置箭头（Y-06）。 */}
										<ArrowRight aria-hidden="true" />
										查看详情
									</Link>
								</Card>
							))}
						</div>
					)
				) : (
					<ReadNotice {...notice} state={agents} label="可用 Agent" />
				)}
			</WorkbenchSection>
			<WorkbenchSection
				eyebrow="查看状态和下一步"
				title="我的申请"
				action={
					<Link
						className={buttonVariants({ variant: "outline" })}
						to="/my-agents/new"
					>
						<Plus aria-hidden="true" />
						创建申请
					</Link>
				}
			>
				{applications.kind === "ready" ? (
					applications.applications.length === 0 ? (
						<p>暂无创建申请。</p>
					) : (
						<div className="workbench-applications workbench-list">
							{/* 导出稿 #workbench `state.applications.slice(0,2)`：最多 2 条，全部申请在「我的 Agent」（A2-02）。 */}
							{applications.applications.slice(0, 2).map((application) => (
								<article
									className="workbench-list-row workbench-application-row"
									key={application.applicationId}
								>
									<div className="workbench-list-main">
										<div className="workbench-tag-row">
											<Badge tone={statusTone(application.status)}>
												{agentManagementStatusLabels[application.status]}
											</Badge>
										</div>
										<h3>{application.name}</h3>
										{/* 设计 #workbench：「来源 · 更新时间 · 说明」（Y-10）。 */}
										<small>
											{application.source.kind === "standard"
												? templateDisplayName(
														application.source.templateId,
														templateName,
													)
												: "自定义 Agent"}
											{" · "}
											<Timestamp
												value={application.updatedAt ?? application.submittedAt}
											/>
											{application.description &&
												` · ${application.description}`}
										</small>
									</div>
									<div className="workbench-list-side">
										<Link
											className={buttonVariants({ variant: "ghost" })}
											to="/my-agents/$applicationId"
											params={{ applicationId: application.applicationId }}
											aria-label={withObjectName("查看状态", application.name)}
										>
											查看状态
										</Link>
									</div>
								</article>
							))}
						</div>
					)
				) : (
					<ReadNotice {...notice} state={applications} label="我的申请" />
				)}
			</WorkbenchSection>
		</div>
	);
}
