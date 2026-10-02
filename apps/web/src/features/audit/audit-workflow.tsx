import { ScopedPlatformAuditQueryV1Schema } from "@agent-infra/contracts/pilot";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Eye, RotateCcw, Search } from "lucide-react";
import {
	type FormEvent,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { useApplicationSession } from "../application-shell.js";
import {
	auditActionLabels,
	auditOutcomeLabel,
	auditPrincipalLabels,
	auditResultLabels,
	auditSubjectLabels,
	auditTimestamp,
} from "./audit-labels.js";
import type { AuditFilters, AuditScope } from "./audit-query.js";
import { AuditRecordDetail } from "./audit-record-detail.js";
import { useAuditQuery } from "./use-audit-query.js";

export function AuditWorkflow({ scope }: { scope: AuditScope }) {
	const { identityKey, session } = useApplicationSession();
	const admin = session.user.roles.includes("system_admin");
	return scope === "administrator" && !admin ? (
		<Alert>
			<AlertDescription>当前无权访问平台审计。</AlertDescription>
		</Alert>
	) : (
		<AuditScreen key={`${identityKey}:${scope}`} scope={scope} />
	);
}

function AuditScreen({ scope }: { scope: AuditScope }) {
	const { identityKey, session } = useApplicationSession();
	const [filters, setFilters] = useState<AuditFilters>({});
	const [auditId, setAuditId] = useState<string | null>(null);
	const [formFailure, setFormFailure] = useState<string | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const detailPanel = useRef<HTMLElement>(null);
	const detailTrigger = useRef<HTMLButtonElement>(null);
	useLayoutEffect(() => {
		if (auditId !== null) detailPanel.current?.focus();
	}, [auditId]);
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
	const admin = session.user.roles.includes("system_admin");
	const fieldId = (name: string) => `${formId}-${name}`;
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
		]) {
			const value = String(data.get(name) ?? "").trim();
			if (!value) continue;
			if (name === "from" || name === "until") {
				const date = new Date(value);
				if (!Number.isFinite(date.getTime())) {
					setFormFailure("请输入有效的时间范围。");
					setAuditId(null);
					return;
				}
				next[name] = date.toISOString();
			} else next[name] = value;
		}
		if (Boolean(next.principalKind) !== Boolean(next.principalId)) {
			setFormFailure("主体类型和主体 ID 需要同时填写。");
			setAuditId(null);
			return;
		}
		if (next.from && next.until && next.from >= next.until) {
			setFormFailure("结束时间必须晚于起始时间。");
			setAuditId(null);
			return;
		}
		const parsed = ScopedPlatformAuditQueryV1Schema.safeParse(next);
		if (!parsed.success) {
			setFormFailure("查询条件无效，请检查输入。");
			setAuditId(null);
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
		setFormFailure(null);
		setAuditId(null);
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
						{administrator ? "复核平台关键变更。" : "只看自己的执行事实。"}
					</h1>
					<p>
						{administrator
							? "治理、请求与执行元数据可关联查询；不包含会话正文、凭证值或模型内部思考。"
							: "审计范围绑定当前登录用户；长标识可展开查看。"}
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
					<RotateCcw aria-hidden="true" />
				</Button>
			</div>
			{admin && (
				<nav className="tabs" aria-label="审计范围">
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
				className="audit-filters border-y py-5"
				aria-label="审计查询条件"
			>
				<div>
					<Label htmlFor={fieldId("from")}>起始时间</Label>
					<Input id={fieldId("from")} name="from" type="datetime-local" />
				</div>
				<div>
					<Label htmlFor={fieldId("until")}>结束时间</Label>
					<Input id={fieldId("until")} name="until" type="datetime-local" />
				</div>
				<div>
					<Label htmlFor={fieldId("principalKind")}>主体类型</Label>
					{administrator ? (
						<NativeSelect id={fieldId("principalKind")} name="principalKind">
							<NativeSelectOption value="">全部类型</NativeSelectOption>
							<NativeSelectOption value="user">用户</NativeSelectOption>
							<NativeSelectOption value="application">应用</NativeSelectOption>
						</NativeSelect>
					) : (
						<Input id={fieldId("principalKind")} value="用户" readOnly />
					)}
				</div>
				<div>
					<Label htmlFor={fieldId("principalId")}>主体 ID</Label>
					<Input
						id={fieldId("principalId")}
						name={administrator ? "principalId" : undefined}
						defaultValue={administrator ? "" : session.user.userId}
						readOnly={!administrator}
						maxLength={128}
					/>
				</div>
				<div>
					<Label htmlFor={fieldId("agentId")}>Agent ID</Label>
					<Input id={fieldId("agentId")} name="agentId" maxLength={128} />
				</div>
				<div>
					<Label htmlFor={fieldId("action")}>动作</Label>
					<NativeSelect id={fieldId("action")} name="action">
						<NativeSelectOption value="">全部动作</NativeSelectOption>
						{Object.entries(auditActionLabels).map(([value, label]) => (
							<NativeSelectOption key={value} value={value}>
								{label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<div>
					<Label htmlFor={fieldId("result")}>结果</Label>
					<NativeSelect id={fieldId("result")} name="result">
						<NativeSelectOption value="">全部结果</NativeSelectOption>
						{Object.entries(auditResultLabels).map(([value, label]) => (
							<NativeSelectOption key={value} value={value}>
								{label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<div>
					<Label htmlFor={fieldId("executionId")}>Execution ID</Label>
					<Input
						id={fieldId("executionId")}
						name="executionId"
						maxLength={128}
					/>
				</div>
				{formFailure && (
					<Alert className="col-span-full" variant="destructive">
						<AlertDescription>{formFailure}</AlertDescription>
					</Alert>
				)}
				<div className="col-span-full flex flex-wrap justify-end gap-2">
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
			</form>
			<section className="py-5" aria-label="审计记录" aria-busy={busy}>
				<div className="mb-4 flex flex-wrap items-start justify-between gap-3">
					<div>
						{administrator && (
							<p className="mb-1 text-muted-foreground text-sm">事件时间线</p>
						)}
						<h2 className="font-semibold text-base">
							{administrator ? "平台操作记录" : "审计记录"}
						</h2>
					</div>
					{administrator && (
						<p className="text-muted-foreground text-sm">
							不包含会话正文、凭证值或模型内部思考
						</p>
					)}
				</div>
				{denied ? (
					<Alert variant="destructive">
						<AlertDescription>
							当前无权访问审计记录，权限或会话可能已变化。
						</AlertDescription>
					</Alert>
				) : query.status === "error" ? (
					<Alert variant="destructive">
						<AlertDescription>
							审计查询失败，请稍后重试。
							{query.canRetry && (
								<Button variant="outline" onClick={() => void query.retry()}>
									重试
								</Button>
							)}
						</AlertDescription>
					</Alert>
				) : busy ? (
					<p role="status" className="py-8 text-muted-foreground">
						正在读取审计记录…
					</p>
				) : !formFailure && items.length === 0 ? (
					<Empty>
						<EmptyDescription>暂无审计记录</EmptyDescription>
					</Empty>
				) : (
					!formFailure && (
						<Table className="audit-table">
							<TableHeader>
								<TableRow>
									<TableHead>时间</TableHead>
									<TableHead>事件</TableHead>
									<TableHead>对象</TableHead>
									<TableHead>操作主体</TableHead>
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
											<time dateTime={record.occurredAt}>
												{auditTimestamp(record.occurredAt)}
											</time>
										</TableCell>
										<TableCell data-label="事件">
											<strong className="font-medium">
												{auditActionLabels[record.action]}
											</strong>
											<small className="mt-1 block">{record.summary}</small>
											<small className="mt-1 block break-all text-muted-foreground">
												{record.action}
											</small>
										</TableCell>
										<TableCell data-label="对象">
											<span>{auditSubjectLabels[record.subject.kind]}</span>
											<small className="mt-1 block break-all">
												{record.subject.subjectId}
											</small>
											<small className="mt-1 block break-all text-muted-foreground">
												Agent：{record.agentId ?? "未提供"}
											</small>
											<small className="mt-1 block break-all text-muted-foreground">
												Execution：{record.executionId ?? "未提供"}
											</small>
										</TableCell>
										<TableCell data-label="操作主体">
											<span>
												可信操作主体 · {auditPrincipalLabels[record.actor.kind]}
											</span>
											<small className="mt-1 block break-all">
												{record.actor.actorId}
											</small>
											{record.originalPrincipal && (
												<small className="mt-1 block break-all text-muted-foreground">
													原发起主体 ·{" "}
													{auditPrincipalLabels[record.originalPrincipal.kind]}
													：{record.originalPrincipal.id}
												</small>
											)}
										</TableCell>
										<TableCell data-label="结果">
											<Badge variant="outline" data-result={record.result}>
												{auditOutcomeLabel(record)}
											</Badge>
										</TableCell>
										<TableCell data-label="详情">
											<Button
												size="icon"
												variant="ghost"
												aria-label="查看审计详情"
												title="查看审计详情"
												aria-expanded={auditId === record.auditId}
												aria-controls={fieldId("detail")}
												onClick={(event) => {
													detailTrigger.current = event.currentTarget;
													setAuditId(record.auditId);
												}}
											>
												<Eye aria-hidden="true" />
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
							<h2>审计详情</h2>
						</div>
						<Button
							variant="ghost"
							onClick={closeDetail}
							aria-label="关闭审计详情"
						>
							关闭
						</Button>
					</header>
					{query.failure || query.detailStatus === "denied" ? (
						<Alert variant="destructive">
							<AlertDescription>
								{denied || query.detailStatus === "denied"
									? "当前无权访问审计详情，资源或权限可能已变化。"
									: "审计查询失败，请稍后重试。"}
							</AlertDescription>
						</Alert>
					) : query.detailStatus === "error" ? (
						<Alert variant="destructive">
							<AlertDescription>
								审计详情读取失败，请稍后重试。
								<Button
									variant="outline"
									onClick={() => void query.retryDetail()}
								>
									重试详情
								</Button>
							</AlertDescription>
						</Alert>
					) : query.detailStatus === "loading" ||
						query.isDetailFetching ||
						busy ? (
						<p role="status">正在读取审计详情…</p>
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
									<RotateCcw aria-hidden="true" />
								</Button>
							</div>
							<AuditRecordDetail record={query.detail} />
						</>
					) : null}
				</section>
			)}
			{administrator && (
				<Alert className="mt-5">
					<AlertDescription className="space-y-1">
						<strong>最小审计数据</strong>
						<p>
							记录谁在何时对哪个对象做了什么及其结果，不保存对话正文、凭证值或模型内部思考。
							Connection 授权与外部效果由独立 Connection
							审计核实，关联引用不授予查询权限。
						</p>
					</AlertDescription>
				</Alert>
			)}
		</>
	);
}
