import { Link } from "@tanstack/react-router";
import { Plus, RefreshCw } from "lucide-react";
import { useId } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { LoadingLine } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
	agentApplicationEditActionLabels,
	getAgentApplicationEditAction,
	hasCreatedAgent,
	type MyAgentApplicationsState,
} from "./my-agent-applications.js";

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
};

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
}: MyAgentsScreenProps) {
	const id = useId();
	return (
		<section aria-labelledby={`${id}-heading`}>
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">我的管理</p>
					<h1 id={`${id}-heading`}>跟进申请，也维护你负责的 Agent。</h1>
					<p>申请、Owner 权限和运行配置分开管理，状态会在服务端确认后更新。</p>
				</div>
				<Link className={buttonVariants()} to="/my-agents/new">
					<Plus aria-hidden="true" />
					新建申请
				</Link>
			</header>
			<Tabs defaultValue="applications">
				<TabsList activateOnFocus aria-label="我的 Agent 视图">
					<TabsTrigger value="applications">申请</TabsTrigger>
					<TabsTrigger value="agents">已创建 Agent</TabsTrigger>
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
									<Button
										variant="outline"
										disabled={retryingApplications}
										onClick={onRetryApplications}
										type="button"
									>
										<RefreshCw aria-hidden="true" data-icon="inline-start" />
										{retryingApplications ? "正在重新加载…" : "重新加载申请"}
									</Button>
								</AlertAction>
							) : null}
						</Alert>
					) : state.applications.length === 0 ? (
						<Empty>
							<EmptyTitle>暂无 Agent 申请</EmptyTitle>
							<EmptyDescription>
								提交申请后，可在这里查看审批与创建进度。
							</EmptyDescription>
						</Empty>
					) : (
						<ul className="application-list" aria-label="我的申请">
							{state.applications.map((application) => {
								const editAction = getAgentApplicationEditAction(application);
								return (
									<li
										className="application-row"
										key={application.applicationId}
									>
										<div className="min-w-0 flex-1">
											<div className="tag-row">
												<Badge tone={statusTone(application.status)}>
													{agentManagementStatusLabels[application.status]}
												</Badge>
												<Badge variant="tag">
													{application.source.kind === "standard"
														? application.source.templateId
														: agentConversationSourceLabel(application)}
												</Badge>
											</div>
											{/* 设计稿标题不是链接，入口为同行的「查看申请」（≥44px）。 */}
											<h2>{application.name}</h2>
											<p>{application.description}</p>
											<p className="text-sm">
												提交于{" "}
												<time dateTime={application.submittedAt}>
													{application.submittedAt}
												</time>
											</p>
										</div>

										<div className="actions">
											<Link
												className={buttonVariants({ variant: "ghost" })}
												params={{ applicationId: application.applicationId }}
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
													className={buttonVariants({ variant: "outline" })}
													params={{ applicationId: application.applicationId }}
													to="/my-agents/$applicationId/edit"
													aria-label={withObjectName(
														agentApplicationEditActionLabels[editAction],
														application.name,
													)}
												>
													{agentApplicationEditActionLabels[editAction]}
												</Link>
											) : null}
											{hasCreatedAgent(application) ? (
												<Link
													className={buttonVariants({ variant: "link" })}
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
					)}
				</TabsContent>
				<TabsContent value="agents">
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
									<Button
										variant="outline"
										disabled={retryingOwnedAgents}
										onClick={onRetryOwnedAgents}
										type="button"
									>
										<RefreshCw aria-hidden="true" data-icon="inline-start" />
										{retryingOwnedAgents
											? "正在重新加载…"
											: "重新加载已创建 Agent"}
									</Button>
								</AlertAction>
							) : null}
						</Alert>
					) : ownedAgents === undefined ? (
						<p className="py-8 text-muted-foreground">
							尚未读取你管理的 Agent。
						</p>
					) : ownedAgents.length === 0 ? (
						<Empty>
							<EmptyTitle>暂无你管理的 Agent</EmptyTitle>
							<EmptyDescription>
								你担任 Owner 的 Agent 会显示在这里。
							</EmptyDescription>
						</Empty>
					) : (
						<ul className="owned-agent-grid" aria-label="我管理的 Agent">
							{ownedAgents.map((agent) => (
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
													.map((owner) => owner.displayName || owner.userId)
													.join("、")}
											</p>
										</div>
										<Badge tone={statusTone(agent.managementStatus)}>
											{agentManagementStatusLabels[agent.managementStatus]}
										</Badge>
									</div>
									{agent.serviceAvailability && (
										<Badge tone={statusTone(agent.serviceAvailability)}>
											服务：
											{agentServiceAvailabilityLabel(agent.serviceAvailability)}
										</Badge>
									)}
									<dl className="metadata-facts">
										<dt>可用范围</dt>
										<dd>
											{agent.configuration.availability
												.map((target) =>
													target.kind === "user"
														? `用户 ${target.userId}`
														: `组织 ${target.organizationId}`,
												)
												.join("、") || "未额外指定"}
										</dd>
										<dt>渠道</dt>
										<dd>
											{agent.configuration.channels
												.map((channel) => agentChannelKindLabels[channel.kind])
												.join("、") || "未配置"}
										</dd>
										<dt>模型</dt>
										<dd>
											{agent.configuration.modelOptions
												.map((model) => model.displayName)
												.join("、") || "未提供模型选项"}
										</dd>
									</dl>
									<div className="actions">
										<Link
											className={buttonVariants({ variant: "outline" })}
											params={{ agentId: agent.agentId }}
											to="/agents/$agentId/configuration"
											aria-label={withObjectName("配置与管理", agent.name)}
										>
											配置与管理
										</Link>
										<Link
											className={buttonVariants({ variant: "ghost" })}
											params={{ agentId: agent.agentId }}
											to="/agents/$agentId"
											aria-label={withObjectName("查看详情", agent.name)}
										>
											查看详情
										</Link>
									</div>
								</Card>
							))}
						</ul>
					)}
				</TabsContent>
			</Tabs>
		</section>
	);
}
