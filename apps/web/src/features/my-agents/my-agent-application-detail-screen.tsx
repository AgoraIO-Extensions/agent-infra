import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
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
import { agentManagementStatusLabels } from "../agent-management-status.js";
import {
	agentApplicationEditActionLabels,
	getAgentApplicationEditAction,
	hasCreatedAgent,
	type MyAgentApplicationState,
} from "./my-agent-applications.js";

type MyAgentApplicationDetailScreenProps = {
	onWithdraw: () => void;
	state: MyAgentApplicationState | { kind: "loading" };
	withdrawalError?: boolean;
	withdrawalResult?: AgentApplicationProjectionV2;
	withdrawing: boolean;
};

export function MyAgentApplicationDetailScreen({
	onWithdraw,
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
	useEffect(() => {
		if (withdrawalError && !withdrawing) setWithdrawalLatched(false);
	}, [withdrawalError, withdrawing]);
	useEffect(() => {
		if (withdrawalError && !withdrawing) withdrawButtonRef.current?.focus();
	}, [withdrawalError, withdrawing]);
	if (state.kind === "loading") return <p role="status">正在读取申请…</p>;
	if (state.kind === "unavailable")
		return (
			<section aria-labelledby="my-agent-application-detail-heading">
				<header className="page-heading">
					<h1 id="my-agent-application-detail-heading">申请详情暂不可用</h1>
				</header>
				<p className="alert" role="alert">
					{state.retryable
						? "暂时无法读取申请，请稍后重试。"
						: "当前无法查看此申请。"}
				</p>
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
					<h1 id="my-agent-application-detail-heading">申请详情</h1>
					<p>申请记录与处理进度。</p>
				</div>
				<Link
					className={buttonVariants({ variant: "outline" })}
					to="/my-agents"
				>
					返回我的 Agent
				</Link>
			</header>
			<div className="form-layout">
				<div className="min-w-0">
					<div className="status-line">
						<Badge variant="outline">
							{agentManagementStatusLabels[application.status]}
						</Badge>
						<span>
							提交于{" "}
							<time dateTime={application.submittedAt}>
								{application.submittedAt}
							</time>
						</span>
					</div>
					{application.decision?.reason ? (
						<div className="alert text-destructive" role="status">
							<strong>审批原因：</strong>
							<span>{application.decision.reason}</span>
						</div>
					) : null}
					<section className="detail-section" aria-label="申请配置摘要">
						<h2>{application.name}</h2>
						<p>{application.description}</p>
						<dl>
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
							{application.decision ? (
								<>
									<dt>审批时间</dt>
									<dd>
										<time dateTime={application.decision.decidedAt}>
											{application.decision.decidedAt}
										</time>
									</dd>
								</>
							) : null}
						</dl>
					</section>
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
						<p ref={resultRef} tabIndex={-1} className="alert" role="status">
							撤回请求已提交：
							{agentManagementStatusLabels[submittedResult.status]}。
						</p>
					) : null}
					{withdrawalError ? (
						<p className="alert text-destructive" role="alert">
							暂未确认撤回结果，请先查看申请的最新状态。
						</p>
					) : null}
				</div>
				<aside className="form-aside">
					<h2>申请说明</h2>
					<p>审批用于确认预设资源占用。</p>
					<ol>
						<li>填写配置并提交申请</li>
						<li>管理员审阅</li>
						<li>批准后创建 Agent</li>
					</ol>
					<h2>资源预设</h2>
					<p>{application.resourceProfile.displayName}</p>
					<p className="text-sm">
						CPU {application.resourceProfile.estimatedResources.cpuMillicores} m
						· 内存 {application.resourceProfile.estimatedResources.memoryMiB}{" "}
						MiB · 存储{" "}
						{application.resourceProfile.estimatedResources.storageGiB} GiB
					</p>
					<p className="text-muted-foreground text-sm">
						Secret 和模型凭证不回显。申请结果以此处读取的最新状态为准。
					</p>
				</aside>
			</div>
		</section>
	);
}
