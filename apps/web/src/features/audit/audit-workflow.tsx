import { ScopedPlatformAuditQueryV1Schema } from "@agent-infra/contracts/pilot";
import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	ArrowRight,
	ChevronRight,
	RefreshCw,
	Search,
	X,
} from "lucide-react";
import {
	type FormEvent,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Field } from "@/components/ui/field";
import { IdentifierText } from "@/components/ui/identifier-text";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { LoadingLine } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Timestamp } from "@/components/ui/timestamp";
import { withObjectName } from "@/lib/accessible-name";
import { formatTimestamp } from "@/lib/format-time";
import { useApplicationSession } from "../application-shell.js";
import { DirectoryReadAlert, useDirectoryNames } from "../directory-names.js";
import {
	type AuditAgentOption,
	AuditAgentPicker,
} from "./audit-agent-picker.js";
import {
	auditActionLabels,
	auditObjectName,
	auditOutcomeLabel,
	auditResultLabels,
	auditResultTone,
} from "./audit-labels.js";
import type { AuditFilters, AuditScope } from "./audit-query.js";
import {
	AuditPrincipalName,
	AuditRecordDetail,
	auditDetailHeading,
	auditUserIds,
} from "./audit-record-detail.js";
import { useAuditQuery } from "./use-audit-query.js";

export function AuditWorkflow({ scope }: { scope: AuditScope }) {
	const { identityKey, session } = useApplicationSession();
	const admin = session.user.roles.includes("system_admin");
	return scope === "administrator" && !admin ? (
		<Alert tone="warn">
			<AlertDescription>当前无权访问平台审计。</AlertDescription>
		</Alert>
	) : (
		<AuditScreen key={`${identityKey}:${scope}`} scope={scope} />
	);
}

// 外置的常用筛选（设计 .filters 的 3 个字段）之外，其余字段收进「更多筛选」。
const moreFilterNames = [
	"until",
	"principalKind",
	"principalId",
	"agentId",
	"executionId",
] as const;
type FilterName = keyof AuditFilters;

function AuditScreen({ scope }: { scope: AuditScope }) {
	const { identityKey, session } = useApplicationSession();
	const [filters, setFilters] = useState<AuditFilters>({});
	const [auditId, setAuditId] = useState<string | null>(null);
	const [formFailure, setFormFailure] = useState<string | null>(null);
	const [moreOpen, setMoreOpen] = useState(false);
	// Agent 按名称选择；提交的仍是所选 Agent 的 ID（AC-2）。
	const [agentFilter, setAgentFilter] = useState<AuditAgentOption | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const detailPanel = useRef<HTMLElement>(null);
	const detailTrigger = useRef<HTMLButtonElement>(null);
	const invalidField = useRef<FilterName | null>(null);
	const [failureAttempt, setFailureAttempt] = useState(0);
	useLayoutEffect(() => {
		if (auditId !== null) detailPanel.current?.focus();
	}, [auditId]);
	// 校验错误落在「更多筛选」里时，区域展开后再聚焦出错字段。
	useLayoutEffect(() => {
		if (!failureAttempt || !invalidField.current) return;
		form.current
			?.querySelector<HTMLElement>(`[name="${invalidField.current}"]`)
			?.focus();
		invalidField.current = null;
	}, [failureAttempt]);
	function closeDetail() {
		setAuditId(null);
		detailTrigger.current?.focus();
	}

	const formId = useId();
	const query = useAuditQuery({ identityKey, scope, filters, auditId });
	const busy = query.status === "loading" || query.isFetching;
	const denied = query.status === "denied";
	const items = busy || formFailure ? [] : query.items;
	const administrator = scope === "administrator";
	// 列表与详情中的用户主体合并读取一次目录；后台组件与应用主体不是目录记录。
	const userNames = useDirectoryNames(
		"user",
		auditUserIds([...items, ...(query.detail ? [query.detail] : [])]),
	);
	const admin = session.user.roles.includes("system_admin");
	const fieldId = (name: string) => `${formId}-${name}`;
	const moreFilterCount = moreFilterNames.filter(
		(name) => filters[name],
	).length;
	function fail(message: string, field?: FilterName) {
		invalidField.current = field ?? null;
		if (field && (moreFilterNames as readonly string[]).includes(field))
			setMoreOpen(true);
		setFormFailure(message);
		setAuditId(null);
		setFailureAttempt((attempt) => attempt + 1);
	}
	function apply(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const data = new FormData(event.currentTarget);
		const next: Record<string, string> = {};
		for (const name of [
			"from",
			"until",
			"principalKind",
			"principalId",
			"agentId",
			"action",
			"result",
			"executionId",
		] as const) {
			const value =
				name === "agentId"
					? (agentFilter?.agentId ?? "")
					: String(data.get(name) ?? "").trim();
			if (!value) continue;
			if (name === "from" || name === "until") {
				const date = new Date(value);
				if (!Number.isFinite(date.getTime())) {
					fail("请输入有效的时间范围。", name);
					return;
				}
				next[name] = date.toISOString();
			} else next[name] = value;
		}
		if (Boolean(next.principalKind) !== Boolean(next.principalId)) {
			fail(
				"主体类型和主体 ID 需要同时填写。",
				next.principalKind ? "principalId" : "principalKind",
			);
			return;
		}
		if (next.from && next.until && next.from >= next.until) {
			fail("结束时间必须晚于起始时间。", "until");
			return;
		}
		const parsed = ScopedPlatformAuditQueryV1Schema.safeParse(next);
		if (!parsed.success) {
			fail("查询条件无效，请检查输入。");
			return;
		}
		setFormFailure(null);
		setAuditId(null);
		if (JSON.stringify(filters) === JSON.stringify(parsed.data))
			void query.refresh();
		else setFilters(parsed.data);
	}
	function reset() {
		form.current?.reset();
		setAgentFilter(null);
		setFormFailure(null);
		setAuditId(null);
		setMoreOpen(false);
		if (Object.keys(filters).length === 0) void query.refresh();
		else setFilters({});
	}
	return (
		<>
			<div className="page-heading">
				<div className="min-w-0">
					<p className="page-eyebrow">
						{administrator ? "系统管理 / 平台审计" : "我的管理 / 我的执行审计"}
					</p>
					<h1>
						{administrator ? "查看平台变更记录。" : "查看自己的执行记录。"}
					</h1>
					<p>
						{administrator
							? "可按关联信息查询请求和执行记录；不显示会话正文、凭证或模型思考。"
							: "只显示当前账号的记录；长标识可以展开查看。"}
					</p>
				</div>
				<Button
					variant="ghost"
					size="icon"
					aria-label="刷新审计记录"
					title="刷新审计记录"
					disabled={busy || denied}
					onClick={() => {
						setFormFailure(null);
						void query.refresh();
					}}
				>
					<RefreshCw aria-hidden="true" />
				</Button>
			</div>
			{admin && (
				<nav className="scope-tabs" aria-label="审计范围">
					<Link
						to="/audit"
						className={buttonVariants({
							variant: administrator ? "ghost" : "outline",
						})}
						aria-current={administrator ? undefined : "page"}
					>
						我的执行审计
					</Link>
					<Link
						to="/admin/audit"
						className={buttonVariants({
							variant: administrator ? "outline" : "ghost",
						})}
						aria-current={administrator ? "page" : undefined}
					>
						平台审计
					</Link>
				</nav>
			)}
			<form
				ref={form}
				onSubmit={apply}
				className="audit-filters"
				aria-label="审计查询条件"
			>
				<div className="audit-filter-grid">
					<Field>
						<Label htmlFor={fieldId("from")}>起始时间</Label>
						<Input id={fieldId("from")} name="from" type="datetime-local" />
					</Field>
					<Field>
						<Label htmlFor={fieldId("action")}>动作</Label>
						<NativeSelect id={fieldId("action")} name="action">
							<NativeSelectOption value="">全部动作</NativeSelectOption>
							{Object.entries(auditActionLabels).map(([value, label]) => (
								<NativeSelectOption key={value} value={value}>
									{label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
					<Field>
						<Label htmlFor={fieldId("result")}>结果</Label>
						<NativeSelect id={fieldId("result")} name="result">
							<NativeSelectOption value="">全部结果</NativeSelectOption>
							{Object.entries(auditResultLabels).map(([value, label]) => (
								<NativeSelectOption key={value} value={value}>
									{label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</Field>
				</div>
				{/* 收起时字段仍在表单内，已填写的值继续参与查询。 */}
				<div
					id={fieldId("more")}
					className="audit-filter-grid"
					hidden={!moreOpen}
				>
					<Field>
						<Label htmlFor={fieldId("until")}>结束时间</Label>
						<Input id={fieldId("until")} name="until" type="datetime-local" />
					</Field>
					{administrator && (
						<>
							<Field>
								<Label htmlFor={fieldId("principalKind")}>主体类型</Label>
								<NativeSelect
									id={fieldId("principalKind")}
									name="principalKind"
								>
									<NativeSelectOption value="">全部类型</NativeSelectOption>
									<NativeSelectOption value="user">用户</NativeSelectOption>
									<NativeSelectOption value="application">
										应用
									</NativeSelectOption>
								</NativeSelect>
							</Field>
							<Field>
								<Label htmlFor={fieldId("principalId")}>主体 ID</Label>
								<Input
									id={fieldId("principalId")}
									name="principalId"
									maxLength={128}
								/>
							</Field>
						</>
					)}
					<AuditAgentPicker
						id={fieldId("agentId")}
						label="Agent"
						scope={scope}
						value={agentFilter}
						onChange={setAgentFilter}
					/>
					<Field>
						<Label htmlFor={fieldId("executionId")}>Execution ID</Label>
						<Input
							id={fieldId("executionId")}
							name="executionId"
							maxLength={128}
						/>
					</Field>
				</div>
				{formFailure && (
					<Alert tone="danger" role="alert">
						<AlertDescription>{formFailure}</AlertDescription>
					</Alert>
				)}
				<div className="audit-filter-actions">
					<Button
						type="button"
						variant="outline"
						aria-expanded={moreOpen}
						aria-controls={fieldId("more")}
						onClick={() => setMoreOpen((open) => !open)}
					>
						{moreFilterCount ? `更多筛选（${moreFilterCount}）` : "更多筛选"}
					</Button>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={reset}
							disabled={busy}
						>
							重置
						</Button>
						<Button type="submit" disabled={busy}>
							<Search aria-hidden="true" />
							查询
						</Button>
					</div>
				</div>
			</form>
			<section className="py-5" aria-label="审计记录" aria-busy={busy}>
				{/* 平台审计保留原 #400 管理员审计的「事件时间线 / 平台操作记录」区头（#1199 AC-1）；
				    个人审计按设计筛选后直接是表格，不另设标题（V-08）。 */}
				{administrator && (
					<div className="mb-4 flex flex-wrap items-start justify-between gap-3">
						<div>
							<p className="mb-1 text-muted-foreground text-sm">事件时间线</p>
							<h2 className="font-semibold text-base">平台操作记录</h2>
						</div>
						<p className="text-muted-foreground text-sm">
							不包含会话正文、凭证值或模型内部思考
						</p>
					</div>
				)}
				<DirectoryReadAlert names={[userNames]} className="mb-4" />
				{denied ? (
					<Alert tone="danger" role="alert">
						<AlertDescription>
							当前无权访问审计记录，权限或会话可能已变化。
						</AlertDescription>
					</Alert>
				) : query.status === "error" ? (
					<Alert tone="danger" role="alert">
						<AlertDescription>审计查询失败，请稍后重试。</AlertDescription>
						{query.canRetry && (
							<AlertAction>
								<Button variant="outline" onClick={() => void query.retry()}>
									重试
								</Button>
							</AlertAction>
						)}
					</Alert>
				) : busy ? (
					<LoadingLine className="py-8">正在读取审计记录…</LoadingLine>
				) : !formFailure && items.length === 0 ? (
					<Empty>
						<EmptyDescription>暂无审计记录</EmptyDescription>
					</Empty>
				) : (
					!formFailure && (
						<Table className="audit-table" mobileLayout="cards">
							<TableHeader>
								<TableRow>
									<TableHead>时间</TableHead>
									<TableHead>事件</TableHead>
									<TableHead>对象</TableHead>
									<TableHead>主体</TableHead>
									<TableHead>结果</TableHead>
									<TableHead>
										<span className="sr-only">详情</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{items.map((record) => (
									<TableRow key={record.auditId}>
										<TableCell data-label="时间">
											<Timestamp value={record.occurredAt} />
										</TableCell>
										<TableCell data-label="事件">
											<strong>{auditActionLabels[record.action]}</strong>
											<small>{record.summary}</small>
										</TableCell>
										<TableCell data-label="对象">
											{auditObjectName(record)}
											{/* 对象 ID 以 IdentifierText 等宽短形式出现，完整值在 title 与详情中。 */}
											<small className="audit-identifier">
												<IdentifierText
													value={record.subject.subjectId}
													label="对象 ID"
												/>
											</small>
										</TableCell>
										<TableCell data-label="主体">
											<AuditPrincipalName
												kind={record.actor.kind}
												id={record.actor.actorId}
												displayName={record.actor.displayName}
												names={userNames}
											/>
											{record.originalPrincipal && (
												<small>
													原发起：
													<AuditPrincipalName
														kind={record.originalPrincipal.kind}
														id={record.originalPrincipal.id}
														displayName={record.originalPrincipal.displayName}
														names={userNames}
													/>
												</small>
											)}
										</TableCell>
										<TableCell data-label="结果">
											<Badge tone={auditResultTone(record.result)}>
												{auditOutcomeLabel(record)}
											</Badge>
										</TableCell>
										<TableCell data-label="详情">
											<Button
												variant="ghost"
												aria-label={withObjectName(
													"详情",
													`${auditActionLabels[record.action]} · ${formatTimestamp(record.occurredAt)?.full ?? ""}`,
												)}
												title="查看审计详情"
												aria-expanded={auditId === record.auditId}
												aria-controls={fieldId("detail")}
												onClick={(event) => {
													detailTrigger.current = event.currentTarget;
													setAuditId(record.auditId);
												}}
											>
												<ChevronRight strokeWidth={1.8} aria-hidden="true" />
												详情
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)
				)}
				<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
					{query.status === "ready" && !busy && !formFailure && (
						<p className="text-muted-foreground text-sm">
							第 {query.pageNumber} 页 · 本页 {items.length} 条
						</p>
					)}
					<div className="flex gap-2">
						<Button
							variant="outline"
							disabled={busy || formFailure !== null || !query.canPreviousPage}
							onClick={() => {
								setAuditId(null);
								query.previousPage();
							}}
						>
							<ArrowLeft aria-hidden="true" />
							上一页
						</Button>
						<Button
							variant="outline"
							disabled={busy || formFailure !== null || !query.hasNextPage}
							onClick={() => {
								setAuditId(null);
								query.nextPage();
							}}
						>
							下一页
							<ArrowRight aria-hidden="true" />
						</Button>
					</div>
				</div>
			</section>
			{auditId !== null && (
				<section
					ref={detailPanel}
					tabIndex={-1}
					id={fieldId("detail")}
					aria-label="审计详情"
					className="audit-detail-panel"
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.stopPropagation();
							closeDetail();
						}
					}}
				>
					<header className="section-heading">
						<div>
							<p className="page-eyebrow">记录详情</p>
							<h2>
								{query.detail &&
								query.detailStatus !== "loading" &&
								!query.isDetailFetching
									? auditDetailHeading(query.detail)
									: "审计详情"}
							</h2>
						</div>
						<Button
							variant="ghost"
							onClick={closeDetail}
							aria-label="关闭审计详情"
						>
							<X aria-hidden="true" />
							关闭
						</Button>
					</header>
					{query.failure || query.detailStatus === "denied" ? (
						<Alert tone="danger" role="alert">
							<AlertDescription>
								{denied || query.detailStatus === "denied"
									? "当前无权访问审计详情，资源或权限可能已变化。"
									: "审计查询失败，请稍后重试。"}
							</AlertDescription>
						</Alert>
					) : query.detailStatus === "error" ? (
						<Alert tone="danger" role="alert">
							<AlertDescription>
								审计详情读取失败，请稍后重试。
							</AlertDescription>
							<AlertAction>
								<Button
									variant="outline"
									onClick={() => void query.retryDetail()}
								>
									重试详情
								</Button>
							</AlertAction>
						</Alert>
					) : query.detailStatus === "loading" ||
						query.isDetailFetching ||
						busy ? (
						<LoadingLine>正在读取审计详情…</LoadingLine>
					) : query.detail ? (
						<>
							<div className="mb-4 flex justify-end">
								<Button
									variant="ghost"
									size="icon"
									aria-label="刷新审计详情"
									title="刷新审计详情"
									onClick={() => void query.retryDetail()}
								>
									<RefreshCw aria-hidden="true" />
								</Button>
							</div>
							<AuditRecordDetail record={query.detail} names={userNames} />
							<p className="page-note">
								只展示可审计元数据；不返回会话正文、Secret 值或模型内部思考。
							</p>
						</>
					) : null}
				</section>
			)}
			{administrator && (
				// 首屏即存在的审计范围说明，不设 live 角色。
				<Alert tone="info" className="mt-5">
					<AlertTitle>最小审计数据</AlertTitle>
					<AlertDescription>
						记录谁在何时对哪个对象做了什么及其结果，不保存对话正文、凭证值或模型内部思考。
						Connection 授权与外部效果由独立 Connection
						审计核实，关联引用不授予查询权限。
					</AlertDescription>
				</Alert>
			)}
		</>
	);
}
