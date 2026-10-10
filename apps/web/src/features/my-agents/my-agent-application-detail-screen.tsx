import { Link } from "@tanstack/react-router";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { useResultFocus } from "@/hooks/use-result-focus";

import type { AgentApplicationProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	agentConversationSourceLabel,
	agentIdentityResponsibilityLabel,
	agentManagementStatusLabels,
} from "../agent-management-status.js";
import { PageLoadingState } from "../page-loading-state.js";
import {
	agentApplicationEditActionLabels,
	getAgentApplicationEditAction,
	hasCreatedAgent,
	type MyAgentApplicationState,
} from "./my-agent-applications.js";

type MyAgentApplicationDetailScreenProps = {
	onRetry?: () => void;
	onWithdraw: () => void;
	retrying?: boolean;
	state: MyAgentApplicationState | { kind: "loading" };
	withdrawalError?: boolean;
	withdrawalResult?: AgentApplicationProjectionV2;
	withdrawing: boolean;
};

export function MyAgentApplicationDetailScreen({
	onRetry,
	onWithdraw,
	retrying = false,
	state,
	withdrawalError = false,
	withdrawalResult,
	withdrawing,
}: MyAgentApplicationDetailScreenProps) {
	const [confirmationFor, setConfirmationFor] = useState<string | null>(null);
	const [withdrawalLatched, setWithdrawalLatched] = useState(false);
	const withdrawalPending = withdrawing || withdrawalLatched;
	const submittedResult =
		state.kind === "ready" &&
		withdrawalResult?.applicationId === state.application.applicationId
			? withdrawalResult
			: undefined;
	const resultRef = useResultFocus(submittedResult);
	const withdrawButtonRef = useRef<HTMLButtonElement>(null);
	const confirmationKey =
		state.kind === "ready"
			? `${state.application.applicationId}:${state.application.status}`
			: state.kind;
	const applicationId =
		state.kind === "ready" ? state.application.applicationId : null;
	useEffect(() => {
		if (withdrawalError && !withdrawing) setWithdrawalLatched(false);
	}, [withdrawalError, withdrawing]);
	useEffect(() => {
		if (withdrawalError && !withdrawing && !withdrawalLatched) {
			withdrawButtonRef.current?.focus();
		}
	}, [withdrawalError, withdrawing, withdrawalLatched]);
	useEffect(() => {
		if (applicationId !== null) setWithdrawalLatched(false);
	}, [applicationId]);
	if (state.kind === "loading")
		return <PageLoadingState title="申请详情" message="正在读取申请…" />;
	if (state.kind === "unavailable")
		return (
			<section aria-labelledby="my-agent-application-detail-heading">
				<header className="page-heading">
					<h1 id="my-agent-application-detail-heading">申请详情暂不可用</h1>
				</header>
				<Alert className="my-3">
					<AlertDescription>
						{state.retryable
							? "暂时无法读取申请，请稍后重试。"
							: "当前无法查看此申请。"}
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
							{retrying ? "正在重新加载…" : "重新加载申请"}
						</Button>
					) : null}
				</Alert>
				<Link
					className={buttonVariants({ variant: "outline" })}
					to="/my-agents"
				>
					返回我的 Agent
				</Link>
			</section>
		);
	const { application } = state;
	const { configuration } = application;
	const editAction = getAgentApplicationEditAction(application);
	const defaultModel = configuration.modelOptions.find(
		(model) => model.optionId === configuration.defaultModelOptionId,
	);
	return (
		<section aria-labelledby="my-agent-application-detail-heading">
			<header className="page-heading">
				<div>
					<Link
						className={buttonVariants({ variant: "ghost" })}
						to="/my-agents"
					>
						<ArrowLeft aria-hidden="true" />
						返回我的 Agent
					</Link>
					<p className="page-eyebrow">申请详情 · {application.applicationId}</p>
					<h1 id="my-agent-application-detail-heading">{application.name}</h1>
					<p>{application.description}</p>
				</div>
			</header>
			<div className="form-layout application-detail-layout">
				<div className="min-w-0">
					<div className="section-heading">
						<div>
							<h2>审批进度</h2>
							<p>状态以最新申请记录为准</p>
						</div>
						<Badge variant="outline" data-status={application.status}>
							{agentManagementStatusLabels[application.status]}
						</Badge>
					</div>
					<ul className="application-progress">
						<li>
							<div>
								<strong>申请已提交</strong>
								<small>
									提交于{" "}
									<time dateTime={application.submittedAt}>
										{application.submittedAt}
									</time>
								</small>
							</div>
							<Badge variant="outline">已提交</Badge>
						</li>
						<li>
							<div>
								<strong>系统管理员审批</strong>
								<small>
									{application.decision ? (
										<span>
											审批时间{" "}
											<time dateTime={application.decision.decidedAt}>
												{application.decision.decidedAt}
											</time>
										</span>
									) : application.status === "withdrawn" ? (
										"申请已撤回，不再等待审批。"
									) : (
										"等待管理员审阅资源与配置。"
									)}
								</small>
							</div>
							<Badge variant="outline" data-status={application.status}>
								{application.decision
									? "已审批"
									: application.status === "withdrawn"
										? "不再审批"
										: "等待"}
							</Badge>
						</li>
					</ul>
					{application.decision?.reason ? (
						<Alert variant="destructive" role="status" className="my-3">
							<AlertDescription>
								<strong>审批原因：</strong>
								<span>{application.decision.reason}</span>
							</AlertDescription>
						</Alert>
					) : null}

					<div className="actions">
						{editAction ? (
							<Link
								className={buttonVariants()}
								params={{ applicationId: application.applicationId }}
								to="/my-agents/$applicationId/edit"
							>
								{agentApplicationEditActionLabels[editAction]}
							</Link>
						) : null}
						{application.status === "pending_approval" ? (
							<Dialog
								open={confirmationFor === confirmationKey}
								onOpenChange={(open) =>
									setConfirmationFor(open ? confirmationKey : null)
								}
							>
								<DialogTrigger
									className={buttonVariants({ variant: "outline" })}
									disabled={withdrawalPending}
									ref={withdrawButtonRef}
								>
									{withdrawalPending ? "正在撤回…" : "撤回申请"}
								</DialogTrigger>
								<DialogContent>
									<DialogTitle>撤回这项申请？</DialogTitle>
									<DialogDescription>
										“{application.name}
										”撤回后保留为只读历史，不再等待审批。再次申请需要新建申请。
									</DialogDescription>
									<div className="mt-6 flex flex-wrap gap-3">
										<DialogClose
											className={buttonVariants({ variant: "outline" })}
										>
											继续保留申请
										</DialogClose>
										<Button
											disabled={withdrawalPending}
											onClick={() => {
												if (withdrawalPending) return;
												setWithdrawalLatched(true);
												setConfirmationFor(null);
												onWithdraw();
											}}
										>
											确认撤回
										</Button>
									</div>
								</DialogContent>
							</Dialog>
						) : null}
						{hasCreatedAgent(application) ? (
							<Link
								className={buttonVariants({ variant: "outline" })}
								params={{ agentId: application.agentId }}
								to="/agents/$agentId"
							>
								查看 Agent
							</Link>
						) : null}
					</div>
					{application.status === "withdrawn" ? (
						<p className="mt-5 text-muted-foreground">
							此记录为只读历史。再次申请请从“我的 Agent”新建。
						</p>
					) : null}
					{submittedResult ? (
						<Alert ref={resultRef} tabIndex={-1} className="my-3" role="status">
							<AlertDescription>
								撤回请求已提交：
								{agentManagementStatusLabels[submittedResult.status]}。
							</AlertDescription>
						</Alert>
					) : null}
					{withdrawalError ? (
						<Alert variant="destructive" className="my-3">
							<AlertDescription>
								暂未确认撤回结果，请先查看申请的最新状态。
							</AlertDescription>
						</Alert>
					) : null}
				</div>
				<aside className="application-detail-aside">
					{" "}
					<section className="form-aside" aria-label="申请配置摘要">
						<h2>申请配置</h2>
						<dl className="metadata-facts">
							<dt>
								{application.source.kind === "standard"
									? "标准模板"
									: "镜像地址"}
							</dt>
							<dd>
								{application.source.kind === "standard"
									? application.source.templateId
									: application.source.imageReference}
							</dd>
							<dt>入口模式</dt>
							<dd>{agentConversationSourceLabel(application)}</dd>
							<dt>入口身份责任</dt>
							<dd>{agentIdentityResponsibilityLabel(application)}</dd>
							<dt>Owner</dt>
							<dd>
								{configuration.owners
									.map((owner) => owner.displayName)
									.join("、") || "未提供"}
							</dd>
							<dt>使用范围</dt>
							<dd>
								{configuration.availability.length ? (
									<ul>
										{configuration.availability.map((target) => (
											<li key={JSON.stringify(target)}>
												{target.kind === "user"
													? `用户 ${target.userId}`
													: `组织 ${target.organizationId}`}
											</li>
										))}
									</ul>
								) : (
									"未额外指定"
								)}
							</dd>
							<dt>模型范围</dt>
							<dd>
								{configuration.modelOptions.length ? (
									<ul>
										{configuration.modelOptions.map((model) => (
											<li key={model.optionId}>
												{model.displayName} · {model.modelId} ·{" "}
												{model.reasoningLevels.join("、")}
											</li>
										))}
									</ul>
								) : (
									"未提供模型选项"
								)}
							</dd>
							<dt>默认模型</dt>
							<dd>
								{defaultModel?.displayName ??
									configuration.defaultModelOptionId ??
									"未提供"}
							</dd>
							<dt>默认推理档位</dt>
							<dd>{configuration.defaultReasoningLevel ?? "未提供"}</dd>
						</dl>
					</section>
					<section className="form-aside">
						<h2>资源预设</h2>
						<p>{application.resourceProfile.displayName}</p>
						<p>
							CPU {application.resourceProfile.estimatedResources.cpuMillicores}{" "}
							m · 内存{" "}
							{application.resourceProfile.estimatedResources.memoryMiB} MiB ·
							存储 {application.resourceProfile.estimatedResources.storageGiB}{" "}
							GiB
						</p>
						<p>Secret 和模型凭证不回显。</p>
					</section>
				</aside>
			</div>
		</section>
	);
}
