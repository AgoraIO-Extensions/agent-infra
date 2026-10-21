import { Link } from "@tanstack/react-router";
import {
	ArrowRight,
	Bot,
	Inbox,
	Plus,
	RefreshCw,
	Settings2,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { LoadingLine } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Timestamp } from "@/components/ui/timestamp";
import { withObjectName } from "@/lib/accessible-name";
import { statusTone } from "@/lib/status-tone";

import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentChannelKindLabels } from "../agent-discovery/agent-discovery-screen.js";
import {
	agentConversationSourceLabel,
	agentManagementStatusLabels,
	agentServiceAvailabilityLabel,
} from "../agent-management-status.js";
import { AgentMark } from "../agent-mark.js";
import {
	AvailabilityNameList,
	DirectoryReadAlert,
	formatPerson,
	useAvailabilityNames,
} from "../directory-names.js";
import { RecoveryButton } from "../recovery-button.js";
import {
	type TemplateNameLookup,
	templateDisplayName,
} from "../template-display-name.js";
import {
	agentApplicationEditActionLabels,
	getAgentApplicationEditAction,
	hasCreatedAgent,
	type MyAgentApplicationsState,
} from "./my-agent-applications.js";

export type MyAgentsTab = "applications" | "owned";

/** 申请列表每次渲染的条数；超过时由「显示更多申请」逐批追加。 */
export const myAgentApplicationsPageSize = 20;

type MyAgentsScreenProps = {
	state: MyAgentApplicationsState | { kind: "loading" };
	/** The caller supplies Agents for which the current session is an Owner. */
	ownedAgents?: AgentProjectionV2[];
	ownedAgentsLoading?: boolean;
	ownedAgentsUnavailable?: boolean;
	ownedAgentsRetryable?: boolean;
	onRetryApplications?: () => void;
	onRetryOwnedAgents?: () => void;
	retryingApplications?: boolean;
	retryingOwnedAgents?: boolean;
	/** 由路由的 search 参数提供；未提供时页面自己记住当前 Tab。 */
	tab?: MyAgentsTab;
	onTabChange?: (tab: MyAgentsTab) => void;
	/** 模板显示名（部署配置）；未提供或读不到时显示「标准模板」（F-02）。 */
	templateName?: TemplateNameLookup;
};

/** 已创建 Agent 卡只显示一个状态：有服务可用性时显示它，否则显示管理状态（与 Agent 详情一致）。 */
function ownedAgentStatus(agent: AgentProjectionV2) {
	return agent.serviceAvailability
		? {
				label: agentServiceAvailabilityLabel(agent.serviceAvailability),
				tone: statusTone(agent.serviceAvailability),
			}
		: {
				label: agentManagementStatusLabels[agent.managementStatus],
				tone: statusTone(agent.managementStatus),
			};
}

export function MyAgentsScreen({
	state,
	ownedAgents,
	ownedAgentsLoading = false,
	ownedAgentsUnavailable = false,
	ownedAgentsRetryable = false,
	onRetryApplications,
	onRetryOwnedAgents,
	retryingApplications = false,
	retryingOwnedAgents = false,
	tab,
	onTabChange,
	templateName,
}: MyAgentsScreenProps) {
	const id = useId();
	const [localTab, setLocalTab] = useState<MyAgentsTab>("applications");
	const selectedTab = tab ?? localTab;
	const [visibleApplications, setVisibleApplications] = useState(
		myAgentApplicationsPageSize,
	);
	// 追加后把焦点移到新出现的第一行，避免键盘用户回到列表开头。
	const [focusRow, setFocusRow] = useState<number | null>(null);
	const listRef = useRef<HTMLUListElement>(null);
	useEffect(() => {
		if (focusRow === null) return;
		listRef.current
			?.querySelectorAll<HTMLElement>(".application-row")
			[focusRow]?.querySelector<HTMLElement>("[data-application-detail]")
			?.focus();
		setFocusRow(null);
	}, [focusRow]);
	// 同一页面的全部使用范围合并后读取一次目录。
	const names = useAvailabilityNames(
		(ownedAgents ?? []).flatMap((agent) => agent.configuration.availability),
	);
	const applications = state.kind === "ready" ? state.applications : [];
	const shownApplications = applications.slice(0, visibleApplications);
	const remainingApplications = applications.length - shownApplications.length;
	return (
		<section aria-labelledby={`${id}-heading`}>
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">我的管理</p>
					<h1 id={`${id}-heading`}>查看申请，管理名下 Agent。</h1>
					<p>申请、Owner 权限和运行配置分别管理，状态以服务端结果为准。</p>
				</div>
				<Link className={buttonVariants()} to="/my-agents/new">
					<Plus aria-hidden="true" />
					新建申请
				</Link>
			</header>
			<Tabs
				value={selectedTab}
				onValueChange={(value) => {
					const next: MyAgentsTab =
						value === "owned" ? "owned" : "applications";
					setLocalTab(next);
					onTabChange?.(next);
				}}
			>
				<TabsList activateOnFocus aria-label="我的 Agent 视图">
					<TabsTrigger value="applications">
						{/* 计数只在申请读取成功后出现；空格让可访问名称读作「申请 N」。 */}
						申请
						{state.kind === "ready" ? (
							<>
								{" "}
								{/* 设计 .tab 内的 .chip 继承 Tab 的 650 字重（W-01）。 */}
								<Badge tone="gray" className="my-agents-tab-count">
									{applications.length}
								</Badge>
							</>
						) : null}
					</TabsTrigger>
					<TabsTrigger value="owned">已创建</TabsTrigger>
				</TabsList>
				<TabsContent value="applications">
					{state.kind === "loading" ? (
						<LoadingLine className="py-8">正在读取申请…</LoadingLine>
					) : state.kind === "unavailable" ? (
						<Alert tone="danger" role="alert" className="my-5">
							<AlertDescription>
								{state.retryable
									? "暂时无法读取申请，请稍后重试。"
									: "当前无法查看申请，请联系管理员。"}
							</AlertDescription>
							{state.retryable && onRetryApplications ? (
								<AlertAction>
									<RecoveryButton
										variant="outline"
										recoveryKey="重新加载申请"
										busy={retryingApplications}
										onClick={onRetryApplications}
									>
										<RefreshCw aria-hidden="true" data-icon="inline-start" />
										{retryingApplications ? "正在重新加载…" : "重新加载申请"}
									</RecoveryButton>
								</AlertAction>
							) : null}
						</Alert>
					) : (
						<>
							{applications.length === 0 ? (
								<Empty>
									<EmptyHeader>
										<EmptyMedia>
											<Inbox aria-hidden="true" />
										</EmptyMedia>
										<EmptyTitle>暂无 Agent 申请</EmptyTitle>
										<EmptyDescription>
											提交申请后，可在这里查看审批与创建进度。
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							) : (
								<>
									<ul
										className="application-list"
										aria-label="我的申请"
										ref={listRef}
									>
										{shownApplications.map((application) => {
											const editAction =
												getAgentApplicationEditAction(application);
											return (
												<li
													className="application-row"
													key={application.applicationId}
												>
													<div className="min-w-0 flex-1">
														<div className="tag-row">
															<Badge tone={statusTone(application.status)}>
																{
																	agentManagementStatusLabels[
																		application.status
																	]
																}
															</Badge>
															<Badge variant="tag">
																{application.source.kind === "standard"
																	? templateDisplayName(
																			application.source.templateId,
																			templateName,
																		)
																	: agentConversationSourceLabel(application)}
															</Badge>
														</div>
														{/* 设计稿标题不是链接，详情入口只有同行的「查看申请」。 */}
														<h2>{application.name}</h2>
														{/* 设计 .list-row：标题下只有一行「说明 · 更新于 时间」（W-02）。列表只含本人申请，
														    申请人显示在详情进度的「申请已提交」一步。 */}
														<p>
															{application.description} · 更新于{" "}
															<Timestamp
																value={
																	application.updatedAt ??
																	application.submittedAt
																}
															/>
														</p>
													</div>

													<div className="actions">
														<Link
															className={buttonVariants({ variant: "ghost" })}
															data-application-detail=""
															params={{
																applicationId: application.applicationId,
															}}
															to="/my-agents/$applicationId"
															aria-label={withObjectName(
																"查看申请",
																application.name,
															)}
														>
															查看申请
														</Link>
														{editAction ? (
															<Link
																className={buttonVariants({
																	variant: "outline",
																})}
																params={{
																	applicationId: application.applicationId,
																}}
																to="/my-agents/$applicationId/edit"
																aria-label={withObjectName(
																	agentApplicationEditActionLabels[editAction],
																	application.name,
																)}
															>
																{agentApplicationEditActionLabels[editAction]}
															</Link>
														) : null}
														{/* 设计按钮体系没有 link 变体：同列次要操作统一为 outline（B2-01），
														    --fg 文字在 --surface 上满足 WCAG AA。 */}
														{hasCreatedAgent(application) ? (
															<Link
																className={buttonVariants({
																	variant: "outline",
																})}
																params={{ agentId: application.agentId }}
																to="/agents/$agentId"
																aria-label={withObjectName(
																	"查看 Agent",
																	application.name,
																)}
															>
																查看 Agent
															</Link>
														) : null}
													</div>
												</li>
											);
										})}
									</ul>
									{remainingApplications > 0 ? (
										<Button
											variant="outline"
											className="application-list-more"
											onClick={() => {
												setFocusRow(shownApplications.length);
												setVisibleApplications(
													(count) => count + myAgentApplicationsPageSize,
												);
											}}
											type="button"
										>
											显示更多申请（剩余 {remainingApplications}）
										</Button>
									) : null}
								</>
							)}
							{/* 设计 .notice：只在申请读取成功时出现在申请面板内、列表之后；静态说明不设 live 角色。 */}
							<Alert tone="info" className="my-agents-note">
								<AlertTitle>审批记录会保留</AlertTitle>
								<AlertDescription>
									驳回后可以修改范围或模型，再次提交申请。
								</AlertDescription>
							</Alert>
						</>
					)}
				</TabsContent>
				<TabsContent value="owned">
					{ownedAgentsLoading ? (
						<LoadingLine className="py-8">正在读取你管理的 Agent…</LoadingLine>
					) : ownedAgentsUnavailable ? (
						<Alert tone="danger" role="alert" className="my-5">
							<AlertDescription>
								{ownedAgentsRetryable
									? "暂时无法读取你管理的 Agent，请稍后重试。"
									: "当前无法查看你管理的 Agent，请联系管理员。"}
							</AlertDescription>
							{ownedAgentsRetryable && onRetryOwnedAgents ? (
								<AlertAction>
									<RecoveryButton
										variant="outline"
										recoveryKey="重新加载已创建 Agent"
										busy={retryingOwnedAgents}
										onClick={onRetryOwnedAgents}
									>
										<RefreshCw aria-hidden="true" data-icon="inline-start" />
										{retryingOwnedAgents
											? "正在重新加载…"
											: "重新加载已创建 Agent"}
									</RecoveryButton>
								</AlertAction>
							) : null}
						</Alert>
					) : ownedAgents === undefined ? (
						<p className="py-8 text-muted-foreground">
							尚未读取你管理的 Agent。
						</p>
					) : ownedAgents.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia>
									<Bot aria-hidden="true" />
								</EmptyMedia>
								<EmptyTitle>暂无你管理的 Agent</EmptyTitle>
								<EmptyDescription>
									你担任 Owner 的 Agent 会显示在这里。
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<>
							<DirectoryReadAlert names={[names]} className="mb-4" />
							<ul className="owned-agent-grid" aria-label="我管理的 Agent">
								{ownedAgents.map((agent) => {
									const status = ownedAgentStatus(agent);
									return (
										<Card
											render={<li />}
											className="owned-agent-card"
											key={agent.agentId}
										>
											<div className="owned-card-heading">
												<AgentMark name={agent.name} agentId={agent.agentId} />
												<div>
													<h2>{agent.name}</h2>
													<p>
														Owner ·{" "}
														{agent.configuration.owners
															.map(
																(owner) =>
																	formatPerson({
																		displayName: owner.displayName,
																	}).name,
															)
															.join("、")}
													</p>
												</div>
												<Badge tone={status.tone}>{status.label}</Badge>
											</div>
											<dl className="metadata-facts">
												<dt>可用范围</dt>
												<dd>
													<AvailabilityNameList
														targets={agent.configuration.availability}
														names={names}
														empty="未额外指定"
													/>
												</dd>
												{/* 设计 renderOwnedAgents：渠道与模型都用「 · 」分隔（W-04）。 */}
												<dt>渠道</dt>
												<dd>
													{agent.configuration.channels
														.map(
															(channel) => agentChannelKindLabels[channel.kind],
														)
														.join(" · ") || "未配置"}
												</dd>
												<dt>模型</dt>
												<dd>
													{agent.configuration.modelOptions
														.map((model) => model.displayName)
														.join(" · ") || "未提供模型选项"}
												</dd>
											</dl>
											<div className="card-actions">
												<Link
													className={buttonVariants({ variant: "outline" })}
													params={{ agentId: agent.agentId }}
													to="/agents/$agentId/configuration"
													aria-label={withObjectName(
														"配置与生命周期",
														agent.name,
													)}
												>
													<Settings2
														aria-hidden="true"
														data-icon="inline-start"
													/>
													配置与生命周期
												</Link>
												<Link
													className={buttonVariants({ variant: "ghost" })}
													params={{ agentId: agent.agentId }}
													to="/agents/$agentId"
													aria-label={withObjectName("查看详情", agent.name)}
												>
													<ArrowRight
														aria-hidden="true"
														data-icon="inline-start"
													/>
													查看详情
												</Link>
											</div>
										</Card>
									);
								})}
							</ul>
						</>
					)}
				</TabsContent>
			</Tabs>
		</section>
	);
}
