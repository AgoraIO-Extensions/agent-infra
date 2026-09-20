import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useResultFocus } from "@/hooks/use-result-focus";
import type { BrowserSessionProjectionV1 } from "../../pilot/generated/types.gen.js";
import type { AgentApplicationProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type {
	AgentApplicationDecision,
	BrowserSessionState,
	PendingAgentApplicationsState,
} from "./agent-administration.js";

type AdministrationSessionState = BrowserSessionState | { kind: "loading" };
type PendingDecision = {
	readonly applicationId: string;
	readonly decision: AgentApplicationDecision;
};
type RequestError = Error & { readonly retryable?: boolean };
type AdminAgentApplicationsScreenProps = {
	decisionError?: RequestError | null;
	decisionResult?: AgentApplicationProjectionV2;
	onDecision: (
		applicationId: string,
		decision: AgentApplicationDecision,
	) => void;
	pendingDecision?: PendingDecision;
	session: AdministrationSessionState;
	state: PendingAgentApplicationsState | { kind: "loading" };
};

type ApplicationReviewProps = {
	application: AgentApplicationProjectionV2;
	onDecision: AdminAgentApplicationsScreenProps["onDecision"];
	pendingDecision?: PendingDecision;
	decisionError?: RequestError | null;
	decisionResult?: AgentApplicationProjectionV2;
	onOpenChange?: (open: boolean) => void;
};

function isSystemAdministrator(session: BrowserSessionProjectionV1) {
	// This controls visibility only. The Platform authorizes every decision command.
	return session.user.roles.includes("system_admin");
}
function decisionFailure(error: RequestError) {
	return error.retryable === false
		? "权限或申请状态已变化，请刷新页面。"
		: "审批未能提交，请稍后重试。";
}
function DecisionFeedback({
	decision,
}: {
	decision?: AgentApplicationProjectionV2;
}) {
	const resultRef = useResultFocus(decision);
	return decision ? (
		<p
			ref={resultRef}
			tabIndex={-1}
			className="mt-4 font-medium text-sm"
			role="status"
		>
			已提交 {decision.name} 的审批结果：
			{agentManagementStatusLabels[decision.status]}。
		</p>
	) : null;
}

function ApplicationReview({
	application,
	onDecision,
	pendingDecision,
	decisionError,
	decisionResult,
	onOpenChange,
}: ApplicationReviewProps) {
	const [open, setOpen] = useState(false);
	const [rejecting, setRejecting] = useState(false);
	const [reason, setReason] = useState("");
	const [reasonError, setReasonError] = useState(false);
	const reasonId = useId();
	const reasonInput = useRef<HTMLTextAreaElement>(null);
	const deciding = pendingDecision !== undefined;
	const currentDecision =
		pendingDecision?.applicationId === application.applicationId
			? pendingDecision.decision
			: undefined;
	const resolved =
		decisionResult?.applicationId === application.applicationId &&
		decisionResult.status !== "pending_approval";
	const { configuration, resourceProfile, source } = application;
	const resources = resourceProfile.estimatedResources;
	const close = useCallback(() => {
		setOpen(false);
		onOpenChange?.(false);
		setRejecting(false);
		setReason("");
		setReasonError(false);
	}, [onOpenChange]);
	useEffect(() => {
		if (resolved && open) close();
	}, [close, open, resolved]);
	return (
		<Dialog
			open={open && !resolved}
			onOpenChange={(next) => {
				if (deciding) return;
				if (next) {
					setOpen(true);
					onOpenChange?.(true);
				} else close();
			}}
		>
			<DialogTrigger
				className={buttonVariants({ variant: "outline" })}
				disabled={deciding || resolved}
			>
				{currentDecision ? "审批提交中…" : "审阅申请"}
			</DialogTrigger>
			<DialogContent showCloseButton={!deciding}>
				<DialogTitle>{rejecting ? "驳回申请" : "审阅创建申请"}</DialogTitle>
				<DialogDescription>
					{rejecting
						? "请输入申请人可以据此修改的具体原因。"
						: "确认用途、Owner、使用范围与平台给出的只读资源规格。"}
				</DialogDescription>
				<h3 className="mt-5 break-words font-semibold">{application.name}</h3>
				<p className="break-words text-muted-foreground">
					{application.description}
				</p>
				{!rejecting ? (
					<>
						<dl className="detail-list my-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm">
							<dt>{source.kind === "standard" ? "模板" : "镜像"}</dt>
							<dd className="break-all">
								{source.kind === "standard"
									? source.templateId
									: source.imageReference}
							</dd>
							<dt>Owner</dt>
							<dd className="break-words">
								{configuration.owners
									.map((owner) => owner.displayName || owner.userId)
									.join("、") || "未提供"}
							</dd>
							<dt>使用范围</dt>
							<dd className="break-all">
								{configuration.availability
									.map((target) =>
										target.kind === "user"
											? `员工：${target.userId}`
											: `组织：${target.organizationId}`,
									)
									.join("；") || "未提供额外范围"}
							</dd>
							<dt>模型</dt>
							<dd className="break-words">
								{configuration.modelOptions
									.map((model) => `${model.displayName}（${model.modelId}）`)
									.join("、") || "未提供模型选项"}
							</dd>
							<dt>默认模型</dt>
							<dd className="break-all">
								{configuration.defaultModelOptionId ?? "未提供"}
							</dd>
							<dt>默认推理强度</dt>
							<dd className="break-words">
								{configuration.defaultReasoningLevel ?? "未提供"}
							</dd>
							<dt>预设规格</dt>
							<dd>{resourceProfile.displayName}（只读）</dd>
							<dt>预计资源占用</dt>
							<dd>
								{resources.cpuMillicores}m CPU / {resources.memoryMiB} MiB 内存
								/ {resources.storageGiB} GiB 存储
							</dd>
						</dl>
						<p className="text-muted-foreground text-sm">
							批准后才开始创建 Agent；审批受理不表示服务已就绪。
						</p>
						<div className="mt-5 flex flex-wrap gap-3">
							<Button
								disabled={deciding || resolved}
								onClick={() => {
									if (!deciding && !resolved)
										onDecision(application.applicationId, {
											decision: "approve",
										});
								}}
							>
								{currentDecision?.decision === "approve"
									? "批准中…"
									: "批准并创建"}
							</Button>
							<Button
								variant="outline"
								disabled={deciding}
								onClick={() => setRejecting(true)}
							>
								驳回
							</Button>
							<Button variant="ghost" disabled={deciding} onClick={close}>
								取消
							</Button>
						</div>
					</>
				) : (
					<form
						className="mt-5 space-y-4"
						noValidate
						onSubmit={(event) => {
							event.preventDefault();
							if (deciding || resolved) return;
							const trimmedReason = reason.trim();
							if (!trimmedReason) {
								setReasonError(true);
								reasonInput.current?.focus();
								return;
							}
							onDecision(application.applicationId, {
								decision: "reject",
								reason: trimmedReason,
							});
						}}
					>
						<div className="space-y-2">
							<Label htmlFor={reasonId}>驳回原因</Label>
							<Textarea
								ref={reasonInput}
								id={reasonId}
								disabled={deciding}
								required
								value={reason}
								aria-invalid={reasonError || undefined}
								aria-describedby={reasonError ? `${reasonId}-error` : undefined}
								onChange={(event) => {
									setReason(event.target.value);
									setReasonError(false);
								}}
							/>
							{reasonError && (
								<p
									id={`${reasonId}-error`}
									role="alert"
									className="text-destructive text-sm"
								>
									请输入驳回原因。
								</p>
							)}
						</div>
						<div className="flex flex-wrap gap-3">
							<Button disabled={deciding || resolved} type="submit">
								{currentDecision?.decision === "reject"
									? "提交中…"
									: "确认驳回"}
							</Button>
							<Button
								variant="outline"
								disabled={deciding}
								onClick={() => setRejecting(false)}
								type="button"
							>
								返回审阅
							</Button>
						</div>
					</form>
				)}
				{decisionError && (
					<p role="alert" className="mt-4 text-destructive text-sm">
						{decisionFailure(decisionError)}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function AdminAgentApplicationsScreen({
	decisionError = null,
	decisionResult,
	onDecision,
	pendingDecision,
	session,
	state,
}: AdminAgentApplicationsScreenProps) {
	const [openApplicationId, setOpenApplicationId] = useState<string | null>(
		null,
	);
	if (session.kind === "loading")
		return <p aria-live="polite">正在读取审批申请…</p>;
	if (session.kind !== "ready" || !isSystemAdministrator(session.session))
		return <p role="alert">当前无法访问审批。</p>;
	if (state.kind === "loading")
		return <p aria-live="polite">正在读取审批申请…</p>;
	return (
		<section aria-labelledby="agent-approvals-heading">
			<header className="page-heading flex-col space-y-2">
				<h1 id="agent-approvals-heading" className="font-semibold text-[28px]">
					审批
				</h1>
				<p className="text-muted-foreground">
					审阅 Agent 创建申请，确认预设资源占用。
				</p>
			</header>
			<DecisionFeedback decision={decisionResult} />
			{state.kind === "unavailable" ? (
				<p className="mt-5 text-muted-foreground" role="alert">
					{state.retryable
						? "审批列表暂时无法读取，请稍后重试。"
						: "审批列表不可用，请联系管理员。"}
				</p>
			) : (
				<>
					<div className="tabs mt-6 border-border border-b pb-3">
						<span className="font-medium text-sm">
							待审批{" "}
							{
								state.applications.filter(
									(application) => application.status === "pending_approval",
								).length
							}
						</span>
					</div>
					{state.applications.length === 0 ? (
						<p className="empty-state py-12 text-center text-muted-foreground">
							暂无待审批申请。
						</p>
					) : (
						<ul>
							{state.applications.map((application) => (
								<li
									className="record-row flex flex-wrap items-center gap-4 border-border border-b py-5"
									key={application.applicationId}
								>
									<div className="min-w-0 flex-1">
										<h2 className="break-words font-semibold">
											{application.name}
										</h2>
										<p className="mt-1 break-words text-muted-foreground text-sm">
											{application.description}
										</p>
										<p className="mt-1 text-muted-foreground text-sm">
											提交时间：
											{new Date(application.submittedAt).toLocaleString()}
										</p>
									</div>
									<Badge variant="outline">
										{agentManagementStatusLabels[application.status]}
									</Badge>
									{application.status === "pending_approval" && (
										<ApplicationReview
											application={application}
											onDecision={onDecision}
											pendingDecision={pendingDecision}
											decisionError={
												openApplicationId === application.applicationId
													? decisionError
													: null
											}
											decisionResult={decisionResult}
											onOpenChange={(open) =>
												setOpenApplicationId(
													open ? application.applicationId : null,
												)
											}
										/>
									)}
								</li>
							))}
						</ul>
					)}
				</>
			)}
			{decisionError && openApplicationId === null && (
				<p className="mt-4 text-destructive text-sm" role="alert">
					{decisionFailure(decisionError)}
				</p>
			)}
		</section>
	);
}
