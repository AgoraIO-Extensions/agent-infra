import { Tabs } from "@base-ui/react/tabs";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentServiceAvailabilityLabel } from "../agent-discovery/agent-discovery-screen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type { MyAgentApplicationsState } from "./my-agent-applications.js";

type MyAgentsScreenProps = {
	state: MyAgentApplicationsState | { kind: "loading" };
	/** The caller supplies Agents for which the current session is an Owner. */
	ownedAgents?: AgentProjectionV2[];
	ownedAgentsLoading?: boolean;
	ownedAgentsUnavailable?: boolean;
};

export function MyAgentsScreen({
	state,
	ownedAgents,
	ownedAgentsLoading = false,
	ownedAgentsUnavailable = false,
}: MyAgentsScreenProps) {
	const id = useId();
	return (
		<section aria-labelledby={`${id}-heading`}>
			<header className="page-heading">
				<div>
					<h1 id={`${id}-heading`}>我的 Agent</h1>
					<p>跟进创建申请，管理你负责的 Agent。</p>
				</div>
				<Link className={buttonVariants()} to="/my-agents/new">
					<Plus aria-hidden="true" />
					申请 Agent
				</Link>
			</header>
			<Tabs.Root defaultValue="applications">
				<Tabs.List
					activateOnFocus
					className="tabs"
					aria-label="我的 Agent 视图"
				>
					<Tabs.Tab value="applications">申请</Tabs.Tab>
					<Tabs.Tab value="agents">已创建 Agent</Tabs.Tab>
				</Tabs.List>
				<Tabs.Panel value="applications">
					{state.kind === "loading" ? (
						<p role="status" className="py-8">
							正在读取申请…
						</p>
					) : state.kind === "unavailable" ? (
						<p className="py-8 text-muted-foreground" role="alert">
							{state.retryable
								? "暂时无法读取申请，请稍后重试。"
								: "当前无法查看申请，请联系管理员。"}
						</p>
					) : state.applications.length === 0 ? (
						<div className="empty">
							<h2>暂无 Agent 申请</h2>
							<p>提交申请后，可在这里查看审批与创建进度。</p>
						</div>
					) : (
						<ul aria-label="我的申请">
							{state.applications.map((application) => (
								<li className="record-row" key={application.applicationId}>
									<div className="min-w-0 flex-1">
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
									<Badge variant="outline">
										{agentManagementStatusLabels[application.status]}
									</Badge>
									<div className="actions">
										<Link
											className={buttonVariants({ variant: "outline" })}
											params={{ applicationId: application.applicationId }}
											to="/my-agents/$applicationId"
										>
											申请详情
										</Link>
										{application.agentId ? (
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
							))}
						</ul>
					)}
				</Tabs.Panel>
				<Tabs.Panel value="agents">
					{ownedAgentsLoading ? (
						<p role="status" className="py-8">
							正在读取你管理的 Agent…
						</p>
					) : ownedAgentsUnavailable ? (
						<p className="py-8 text-muted-foreground" role="alert">
							暂时无法读取你管理的 Agent，请稍后重试。
						</p>
					) : ownedAgents === undefined ? (
						<p className="py-8 text-muted-foreground">
							尚未读取你管理的 Agent。
						</p>
					) : ownedAgents.length === 0 ? (
						<div className="empty">
							<h2>暂无你管理的 Agent</h2>
							<p>你担任 Owner 的 Agent 会显示在这里。</p>
						</div>
					) : (
						<ul aria-label="我管理的 Agent">
							{ownedAgents.map((agent) => (
								<li className="record-row" key={agent.agentId}>
									<div className="min-w-0 flex-1">
										<h2>{agent.name}</h2>
										<p>{agent.description}</p>
										<p className="text-sm">
											{agent.source.kind === "standard"
												? `标准模板 · ${agent.source.templateId}`
												: "自定义 Agent"}{" "}
											· Owner 管理
										</p>
									</div>
									<Badge variant="outline">
										{agentManagementStatusLabels[agent.managementStatus]}
									</Badge>
									{agent.serviceAvailability && (
										<Badge variant="outline">
											服务：
											{agentServiceAvailabilityLabel(agent.serviceAvailability)}
										</Badge>
									)}
									<Link
										className={buttonVariants({ variant: "outline" })}
										params={{ agentId: agent.agentId }}
										to="/agents/$agentId/configuration"
									>
										配置与管理
									</Link>
								</li>
							))}
						</ul>
					)}
				</Tabs.Panel>
			</Tabs.Root>
		</section>
	);
}
