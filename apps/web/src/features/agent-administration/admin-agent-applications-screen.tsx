import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useResultFocus } from "@/hooks/use-result-focus";
import type { BrowserSessionProjectionV1 } from "../../pilot/generated/types.gen.js";
import type { AgentApplicationProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type { BrowserSessionState } from "../browser-session.js";
import type {
	AgentApplicationDecision,
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
	onRetry?: () => void;
	retrying?: boolean;
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
	const [localDecisionPending, setLocalDecisionPending] = useState(false);
	const lastDecisionError = useRef(decisionError);
	const reasonId = useId();
	const reasonInput = useRef<HTMLTextAreaElement>(null);
	const matchingPendingDecision =
		pendingDecision?.applicationId === application.applicationId
			? pendingDecision
			: undefined;
	const deciding = matchingPendingDecision !== undefined;
	const decisionSubmitting = deciding || localDecisionPending;
	const currentDecision =
		matchingPendingDecision !== undefined
			? matchingPendingDecision.decision
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
	useEffect(() => {
		const errorAdvanced =
			decisionError !== null && decisionError !== lastDecisionError.current;
		lastDecisionError.current = decisionError;
		if (errorAdvanced) setLocalDecisionPending(false);
	}, [decisionError]);
	return (
		<Dialog
			open={open && !resolved}
			onOpenChange={(next) => {
				if (decisionSubmitting) return;
				if (next) {
					setOpen(true);
					onOpenChange?.(true);
				} else close();
			}}
		>
			<DialogTrigger
				className={buttonVariants({ variant: "outline" })}
				disabled={decisionSubmitting || resolved}
			>
				{currentDecision ? "审批提交中…" : "审阅申请"}
			</DialogTrigger>
			<DialogContent showCloseButton={!decisionSubmitting}>
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
								disabled={decisionSubmitting || resolved}
								onClick={() => {
									if (!decisionSubmitting && !resolved) {
										setLocalDecisionPending(true);
										onDecision(application.applicationId, {
											decision: "approve",
										});
									}
								}}
							>
								{currentDecision?.decision === "approve"
									? "批准中…"
									: "批准并创建"}
							</Button>
							<Button
								variant="outline"
								disabled={decisionSubmitting}
								onClick={() => setRejecting(true)}
							>
								驳回
							</Button>
							<Button
								variant="ghost"
								disabled={decisionSubmitting}
								onClick={close}
							>
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
							if (decisionSubmitting || resolved) return;
							const trimmedReason = reason.trim();
							if (!trimmedReason) {
								setReasonError(true);
								reasonInput.current?.focus();
								return;
							}
							setLocalDecisionPending(true);
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
								disabled={decisionSubmitting}
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
								<Alert id={`${reasonId}-error`} variant="destructive">
									<AlertDescription>请输入驳回原因。</AlertDescription>
								</Alert>
							)}
						</div>
						<div className="flex flex-wrap gap-3">
							<Button disabled={decisionSubmitting || resolved} type="submit">
								{currentDecision?.decision === "reject"
									? "提交中…"
									: "确认驳回"}
							</Button>
							<Button
								variant="outline"
								disabled={decisionSubmitting}
								onClick={() => setRejecting(false)}
								type="button"
							>
								返回审阅
							</Button>
						</div>
					</form>
				)}
				{decisionError && (
					<Alert variant="destructive" className="mt-4">
						<AlertDescription>
							{decisionFailure(decisionError)}
						</AlertDescription>
					</Alert>
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
	onRetry,
	retrying = false,
}: AdminAgentApplicationsScreenProps) {
	const [search, setSearch] = useState("");
	const [source, setSource] = useState("all");
	const filterId = useId();
	const applications = state.kind === "ready" ? state.applications : [];
	const sources = [
		...new Set(
			applications.map((a) =>
				a.source.kind === "standard" ? a.source.templateId : "自定义 Agent",
			),
		),
	];
	const filteredApplications = applications.filter(
		(a) =>
			(source === "all" ||
				source ===
					(a.source.kind === "standard"
						? a.source.templateId
						: "自定义 Agent")) &&
			[
				a.name,
				a.description,
				...a.configuration.owners.map((o) => o.displayName || o.userId),
			]
				.join(" ")
				.toLocaleLowerCase()
				.includes(search.trim().toLocaleLowerCase()),
	);
	const [openApplicationId, setOpenApplicationId] = useState<string | null>(
		null,
	);
	useEffect(() => {
		const renderedPendingApplication =
			session.kind === "ready" &&
			isSystemAdministrator(session.session) &&
			state.kind === "ready" &&
			state.applications.some(
				(application) =>
					application.applicationId === openApplicationId &&
					application.status === "pending_approval",
			);
		if (openApplicationId !== null && !renderedPendingApplication)
			setOpenApplicationId(null);
	}, [openApplicationId, session, state]);
	if (session.kind === "loading")
		return <p aria-live="polite">正在读取审批申请…</p>;
	if (session.kind !== "ready" || !isSystemAdministrator(session.session))
		return (
			<Alert>
				<AlertDescription>当前无法访问审批。</AlertDescription>
			</Alert>
		);
	return (
		<section aria-labelledby="agent-approvals-heading">
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">系统管理 / 创建审批</p>
					<h1 id="agent-approvals-heading">把资源审批做得更快，也更可核对。</h1>
					<p>审批信息保持紧凑：来源、Owner、范围、模型与渠道一屏完成判断。</p>
				</div>
				{state.kind === "ready" && (
					<Badge variant="outline" data-status="pending_approval">
						{applications.filter((a) => a.status === "pending_approval").length}{" "}
						项待处理
					</Badge>
				)}
			</header>
			<DecisionFeedback decision={decisionResult} />
			{state.kind === "loading" ? (
				<p role="status">正在读取审批申请…</p>
			) : state.kind === "unavailable" ? (
				<Alert className="mt-5">
					<AlertDescription>
						{state.retryable
							? "审批列表暂时无法读取，请稍后重试。"
							: "审批列表不可用，请联系管理员。"}
					</AlertDescription>
					{state.retryable && onRetry ? (
						<Button
							className="mt-4"
							variant="outline"
							disabled={retrying}
							onClick={onRetry}
							type="button"
						>
							<RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
							{retrying ? "正在重试…" : "重新加载审批"}
						</Button>
					) : null}
				</Alert>
			) : (
				<>
					<div className="approval-filters">
						<div>
							<Label htmlFor={`${filterId}-search`}>搜索申请或 Owner</Label>
							<Input
								id={`${filterId}-search`}
								type="search"
								placeholder="搜索申请名称或 Owner"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
						</div>
						<div>
							<Label htmlFor={`${filterId}-source`}>来源</Label>
							<NativeSelect
								id={`${filterId}-source`}
								value={source}
								onChange={(event) => setSource(event.target.value)}
							>
								<NativeSelectOption value="all">全部来源</NativeSelectOption>
								{sources.map((value) => (
									<NativeSelectOption key={value} value={value}>
										{value}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</div>
					</div>
					{filteredApplications.length === 0 ? (
						<Empty className="py-12">
							<EmptyDescription>
								{applications.length ? "没有匹配的申请。" : "暂无待审批申请。"}
							</EmptyDescription>
						</Empty>
					) : (
						<Table className="approval-table" aria-label="创建审批">
							<TableHeader>
								<TableRow>
									<TableHead>申请</TableHead>
									<TableHead>来源 / Owner</TableHead>
									<TableHead>可用范围</TableHead>
									<TableHead>模型</TableHead>
									<TableHead>提交时间</TableHead>
									<TableHead>
										<span className="sr-only">操作</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filteredApplications.map((application) => (
									<TableRow key={application.applicationId}>
										<TableCell>
											<strong>{application.name}</strong>
											<small>{application.description}</small>
											<Badge variant="outline" data-status={application.status}>
												{agentManagementStatusLabels[application.status]}
											</Badge>
										</TableCell>
										<TableCell>
											{application.source.kind === "standard"
												? application.source.templateId
												: "自定义 Agent"}
											<small>
												Owner ·{" "}
												{application.configuration.owners
													.map((o) => o.displayName || o.userId)
													.join("、") || "未提供"}
											</small>
										</TableCell>
										<TableCell>
											{application.configuration.availability
												.map((target) =>
													target.kind === "user"
														? `用户 ${target.userId}`
														: `组织 ${target.organizationId}`,
												)
												.join("、") || "未额外指定"}
										</TableCell>
										<TableCell>
											{application.configuration.modelOptions
												.map((model) => model.displayName)
												.join("、") || "未提供模型选项"}
										</TableCell>
										<TableCell>
											<time dateTime={application.submittedAt}>
												{new Date(application.submittedAt).toLocaleString()}
											</time>
										</TableCell>
										<TableCell>
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
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</>
			)}
			{decisionError && openApplicationId === null && (
				<Alert variant="destructive" className="mt-4">
					<AlertDescription>{decisionFailure(decisionError)}</AlertDescription>
				</Alert>
			)}
		</section>
	);
}
