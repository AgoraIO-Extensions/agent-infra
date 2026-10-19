import { EyeIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Field, FieldError } from "@/components/ui/field";
import { IdentifierText } from "@/components/ui/identifier-text";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { SearchInput } from "@/components/ui/search-input";
import { LoadingLine } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Timestamp } from "@/components/ui/timestamp";
import { useToast } from "@/components/ui/toast";
import { withObjectName } from "@/lib/accessible-name";
import { reasoningLevelLabel } from "@/lib/reasoning-level-label";
import type { BrowserSessionProjectionV1 } from "../../pilot/generated/types.gen.js";
import type { AgentApplicationProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentSourceReferenceLabel } from "../agent-management-status.js";
import type { BrowserSessionState } from "../browser-session.js";
import {
	AvailabilityNameList,
	type AvailabilityNames,
	DirectoryReadAlert,
	formatPerson,
	useAvailabilityNames,
} from "../directory-names.js";
import {
	formatMultiServiceManifestSummary,
	parseMultiServiceManifest,
} from "../my-agents/multi-service-manifest.js";
import { RecoveryButton } from "../recovery-button.js";
import {
	type TemplateNameLookup,
	templateDisplayName,
} from "../template-display-name.js";
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
	/** 模板显示名（部署配置）；未提供或读不到时显示「标准模板」（F-02）。 */
	templateName?: TemplateNameLookup;
};

type ApplicationReviewProps = {
	application: AgentApplicationProjectionV2;
	names: AvailabilityNames;
	templateName?: TemplateNameLookup;
	onDecision: AdminAgentApplicationsScreenProps["onDecision"];
	pendingDecision?: PendingDecision;
	decisionError?: RequestError | null;
	decisionResult?: AgentApplicationProjectionV2;
	onOpenChange?: (open: boolean) => void;
	/** 行内「审阅」按钮，供决定后计算焦点落点。 */
	triggerRef: (node: HTMLButtonElement | null) => void;
	/** 决定提交后弹窗关闭（或该行移出队列）时的焦点落点。 */
	focusAfterDecision: () => HTMLElement | null;
};

/** Owner 显示投影中的姓名；姓名缺失时，系统管理员页面附 ID 短形式以便核对。 */
function OwnerNames({
	owners,
}: {
	owners: AgentApplicationProjectionV2["configuration"]["owners"];
}) {
	if (!owners.length) return <>未提供</>;
	return (
		<>
			{owners.map((owner, index) => (
				<span key={owner.userId}>
					{index ? "、" : null}
					{formatPerson({ displayName: owner.displayName }).name}
					{owner.displayName.trim() ? null : (
						<>
							{" "}
							<IdentifierText label="Owner ID" value={owner.userId} />
						</>
					)}
				</span>
			))}
		</>
	);
}
function isSystemAdministrator(session: BrowserSessionProjectionV1) {
	// This controls visibility only. The Platform authorizes every decision command.
	return session.user.roles.includes("system_admin");
}
function decisionFailure(error: RequestError) {
	return error.retryable === false
		? "权限或申请状态已变化，请刷新页面。"
		: "审批未能提交，请稍后重试。";
}
function sourceName(
	application: AgentApplicationProjectionV2,
	templateName?: TemplateNameLookup,
) {
	return application.source.kind === "standard"
		? templateDisplayName(application.source.templateId, templateName)
		: "manifest" in application.source
			? "多服务 Agent"
			: "自定义 Agent";
}
function sourceFilterValue(application: AgentApplicationProjectionV2) {
	return application.source.kind === "standard"
		? application.source.templateId
		: "自定义 Agent";
}
/** 筛选项文字：标准模板显示模板名，不显示原始 templateId（F-02）。 */
function sourceFilterLabel(
	application: AgentApplicationProjectionV2,
	templateName?: TemplateNameLookup,
) {
	return application.source.kind === "standard"
		? templateDisplayName(application.source.templateId, templateName)
		: "自定义 Agent";
}

/** 设计审阅弹窗「模型」行：「显示名 · 档位」，不显示 modelId（F-02）。 */
function ModelOptions({
	options,
}: {
	options: AgentApplicationProjectionV2["configuration"]["modelOptions"];
}) {
	if (!options.length) return <>未提供模型选项</>;
	return (
		<ul className="space-y-1">
			{options.map((model) => (
				<li key={model.optionId}>
					{[
						model.displayName,
						model.reasoningLevels.map(reasoningLevelLabel).join("、"),
					]
						.filter(Boolean)
						.join(" · ")}
				</li>
			))}
		</ul>
	);
}

function ApplicationReview({
	application,
	names,
	templateName,
	onDecision,
	pendingDecision,
	decisionError,
	decisionResult,
	onOpenChange,
	triggerRef,
	focusAfterDecision,
}: ApplicationReviewProps) {
	const [open, setOpen] = useState(false);
	const [rejecting, setRejecting] = useState(false);
	const [reason, setReason] = useState("");
	const [reasonError, setReasonError] = useState(false);
	const [localDecisionPending, setLocalDecisionPending] = useState(false);
	const lastDecisionError = useRef(decisionError);
	const popup = useRef<HTMLDivElement>(null);
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
	// 弹窗关闭（或本行随队列重取被移除）时读取：决定已提交则交给页面计算的稳定落点。
	const decided = useRef(false);
	decided.current = decisionSubmitting || resolved;
	const { configuration, resourceProfile, source } = application;
	const resources = resourceProfile.estimatedResources;
	const multiServiceSummary =
		source.kind === "custom" && "manifest" in source
			? parseMultiServiceManifest(source.manifest)
			: undefined;
	const defaultModel = configuration.modelOptions.find(
		(model) => model.optionId === configuration.defaultModelOptionId,
	);
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
	// 切到驳回视图后与设计 openModal 一致，焦点放在弹窗容器，不落到 body。
	useEffect(() => {
		if (rejecting) popup.current?.focus();
	}, [rejecting]);
	const triggerLabel = currentDecision ? "审批提交中…" : "审阅";
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
				ref={triggerRef}
				className={buttonVariants({ variant: "outline" })}
				disabled={decisionSubmitting || resolved}
				aria-label={withObjectName(triggerLabel, application.name)}
			>
				<EyeIcon aria-hidden="true" />
				{triggerLabel}
			</DialogTrigger>
			<DialogContent
				ref={popup}
				showCloseButton={!decisionSubmitting}
				finalFocus={() => (decided.current ? focusAfterDecision() : true)}
			>
				<DialogHeader>
					<DialogTitle>
						{rejecting ? "填写驳回原因" : "审阅创建申请"}
					</DialogTitle>
				</DialogHeader>
				{!rejecting ? (
					<>
						<DialogBody>
							<dl className="review-facts">
								<dt>申请</dt>
								<dd>{application.name}</dd>
								<dt>说明</dt>
								<dd>{application.description}</dd>
								<dt>
									{source.kind === "standard"
										? "模板"
										: "manifest" in source
											? "多服务清单"
											: "镜像"}
								</dt>
								<dd className="break-all">
									{agentSourceReferenceLabel({ source }, templateName)}
								</dd>
								{multiServiceSummary?.ok ? (
									<>
										<dt>服务摘要</dt>
										<dd>
											{formatMultiServiceManifestSummary(
												multiServiceSummary.summary,
											)}
										</dd>
									</>
								) : null}
								<dt>Owner</dt>
								<dd>
									<OwnerNames owners={configuration.owners} />
								</dd>
								<dt>使用范围</dt>
								<dd>
									<AvailabilityNameList
										targets={configuration.availability}
										names={names}
										layout="list"
										identifier
										empty="未提供额外范围"
									/>
								</dd>
								<dt>模型</dt>
								<dd>
									<ModelOptions options={configuration.modelOptions} />
								</dd>
								<dt>默认模型</dt>
								<dd>{defaultModel?.displayName ?? "未提供"}</dd>
								<dt>默认推理强度</dt>
								<dd>
									{configuration.defaultReasoningLevel
										? reasoningLevelLabel(configuration.defaultReasoningLevel)
										: "未提供"}
								</dd>
								<dt>预设规格</dt>
								<dd>{resourceProfile.displayName}（只读）</dd>
								<dt>预计资源占用</dt>
								<dd>
									{resources.cpuMillicores}m CPU / {resources.memoryMiB} MiB
									内存 / {resources.storageGiB} GiB 存储
								</dd>
							</dl>
							{/* 首屏即存在的静态判断提示，不设 live 角色。 */}
							<Alert tone="warn" className="mt-[18px]">
								<AlertTitle>审批判断</AlertTitle>
								<AlertDescription>
									核对范围和 Owner 责任，再决定是否创建实例。批准后才开始创建
									Agent；审批受理不表示服务已就绪。
								</AlertDescription>
							</Alert>
						</DialogBody>
						<DialogFooter>
							<Button
								variant="outline"
								disabled={decisionSubmitting}
								onClick={() => setRejecting(true)}
							>
								驳回并说明
							</Button>
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
									: "批准申请"}
							</Button>
						</DialogFooter>
					</>
				) : (
					<form
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
						<DialogBody>
							<Field>
								<Label htmlFor={reasonId}>驳回原因</Label>
								<Textarea
									ref={reasonInput}
									id={reasonId}
									disabled={decisionSubmitting}
									required
									placeholder="说明需要修改的范围、模型或渠道"
									value={reason}
									aria-invalid={reasonError || undefined}
									aria-describedby={
										reasonError ? `${reasonId}-error` : undefined
									}
									onChange={(event) => {
										setReason(event.target.value);
										setReasonError(false);
									}}
								/>
								{reasonError && (
									<FieldError id={`${reasonId}-error`}>
										请填写驳回原因。
									</FieldError>
								)}
							</Field>
						</DialogBody>
						<DialogFooter>
							<Button
								variant="ghost"
								disabled={decisionSubmitting}
								onClick={close}
								type="button"
							>
								取消
							</Button>
							<Button disabled={decisionSubmitting || resolved} type="submit">
								{currentDecision?.decision === "reject"
									? "提交中…"
									: "确认驳回"}
							</Button>
						</DialogFooter>
					</form>
				)}
				{decisionError && (
					<Alert tone="danger" role="alert" className="mt-4">
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
	templateName,
}: AdminAgentApplicationsScreenProps) {
	const [search, setSearch] = useState("");
	const [source, setSource] = useState("all");
	const filterId = useId();
	const toast = useToast();
	const heading = useRef<HTMLHeadingElement>(null);
	const triggers = useRef(new Map<string, HTMLButtonElement>());
	const focusPlan = useRef<
		{ applicationId: string; candidates: string[] } | undefined
	>(undefined);
	const toasted = useRef<AgentApplicationProjectionV2 | undefined>(undefined);
	const applications = state.kind === "ready" ? state.applications : [];
	// 表格与审阅弹窗共用同一次目录读取。
	const names = useAvailabilityNames(
		applications.flatMap(
			(application) => application.configuration.availability,
		),
	);
	const sources = [
		...new Map(
			applications.map((application) => [
				sourceFilterValue(application),
				sourceFilterLabel(application, templateName),
			]),
		),
	];
	const query = search.trim().toLocaleLowerCase();
	// placeholder 列出的字段都参与匹配：申请名称、说明与 Owner 显示名。
	const filteredApplications = applications.filter(
		(a) =>
			(source === "all" || source === sourceFilterValue(a)) &&
			[
				a.name,
				a.description,
				...a.configuration.owners.map(
					(o) => formatPerson({ displayName: o.displayName }).name,
				),
			]
				.join(" ")
				.toLocaleLowerCase()
				.includes(query),
	);
	const pendingCount = applications.filter(
		(a) => a.status === "pending_approval",
	).length;
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
	// 决定成功只用 Toast 播报；Toast 不接收焦点，焦点由弹窗关闭时的 finalFocus 落到稳定目标。
	useEffect(() => {
		if (
			!decisionResult ||
			decisionResult === toasted.current ||
			decisionResult.status === "pending_approval"
		)
			return;
		toasted.current = decisionResult;
		toast(
			decisionResult.status === "rejected"
				? "已驳回，申请人会看到修改原因"
				: "申请已批准，创建任务已进入后台",
		);
	}, [decisionResult, toast]);
	// 提交决定时记下当前顺序：该行移出队列后，焦点依次落到下一条、上一条的「审阅」，都没有时落到页面标题。
	const planFocus = (applicationId: string) => {
		const order = filteredApplications.map((a) => a.applicationId);
		const index = order.indexOf(applicationId);
		focusPlan.current = {
			applicationId,
			candidates:
				index < 0
					? []
					: [...order.slice(index + 1), ...order.slice(0, index).reverse()],
		};
	};
	const focusAfterDecision = (applicationId: string) => {
		const plan =
			focusPlan.current?.applicationId === applicationId
				? focusPlan.current.candidates
				: [];
		for (const candidate of plan) {
			const trigger = triggers.current.get(candidate);
			if (trigger?.isConnected && !trigger.disabled) return trigger;
		}
		return heading.current;
	};
	if (session.kind === "loading")
		return <LoadingLine>正在读取审批申请…</LoadingLine>;
	if (session.kind !== "ready" || !isSystemAdministrator(session.session))
		return (
			<Alert tone="warn">
				<AlertDescription>当前无法访问审批。</AlertDescription>
			</Alert>
		);
	return (
		<section aria-labelledby="agent-approvals-heading">
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">系统管理 / 创建审批</p>
					<h1 id="agent-approvals-heading" ref={heading} tabIndex={-1}>
						审批申请
					</h1>
					<p>申请里列出来源、Owner、范围、模型和渠道。</p>
				</div>
				{state.kind === "ready" && (
					<div className="tag-row">
						<Badge tone="amber">{pendingCount} 项待处理</Badge>
						<Badge variant="tag">系统管理员 · 只读审计</Badge>
					</div>
				)}
			</header>
			{state.kind === "ready" ? (
				<DirectoryReadAlert names={[names]} className="mb-4" />
			) : null}
			{state.kind === "loading" ? (
				<LoadingLine>正在读取审批申请…</LoadingLine>
			) : state.kind === "unavailable" ? (
				<Alert tone="danger" role="alert" className="mt-5">
					<AlertDescription>
						{state.retryable
							? "审批列表暂时无法读取，请稍后重试。"
							: "审批列表不可用，请联系管理员。"}
					</AlertDescription>
					{state.retryable && onRetry ? (
						<AlertAction>
							<RecoveryButton
								variant="outline"
								recoveryKey="重新加载审批"
								busy={retrying}
								onClick={onRetry}
							>
								<RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
								{retrying ? "正在重试…" : "重新加载审批"}
							</RecoveryButton>
						</AlertAction>
					) : null}
				</Alert>
			) : (
				<>
					<div className="approval-filters">
						<SearchInput
							label="搜索申请"
							id={`${filterId}-search`}
							placeholder="搜索申请名称或 Owner"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
						<Field>
							<Label htmlFor={`${filterId}-source`}>来源</Label>
							<NativeSelect
								id={`${filterId}-source`}
								value={source}
								onChange={(event) => setSource(event.target.value)}
							>
								<NativeSelectOption value="all">全部来源</NativeSelectOption>
								{sources.map(([value, label]) => (
									<NativeSelectOption key={value} value={value}>
										{label}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
					</div>
					{filteredApplications.length === 0 ? (
						<Empty>
							<EmptyDescription>
								{applications.length ? "没有匹配的申请。" : "暂无待审批申请。"}
							</EmptyDescription>
						</Empty>
					) : (
						<Table
							className="approval-table"
							mobileLayout="cards"
							aria-label="创建审批"
						>
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
										<TableCell data-label="申请">
											<strong>{application.name}</strong>
										</TableCell>
										<TableCell data-label="来源 / Owner">
											{sourceName(application, templateName)}
											<small>
												Owner ·{" "}
												<OwnerNames owners={application.configuration.owners} />
											</small>
										</TableCell>
										<TableCell data-label="可用范围">
											<AvailabilityNameList
												targets={application.configuration.availability}
												names={names}
												identifier
												empty="未额外指定"
											/>
										</TableCell>
										<TableCell data-label="模型">
											{application.configuration.modelOptions
												.map((model) => model.displayName)
												.join("、") || "未提供模型选项"}
										</TableCell>
										<TableCell data-label="提交时间">
											<Timestamp value={application.submittedAt} />
										</TableCell>
										<TableCell data-cell="actions">
											{application.status === "pending_approval" && (
												<ApplicationReview
													names={names}
													templateName={templateName}
													application={application}
													onDecision={(applicationId, decision) => {
														planFocus(applicationId);
														onDecision(applicationId, decision);
													}}
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
													triggerRef={(node) => {
														if (node)
															triggers.current.set(
																application.applicationId,
																node,
															);
														else
															triggers.current.delete(
																application.applicationId,
															);
													}}
													focusAfterDecision={() =>
														focusAfterDecision(application.applicationId)
													}
												/>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
					{/* 设计 .page-note：只在列表就绪（含空队列）时出现。 */}
					<p className="page-note">
						审批只决定平台资源与准入，Connection 授权仍由使用者独立完成。
					</p>
				</>
			)}
			{decisionError && openApplicationId === null && (
				<Alert tone="danger" role="alert" className="mt-4">
					<AlertDescription>{decisionFailure(decisionError)}</AlertDescription>
				</Alert>
			)}
		</section>
	);
}
