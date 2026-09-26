import type {
	AuditCall,
	AuditDetail,
	ListAuditCallsData,
} from "@agent-infra/connection-contracts";
import { useQuery } from "@tanstack/react-query";
import {
	ArrowDownLeft,
	ArrowUpRight,
	ChevronLeft,
	ChevronRight,
	RefreshCw,
	Search,
} from "lucide-react";
import { useState } from "react";
import { connectionApi } from "../api";
import { ConsoleShell, PageError } from "../shell";
import { PageHeader } from "../views";
import "./action-calls.css";

type Query = NonNullable<ListAuditCallsData["query"]>;
const statuses: Record<AuditCall["status"], string> = {
	AUTHORIZED: "已授权",
	DENIED_LOCAL: "本地拒绝",
	SUCCEEDED: "成功",
	FAILED: "失败",
	UNCERTAIN: "结果未知",
};
const actionNames: Record<string, string> = {
	create_issue: "创建工单",
	get_issue: "读取工单",
	search_issues: "搜索工单",
	update_issue: "更新工单",
	delete_issue: "删除工单",
	add_comment: "添加评论",
	list_pull_requests: "查询合并请求",
	create_pull_request: "创建合并请求",
	get_pull_request: "读取合并请求",
	get_page: "读取文档",
	create_page: "创建文档",
	update_page: "更新文档",
	get_current_user: "查询当前账号",
	list_projects: "查询项目",
};
const actionLabel = (action: string) =>
	actionNames[action.split(".").at(-1) ?? ""] ?? action;
const dateTime = (value: string) =>
	new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date(value));
export function auditTimeRange(
	period: string,
	start: string,
	end: string,
	now = new Date(),
): { from: string; to: string } | undefined {
	let from: number;
	let to: number;
	if (period === "custom") {
		from = Date.parse(`${start}:00+08:00`);
		to = Date.parse(`${end}:00+08:00`) + 60_000;
	} else {
		const today = new Date(now.getTime() + 8 * 3_600_000)
			.toISOString()
			.slice(0, 10);
		const midnight = Date.parse(`${today}T00:00:00+08:00`);
		from =
			midnight - (period === "7d" ? 6 : period === "30d" ? 29 : 0) * 86_400_000;
		to = midnight + 86_400_000;
	}
	if (
		!Number.isFinite(from) ||
		!Number.isFinite(to) ||
		from >= to ||
		to - from > 93 * 86_400_000
	)
		return undefined;
	return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
function Status({ status }: { status: AuditCall["status"] }) {
	return (
		<span className={`audit-status audit-${status.toLowerCase()}`}>
			{statuses[status]}
		</span>
	);
}
function Payload({
	title,
	fields,
}: {
	title: string;
	fields: AuditDetail["input"];
}) {
	return (
		<section className="audit-payload">
			<h3>
				{title === "操作输入" ? (
					<ArrowUpRight size={16} />
				) : (
					<ArrowDownLeft size={16} />
				)}
				{title}
				<span>受控摘要</span>
			</h3>
			{fields.length ? (
				<dl>
					{fields.map((field, index) => (
						<div key={`${field.label}-${index}`}>
							<dt>{field.label}</dt>
							<dd>{field.value}</dd>
						</div>
					))}
				</dl>
			) : (
				<p className="audit-muted">无可展示的摘要</p>
			)}
		</section>
	);
}
function CallDetails({ record }: { record: AuditDetail }) {
	return (
		<div className="audit-details">
			<div className="audit-detail-title">
				<h2>{actionLabel(record.action)}</h2>
				<Status status={record.status} />
			</div>
			<p className="audit-person">
				<strong>{record.person}</strong>
				<span>{record.email ?? "邮箱未记录"}</span>
			</p>
			<p className="audit-muted">
				{record.consumer} · {dateTime(record.createdAt)}
			</p>
			<Payload title="操作输入" fields={record.input} />
			<Payload title="操作输出" fields={record.output} />
			<section className="audit-section">
				<h3>身份与来源</h3>
				<dl>
					<div>
						<dt>Provider</dt>
						<dd>{record.providerId}</dd>
					</div>
					<div>
						<dt>用户原话</dt>
						<dd>未采集 · 由消费端管理</dd>
					</div>
					<div>
						<dt>AI 最终回答</dt>
						<dd>未采集 · 不等于操作输出</dd>
					</div>
					<div>
						<dt>失败原因 / 耗时</dt>
						<dd>未记录</dd>
					</div>
				</dl>
			</section>
			<section className="audit-section">
				<h3>已记录的执行事件</h3>
				{record.timeline.length ? (
					<ol className="audit-timeline">
						{record.timeline.map((event, index) => (
							<li key={`${event.occurredAt}-${index}`}>
								<span>
									{statuses[
										event.event.replace("CALL_", "") as AuditCall["status"]
									] ?? "调用事件"}
								</span>
								<time>{dateTime(event.occurredAt)}</time>
							</li>
						))}
					</ol>
				) : (
					<p className="audit-muted">未记录</p>
				)}
			</section>
			<details className="audit-technical">
				<summary>技术详情</summary>
				<dl>
					{[
						["Call ID", record.callId],
						["Action", record.action],
						["Action 版本", record.actionVersionId],
						["Principal", record.principalId],
						["Consumer", record.consumerId],
						["实例", record.instanceId],
						["Actor", record.actorKey ?? "未记录"],
						["Connection", record.connectionId],
					].map(([label, value]) => (
						<div key={label}>
							<dt>{label}</dt>
							<dd>{value}</dd>
						</div>
					))}
				</dl>
			</details>
		</div>
	);
}
export function ActionCallsPage() {
	const [period, setPeriod] = useState("today");
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState("");
	const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
	const [start, setStart] = useState(`${today}T00:00`);
	const [end, setEnd] = useState(`${today}T23:59`);
	const [invalid, setInvalid] = useState(false);
	const [query, setQuery] = useState<Query>(
		() => auditTimeRange("today", "", "") as Query,
	);
	const [cursors, setCursors] = useState<Array<string | undefined>>([
		undefined,
	]);
	const [selectedId, setSelectedId] = useState<string>();
	const list = useQuery({
		queryKey: ["audit-calls", query, cursors.at(-1)],
		queryFn: () =>
			connectionApi.listAuditCalls({ ...query, cursor: cursors.at(-1) }),
		retry: false,
	});
	const rows = list.isSuccess ? list.data.items : [];
	const selected = rows.find((row) => row.callId === selectedId) ?? rows[0];
	const detail = useQuery({
		queryKey: ["audit-call", selected?.callId],
		queryFn: () => connectionApi.getAuditCall(selected?.callId ?? ""),
		enabled: Boolean(selected) && list.isSuccess,
		retry: false,
	});
	function apply(reset = false) {
		const range = auditTimeRange(reset ? "today" : period, start, end);
		setInvalid(!range);
		if (!range) return;
		if (reset) {
			setPeriod("today");
			setSearch("");
			setStatus("");
			setStart(`${today}T00:00`);
			setEnd(`${today}T23:59`);
		}
		setQuery({
			...range,
			...(!reset && search.trim() ? { query: search.trim() } : {}),
			...(!reset && status ? { status: status as AuditCall["status"] } : {}),
		});
		setCursors([undefined]);
		setSelectedId(undefined);
	}
	return (
		<ConsoleShell>
			<div className="audit-page">
				<PageHeader title="操作记录" />
				<div className="audit-range-label">
					{dateTime(query.from)} 至{" "}
					{dateTime(new Date(Date.parse(query.to) - 1).toISOString())} ·
					UTC+08:00
				</div>
				<form
					className="audit-filters"
					onSubmit={(event) => {
						event.preventDefault();
						apply();
					}}
				>
					<label className="audit-search">
						<Search size={17} />
						<input
							type="search"
							aria-label="搜索操作"
							maxLength={120}
							placeholder="搜索姓名、邮箱、Action 或 Call ID"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
					</label>
					<select
						aria-label="时间范围"
						value={period}
						onChange={(event) => setPeriod(event.target.value)}
					>
						<option value="today">今天</option>
						<option value="7d">最近 7 天</option>
						<option value="30d">最近 30 天</option>
						<option value="custom">自定义时间</option>
					</select>
					<select
						aria-label="执行结果"
						value={status}
						onChange={(event) => setStatus(event.target.value)}
					>
						<option value="">全部结果</option>
						{Object.entries(statuses).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
					<button type="submit" className="button button-primary">
						<Search size={15} />
						查询
					</button>
					<button
						type="button"
						className="audit-icon"
						title="刷新当前查询"
						aria-label="刷新当前查询"
						onClick={() => {
							void list.refetch();
							if (selected) void detail.refetch();
						}}
					>
						<RefreshCw size={17} />
					</button>
					{period === "custom" && (
						<div className="audit-time-range">
							<label>
								开始时间
								<input
									type="datetime-local"
									aria-label="开始时间"
									value={start}
									onChange={(event) => setStart(event.target.value)}
									required
								/>
							</label>
							<label>
								结束时间
								<input
									type="datetime-local"
									aria-label="结束时间"
									value={end}
									onChange={(event) => setEnd(event.target.value)}
									required
								/>
							</label>
							<span>UTC+08:00 · 包含结束分钟 · 最多 93 天</span>
						</div>
					)}
				</form>
				{invalid && (
					<p role="alert" className="alert alert-error">
						请选择有效的起止时间，结束时间不能早于开始时间，范围最多 93 天。
					</p>
				)}
				{list.isError ? (
					<PageError error={list.error} />
				) : list.isPending ? (
					<p role="status">正在加载操作记录...</p>
				) : rows.length === 0 ? (
					<div className="audit-empty">
						<h2>没有符合条件的操作</h2>
						<button
							className="button button-secondary"
							type="button"
							onClick={() => apply(true)}
						>
							清除筛选
						</button>
					</div>
				) : (
					<>
						<div className="audit-split">
							<div className="audit-table-scroll">
								<table className="audit-table">
									<thead>
										<tr>
											<th>发起人 / 时间</th>
											<th>操作 / Provider</th>
											<th>结果</th>
										</tr>
									</thead>
									<tbody>
										{rows.map((row) => (
											<tr
												key={row.callId}
												className={
													selected?.callId === row.callId ? "selected" : ""
												}
											>
												<td>
													<strong>{row.person}</strong>
													<small>{dateTime(row.createdAt)}</small>
												</td>
												<td>
													<button
														type="button"
														onClick={() => setSelectedId(row.callId)}
														aria-pressed={selected?.callId === row.callId}
													>
														{actionLabel(row.action)}
													</button>
													<small>
														{row.providerId} · {row.consumer}
													</small>
												</td>
												<td>
													<Status status={row.status} />
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<aside className="audit-detail-pane" aria-label="调用详情">
								{detail.isError ? (
									<PageError error={detail.error} />
								) : detail.isPending ? (
									<p role="status">正在加载详情...</p>
								) : detail.data ? (
									<CallDetails record={detail.data} />
								) : null}
							</aside>
						</div>
						<div className="audit-pagination">
							<span>
								第 {cursors.length} 页 · 本页 {rows.length} 条
								{list.isFetching ? " · 更新中" : ""}
							</span>
							<button
								type="button"
								className="audit-icon"
								aria-label="上一页"
								title="上一页"
								disabled={cursors.length === 1}
								onClick={() => {
									setCursors(cursors.slice(0, -1));
									setSelectedId(undefined);
								}}
							>
								<ChevronLeft size={18} />
							</button>
							<button
								type="button"
								className="audit-icon"
								aria-label="下一页"
								title="下一页"
								disabled={!list.data?.nextCursor}
								onClick={() => {
									if (list.data?.nextCursor)
										setCursors([...cursors, list.data.nextCursor]);
									setSelectedId(undefined);
								}}
							>
								<ChevronRight size={18} />
							</button>
						</div>
					</>
				)}
			</div>
		</ConsoleShell>
	);
}
