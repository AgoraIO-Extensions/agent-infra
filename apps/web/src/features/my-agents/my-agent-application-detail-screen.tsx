import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Settings } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Timestamp } from "@/components/ui/timestamp";
import { useToast } from "@/components/ui/toast";
import { reasoningLevelLabel } from "@/lib/reasoning-level-label";
import { statusTone } from "@/lib/status-tone";

import type { AgentApplicationProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	agentConversationSourceLabel,
	agentIdentityResponsibilityLabel,
	agentManagementStatusLabels,
	agentSourceReferenceLabel,
} from "../agent-management-status.js";
import { DirectoryRecords } from "../directory-fields.js";
import { formatPerson } from "../directory-names.js";
import { PageLoadingState } from "../page-loading-state.js";
import { ReadFailureCard } from "../page-state-card.js";
import type { TemplateNameLookup } from "../template-display-name.js";
import {
	type ApplicationProgressStepKey,
	agentApplicationEditActionLabels,
	applicationProgressSteps,
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
	/** 模板显示名（部署配置）；未提供或读不到时显示「标准模板」（F-02）。 */
	templateName?: TemplateNameLookup;
	/** 创建失败类别（#3034）：由路由按服务端读取结果提供，只在创建失败时展示。 */
	creationFailure?: ReactNode;
};

type ApplicationStatus = AgentApplicationProjectionV2["status"];

// 「创建 Agent」一步的说明，与步骤 chip 一样只按申请状态取值。
const creationDetails: Record<ApplicationStatus, string> = {
	pending_approval: "审批通过后开始创建。",
	withdrawn: "当前申请不会创建 Agent。",
	rejected: "当前申请不会创建 Agent。",
	creating: "正在创建长期运行实例。",
	available: "Agent 已创建，可进入详情。",
	stopped: "Agent 已创建，当前已停止。",
	creation_failed: "创建未完成，Agent 尚不可用。",
	disabled: "Agent 已被系统管理员停用。",
};

// 侧栏「下一步」的说明；设计只画了待审批，其余状态按申请状态给出可执行的去向。
const nextStepNotes: Record<ApplicationStatus, string> = {
	pending_approval:
		"审批通过后，平台会创建长期运行实例并在完成健康检查后显示“就绪”。",
	creating: "审批通过后，平台会创建长期运行实例并在完成健康检查后显示“就绪”。",
	rejected: "查看审批原因，修改后重新提交。",
	withdrawn: "此记录为只读历史。再次申请请从“我的 Agent”新建。",
	available: "进入 Agent 详情查看运行状态。",
	stopped: "进入 Agent 详情查看运行状态。",
	creation_failed: "Owner 可以在 Agent 配置中重试创建。",
	disabled: "Agent 已被系统管理员停用。",
};

function ProgressDetail({
	step,
	application,
}: {
	step: ApplicationProgressStepKey;
	application: AgentApplicationProjectionV2;
}) {
	// 设计 applicationProgress：首步为「时间 · 申请人」（W-13）；没有申请人投影时只显示时间。
	if (step === "submitted")
		return (
			<>
				<Timestamp value={application.submittedAt} />
				{application.applicant?.displayName
					? ` · ${application.applicant.displayName}`
					: null}
			</>
		);
	if (step === "approval")
		return application.decision ? (
			<span>
				审批时间 <Timestamp value={application.decision.decidedAt} />
			</span>
		) : application.status === "withdrawn" ? (
			"申请已撤回，不再等待审批。"
		) : (
			"等待管理员审阅资源与配置。"
		);
	return creationDetails[application.status];
}

export function MyAgentApplicationDetailScreen({
	onRetry,
	onWithdraw,
	retrying = false,
	state,
	withdrawalError = false,
	withdrawalResult,
	withdrawing,
	templateName,
	creationFailure,
}: MyAgentApplicationDetailScreenProps) {
	const [confirmationFor, setConfirmationFor] = useState<string | null>(null);
	const [withdrawalLatched, setWithdrawalLatched] = useState(false);
	const withdrawalPending = withdrawing || withdrawalLatched;
	const submittedResult =
		state.kind === "ready" &&
		withdrawalResult?.applicationId === state.application.applicationId
			? withdrawalResult
			: undefined;
	const toast = useToast();
	const headingRef = useRef<HTMLHeadingElement>(null);
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
	// 设计：撤回成功只给 Toast「申请已撤回」（W-15）；「撤回申请」随状态消失，焦点交给页面 h1。
	useEffect(() => {
		if (!submittedResult) return;
		toast(
			submittedResult.status === "withdrawn"
				? "申请已撤回"
				: `撤回请求已提交：${agentManagementStatusLabels[submittedResult.status]}`,
		);
		headingRef.current?.focus();
	}, [submittedResult, toast]);
	if (state.kind === "loading")
		return <PageLoadingState title="申请详情" message="正在读取申请…" />;
	if (state.kind === "unavailable")
		return (
			<section aria-labelledby="my-agent-application-detail-heading">
				<header className="page-heading">
					<div>
						<h1 id="my-agent-application-detail-heading">申请详情</h1>
					</div>
				</header>
				{/* 公共状态卡按 401/403/404/503/响应无效选择（P-01）；403 与 404 文案相同。 */}
				<ReadFailureCard
					failure={state}
					deniedDescription="申请不存在，或你没有访问权限。"
					unavailableDescription="暂时无法读取申请，请稍后重试。"
					back={
						<Link
							activeOptions={{ exact: true }}
							className={buttonVariants({ variant: "outline" })}
							to="/my-agents"
						>
							返回我的 Agent
						</Link>
					}
					onRetry={onRetry}
					// 401「重新登录」后会话仍有效：重读详情（W-03）。
					onStillValid={onRetry}
					retrying={retrying}
					retryLabel="重新加载申请"
				/>
			</section>
		);
	const { application } = state;
	const { configuration } = application;
	const editAction = getAgentApplicationEditAction(application);
	const defaultModel = configuration.modelOptions.find(
		(model) => model.optionId === configuration.defaultModelOptionId,
	);
	const withdrawable = application.status === "pending_approval";
	const agentEntrance = hasCreatedAgent(application) ? application : null;
	const hasActions = Boolean(editAction || withdrawable || agentEntrance);
	return (
		<section aria-labelledby="my-agent-application-detail-heading">
			{/* 设计 .page-head：操作在页头右侧，≤767 换到标题下方。 */}
			<header className="page-heading application-detail-heading">
				<div>
					<Link
						activeOptions={{ exact: true }}
						className={buttonVariants({ variant: "ghost", size: "sm" })}
						to="/my-agents"
					>
						<ArrowLeft aria-hidden="true" />
						返回我的 Agent
					</Link>
					{/* 设计为可读编号（#2861 跟踪）；接口就绪前只写「申请详情」，不外露内部申请 ID。 */}
					<p className="page-eyebrow">申请详情</p>
					{/* tabIndex=-1：读取失败后「重新登录」「重新加载申请」恢复时焦点落在这里。 */}
					<h1
						id="my-agent-application-detail-heading"
						ref={headingRef}
						tabIndex={-1}
					>
						{application.name}
					</h1>
					<p>{application.description}</p>
				</div>
				{hasActions ? (
					<div className="card-actions">
						{editAction ? (
							<Link
								className={buttonVariants()}
								params={{ applicationId: application.applicationId }}
								to="/my-agents/$applicationId/edit"
							>
								{/* 设计 icon('settings') 齿轮，与企微「改用手动配置」一致（G4-10）。 */}
								<Settings aria-hidden="true" data-icon="inline-start" />
								{agentApplicationEditActionLabels[editAction]}
							</Link>
						) : null}
						{withdrawable ? (
							<ConfirmDialog
								open={confirmationFor === confirmationKey}
								onOpenChange={(open) =>
									setConfirmationFor(open ? confirmationKey : null)
								}
								disabled={withdrawalPending}
								trigger={
									<Button variant="outline" ref={withdrawButtonRef}>
										{withdrawalPending ? "正在撤回…" : "撤回申请"}
									</Button>
								}
								title="撤回这条申请？"
								// 设计文案不重复申请名：页面 h1 已是该申请（W-16）。
								description="撤回后申请不会进入审批队列；你可以重新创建申请。"
								// 设计稿只有「确认撤回」与页眉关闭钮，不再另给次按钮。
								cancelLabel={null}
								confirmLabel="确认撤回"
								onConfirm={() => {
									if (withdrawalPending) return;
									setWithdrawalLatched(true);
									onWithdraw();
								}}
							/>
						) : null}
						{agentEntrance ? (
							<Link
								className={buttonVariants({ variant: "outline" })}
								params={{ agentId: agentEntrance.agentId }}
								to="/agents/$agentId"
							>
								查看 Agent
							</Link>
						) : null}
					</div>
				) : null}
			</header>
			{withdrawalError ? (
				<Alert
					tone="danger"
					role="alert"
					className="application-detail-feedback"
				>
					<AlertDescription>
						暂未确认撤回结果，请先查看申请的最新状态。
					</AlertDescription>
				</Alert>
			) : null}
			<div className="form-layout application-detail-layout">
				<section
					className="application-progress-panel min-w-0"
					aria-labelledby="application-progress-heading"
				>
					<div className="section-heading">
						<div>
							<h2 id="application-progress-heading">审批进度</h2>
							<p>状态来自服务端事件</p>
						</div>
						<Badge tone={statusTone(application.status)}>
							{agentManagementStatusLabels[application.status]}
						</Badge>
					</div>
					<ul className="application-progress">
						{applicationProgressSteps(application.status).map((step) => (
							<li key={step.key} data-step={step.key}>
								<div>
									<strong>{step.title}</strong>
									<small>
										<ProgressDetail step={step.key} application={application} />
									</small>
								</div>
								<Badge tone={step.tone}>{step.label}</Badge>
							</li>
						))}
					</ul>
					{application.decision?.reason ? (
						<Alert tone="danger" className="application-decision-reason">
							{/* 设计驳回提示标题「需要修改后重提」（W-13）；只有驳回会带原因。 */}
							<AlertTitle>
								{application.status === "rejected"
									? "需要修改后重提"
									: "审批原因："}
							</AlertTitle>
							<AlertDescription>{application.decision.reason}</AlertDescription>
						</Alert>
					) : null}
					{application.status === "creation_failed" ? creationFailure : null}
				</section>
				<aside className="application-detail-aside">
					<section className="form-aside" aria-label="申请配置摘要">
						<h2>申请配置</h2>
						<dl className="metadata-facts">
							{/* 设计 #application-detail：一行「来源 = 标准模板 · Codex」，不再分「标准模板」
							    「入口模式」两行重复模板名。自定义 Agent 写入口方式，并保留镜像地址。 */}
							<dt>来源</dt>
							<dd>{agentConversationSourceLabel(application, templateName)}</dd>
							{application.source.kind === "custom" ? (
								<>
									<dt>镜像地址</dt>
									{/* 设计 dd.mono：镜像引用等宽（G4-15，同 Owner 配置的镜像引用）；按字符折行沿 .metadata-facts dd。 */}
									<dd className="font-mono">
										{agentSourceReferenceLabel(application, templateName)}
									</dd>
								</>
							) : null}
							<dt>入口身份责任</dt>
							<dd>{agentIdentityResponsibilityLabel(application)}</dd>
							<dt>Owner</dt>
							<dd>
								{configuration.owners
									.map(
										(owner) =>
											formatPerson({ displayName: owner.displayName }).name,
									)
									.join("、") || "未提供"}
							</dd>
							<dt>更新于</dt>
							<dd>
								<Timestamp
									value={application.updatedAt ?? application.submittedAt}
								/>
							</dd>
							<dt>使用范围</dt>
							<dd>
								{/* 设计只写名称，与 Owner 行一样是一行「、」分隔的名称，不列组织路径（G4-16）。 */}
								<DirectoryRecords
									targets={configuration.availability}
									layout="inline"
									empty="未额外指定"
								/>
							</dd>
							<dt>模型范围</dt>
							<dd>
								{configuration.modelOptions.length ? (
									<ul>
										{/* 与审批弹窗一致：「显示名 · 档位」，不外露 modelId。 */}
										{configuration.modelOptions.map((model) => (
											<li key={model.optionId}>
												{[
													model.displayName,
													model.reasoningLevels
														.map(reasoningLevelLabel)
														.join("、"),
												]
													.filter(Boolean)
													.join(" · ")}
											</li>
										))}
									</ul>
								) : (
									"未提供模型选项"
								)}
							</dd>
							<dt>默认模型</dt>
							<dd>
								{/* 找不到对应选项时不显示内部选项 ID。 */}
								{defaultModel?.displayName ??
									(configuration.defaultModelOptionId
										? "未识别的模型选项"
										: "未提供")}
							</dd>
							<dt>默认推理档位</dt>
							<dd>
								{configuration.defaultReasoningLevel
									? reasoningLevelLabel(configuration.defaultReasoningLevel)
									: "未提供"}
							</dd>
						</dl>
					</section>
					<section
						className="form-aside application-next-step"
						aria-labelledby="application-next-step-heading"
					>
						<h2 id="application-next-step-heading">下一步</h2>
						<p className="page-note">{nextStepNotes[application.status]}</p>
						<div className="card-actions">
							<Link
								className={buttonVariants({ variant: "ghost" })}
								to="/agents"
							>
								<ArrowRight aria-hidden="true" data-icon="inline-start" />
								查看 Agent 目录
							</Link>
						</div>
					</section>
					{/* 设计 .application-resource：段落只留 12px 上外边距，末段不再多出下外边距（E3-03）。 */}
					<section className="form-aside application-resource">
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
