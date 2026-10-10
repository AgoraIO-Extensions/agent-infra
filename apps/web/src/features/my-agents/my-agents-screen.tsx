import { Link } from "@tanstack/react-router";
import { Plus, RefreshCw } from "lucide-react";
import { useId } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentChannelKindLabels } from "../agent-discovery/agent-discovery-screen.js";
import {
	agentConversationSourceLabel,
	agentManagementStatusLabels,
	agentServiceAvailabilityLabel,
} from "../agent-management-status.js";
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
				<TabsList
					activateOnFocus
					variant="line"
					className="tabs"
					aria-label="我的 Agent 视图"
				>
					<TabsTrigger value="applications">申请</TabsTrigger>
					<TabsTrigger value="agents">已创建 Agent</TabsTrigger>
				</TabsList>
				<TabsContent value="applications">
					{state.kind === "loading" ? (
						<p role="status" className="py-8">
							正在读取申请…
						</p>
					) : state.kind === "unavailable" ? (
						<Alert className="my-5">
							<AlertDescription>
								{state.retryable
									? "暂时无法读取申请，请稍后重试。"
									: "当前无法查看申请，请联系管理员。"}
							</AlertDescription>
							{state.retryable && onRetryApplications ? (
								<Button
									className="mt-4"
									variant="outline"
									disabled={retryingApplications}
									onClick={onRetryApplications}
									type="button"
								>
									<RefreshCw aria-hidden="true" data-icon="inline-start" />
									{retryingApplications ? "正在重新加载…" : "重新加载申请"}
								</Button>
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
												<Badge
													variant="outline"
													data-status={application.status}
												>
													{agentManagementStatusLabels[application.status]}
												</Badge>
												<Badge
													variant="outline"
													className="max-w-full whitespace-normal rounded-[7px] [overflow-wrap:anywhere]"
												>
													{application.source.kind === "standard"
														? application.source.templateId
														: agentConversationSourceLabel(application)}
												</Badge>
											</div>
											<Link
												params={{ applicationId: application.applicationId }}
												to="/my-agents/$applicationId"
											>
												<h2>{application.name}</h2>
											</Link>
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
											>
												查看申请
											</Link>
											{editAction ? (
												<Link
													className={buttonVariants({ variant: "outline" })}
													params={{ applicationId: application.applicationId }}
													to="/my-agents/$applicationId/edit"
												>
													{agentApplicationEditActionLabels[editAction]}
												</Link>
											) : null}
											{hasCreatedAgent(application) ? (
												<Link
													className={buttonVariants({ variant: "link" })}
													params={{ agentId: application.agentId }}
													to="/agents/$agentId"
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
						<p role="status" className="py-8">
							正在读取你管理的 Agent…
						</p>
					) : ownedAgentsUnavailable ? (
						<Alert className="my-5">
							<AlertDescription>
								{ownedAgentsRetryable
									? "暂时无法读取你管理的 Agent，请稍后重试。"
									: "当前无法查看你管理的 Agent，请联系管理员。"}
							</AlertDescription>
							{ownedAgentsRetryable && onRetryOwnedAgents ? (
								<Button
									className="mt-4"
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
								<li className="owned-agent-card" key={agent.agentId}>
									<div className="owned-card-heading">
										<span className="agent-detail-mark" aria-hidden="true">
											{Array.from(agent.name)[0]}
										</span>
										<div>
											<h2>{agent.name}</h2>
											<p>
												Owner ·{" "}
												{agent.configuration.owners
													.map((owner) => owner.displayName || owner.userId)
													.join("、")}
											</p>
										</div>
										<Badge
											variant="outline"
											data-status={agent.managementStatus}
										>
											{agentManagementStatusLabels[agent.managementStatus]}
										</Badge>
									</div>
									{agent.serviceAvailability && (
										<Badge
											variant="outline"
											data-status={agent.serviceAvailability}
										>
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
										>
											配置与管理
										</Link>
										<Link
											className={buttonVariants({ variant: "ghost" })}
											params={{ agentId: agent.agentId }}
											to="/agents/$agentId"
										>
											查看详情
										</Link>
									</div>
								</li>
							))}
						</ul>
					)}
				</TabsContent>
			</Tabs>
		</section>
	);
}
