import { LogIn, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription } from "@/components/ui/empty";
import { Field } from "@/components/ui/field";
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
import { useToast } from "@/components/ui/toast";
import { statusTone } from "@/lib/status-tone";
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import {
	agentManagementStatusLabels,
	agentServiceAvailabilityLabel,
} from "../agent-management-status.js";
import {
	AvailabilityNameList,
	DirectoryReadAlert,
	formatPerson,
	useAvailabilityNames,
} from "../directory-names.js";
import { PageStateCard } from "../page-state-card.js";
import { RecoveryButton } from "../recovery-button.js";
import {
	type TemplateNameLookup,
	templateDisplayName,
} from "../template-display-name.js";
import { AdminAgentRowActions } from "./admin-agent-row-actions.js";
import type { AdminAgentsState } from "./admin-agents.js";
import { AdminUserGovernance } from "./admin-user-governance.js";
import { ApplicationMaterialGovernance } from "./application-material-governance.js";

export const adminAgentStatuses = [
	"creating",
	"available",
	"stopped",
	"creation_failed",
	"disabled",
] as const;
export const adminAgentSources = ["standard", "custom"] as const;
export type AdminAgentFilters = {
	q?: string;
	status?: (typeof adminAgentStatuses)[number];
	source?: (typeof adminAgentSources)[number];
	page?: number;
};
export const adminAgentQueryMaxLength = 256;
const pageSize = 10;
// 设计 #admin-agents：来源筛选为「全部来源 / 标准模板 / 自定义镜像」。
const sourceFilterLabels = {
	standard: "标准模板",
	custom: "自定义镜像",
} as const satisfies Record<(typeof adminAgentSources)[number], string>;

export function validateAdminAgentSearch(
	search: Record<string, unknown>,
): AdminAgentFilters {
	const page =
		typeof search.page === "number" || typeof search.page === "string"
			? Number(search.page)
			: Number.NaN;
	return {
		q:
			typeof search.q === "string" &&
			search.q.length <= adminAgentQueryMaxLength
				? search.q
				: undefined,
		status: adminAgentStatuses.find((status) => status === search.status),
		source: adminAgentSources.find((source) => source === search.source),
		page:
			Number.isInteger(page) && page >= 1 && page <= 1000 ? page : undefined,
	};
}

function sourceLabel(
	agent: AgentProjectionV2,
	templateName?: TemplateNameLookup,
) {
	// 设计 #admin-agents 的来源单元格：标准模板只写模板显示名（「Codex」），读不到时为
	// 「标准模板」（F-02）；自定义来源写「自定义镜像」。
	return agent.source.kind === "standard"
		? templateDisplayName(agent.source.templateId, templateName)
		: sourceFilterLabels.custom;
}

// 与 Agent 详情一致：有服务可用性时显示服务可用性，否则显示管理状态，只出一个 chip。
function AgentStatusChip({ agent }: { agent: AgentProjectionV2 }) {
	return (
		<Badge
			tone={statusTone(agent.serviceAvailability ?? agent.managementStatus)}
		>
			{agent.serviceAvailability
				? agentServiceAvailabilityLabel(agent.serviceAvailability)
				: agentManagementStatusLabels[agent.managementStatus]}
		</Badge>
	);
}

function ownerNames(agent: AgentProjectionV2) {
	return agent.configuration.owners
		.map((owner) => formatPerson({ displayName: owner.displayName }).name)
		.join("、");
}

const columns = ["Agent", "Owner", "来源", "状态", "可用范围"] as const;

/**
 * 翻页后把新的一页滚入视口（#3292 N9-3-02）：表格到分页条放得下时整段可见，放不下时让表格顶端
 * 贴着吸顶顶栏（`.action-reveal` 的 scroll-margin），不让新数据停在视口上方。
 */
function revealPage(table: HTMLElement | null, pagination: HTMLElement | null) {
	if (!table || !pagination) return;
	const visibleTop = Number.parseFloat(getComputedStyle(table).scrollMarginTop);
	const visibleBottom =
		window.innerHeight -
		Number.parseFloat(getComputedStyle(pagination).scrollMarginBottom);
	const top = table.getBoundingClientRect().top;
	const bottom = pagination.getBoundingClientRect().bottom;
	if (top < visibleTop || bottom - top > visibleBottom - visibleTop)
		table.scrollIntoView?.({ block: "start" });
	else if (bottom > visibleBottom)
		pagination.scrollIntoView?.({ block: "end" });
}

export function AdminAgentsScreen({
	state,
	filters,
	onFiltersChange,
	onRefresh,
	onRelogin,
	refreshing = false,
	templateName,
}: {
	state: AdminAgentsState;
	filters: AdminAgentFilters;
	onFiltersChange: (filters: AdminAgentFilters) => void;
	onRefresh: () => void;
	/** 列表读取 401 时的「重新登录」：经壳层确认会话，仍有效时重读列表（W-03）。 */
	onRelogin?: () => void;
	refreshing?: boolean;
	/** 模板显示名（部署配置）；未提供或读不到时显示「标准模板」（F-02）。 */
	templateName?: TemplateNameLookup;
}) {
	const id = useId();
	const toast = useToast();
	const [actionFailure, setActionFailure] = useState<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const tableRef = useRef<HTMLTableElement>(null);
	const paginationRef = useRef<HTMLElement>(null);
	const previousPageButton = useRef<HTMLButtonElement>(null);
	const nextPageButton = useRef<HTMLButtonElement>(null);
	const pageTrigger = useRef<"previous" | "next" | null>(null);
	const agents = state.kind === "ready" ? state.agents : [];
	const search = (filters.q ?? "").trim().toLocaleLowerCase();
	// 只匹配页面上可见的文字：名称、说明、来源文案与 Owner 显示名。
	const matches = agents.filter(
		(agent) =>
			(!filters.status || filters.status === agent.managementStatus) &&
			(!filters.source || filters.source === agent.source.kind) &&
			`${agent.name}\n${agent.description}\n${sourceLabel(agent, templateName)}\n${ownerNames(agent)}`
				.toLocaleLowerCase()
				.includes(search),
	);
	const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
	const page = Math.min(filters.page ?? 1, pageCount);
	const rows = matches.slice((page - 1) * pageSize, page * pageSize);
	// 前端分页（#3292 N9-3-02）：翻到首页或末页、触发的按钮随之禁用时焦点交给另一个分页按钮
	// （同 /audit），两个都不可用时到页面 h1，不落到 body；随后把新的一页滚入视口。
	const shownPage = useRef(page);
	useEffect(() => {
		if (shownPage.current === page) return;
		shownPage.current = page;
		const trigger = pageTrigger.current;
		if (!trigger) return;
		pageTrigger.current = null;
		const own = (trigger === "previous" ? previousPageButton : nextPageButton)
			.current;
		const other = (trigger === "previous" ? nextPageButton : previousPageButton)
			.current;
		const active = document.activeElement;
		if (!active || active === document.body || active === own) {
			if (own?.disabled !== false) {
				if (other && !other.disabled) other.focus({ preventScroll: true });
				else heading.current?.focus({ preventScroll: true });
			}
		}
		revealPage(tableRef.current, paginationRef.current);
	}, [page]);
	// 当前页的可用范围合并为员工、组织各一次目录读取。
	const names = useAvailabilityNames(
		rows.flatMap((agent) => agent.configuration.availability),
	);
	const filtered = Boolean(search || filters.status || filters.source);
	const denied = state.kind === "denied";
	const failed = state.kind === "error";
	return (
		<section aria-labelledby={`${id}-heading`}>
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">系统管理 / Agent 管理</p>
					<h1 id={`${id}-heading`} ref={heading} tabIndex={-1}>
						查看 Agent 状态
					</h1>
					<p>系统管理员可以停用 Agent、替换 Owner 或重试创建；不支持删除。</p>
				</div>
				{denied || failed ? null : (
					<div className="tag-row admin-agent-heading-tools">
						{state.kind === "ready" ? (
							<Badge tone="gray">{agents.length} 个 Agent</Badge>
						) : null}
						{/* 读取中保持可聚焦（aria-disabled），焦点留在按钮上；读取失败、页头工具随之
						    收起时焦点移到 h1，不落到 body（D2-59）。 */}
						<RecoveryButton
							variant="ghost"
							size="icon"
							recoveryKey="刷新 Agent 列表"
							aria-label="刷新 Agent 列表"
							title="刷新 Agent 列表"
							busy={refreshing || state.kind === "loading"}
							onClick={onRefresh}
						>
							<RefreshCw aria-hidden="true" />
						</RecoveryButton>
					</div>
				)}
			</header>
			{denied ? (
				state.reason === "authentication-required" ? (
					// 读取 401：与 Agent 目录相同的「登录已过期」卡，「重新登录」确认会话仍有效后重读列表
					// （#3292 N9-3-04、W-03），不说成无权访问。
					<PageStateCard
						kind="login"
						title="登录已过期"
						action={
							onRelogin ? (
								<RecoveryButton
									recoveryKey="重新登录"
									busy={refreshing}
									onClick={onRelogin}
								>
									<LogIn aria-hidden="true" data-icon="inline-start" />
									重新登录
								</RecoveryButton>
							) : null
						}
					/>
				) : (
					// 员工或被服务端拒绝：页头之下只有公共「未授权」卡与「返回工作台」，与其余系统管理页
					// 相同；静态边界不设 live region（#3292 N9-3-01）。
					<PageStateCard
						kind="unauthorized"
						description="当前无权访问 Agent 管理。"
					/>
				)
			) : failed ? (
				// N-20：列表读取失败时只保留标题与一条失败提示，筛选、表格与治理区都收起。
				<Alert tone="danger" role="alert">
					<AlertDescription>
						{state.retryable
							? "暂时无法读取 Agent 列表，请稍后重试。"
							: "暂时无法访问此列表，请联系管理员。"}
					</AlertDescription>
					{state.retryable ? (
						<AlertAction>
							<RecoveryButton
								variant="outline"
								recoveryKey="重新加载"
								busy={refreshing}
								onClick={onRefresh}
							>
								重新加载
							</RecoveryButton>
						</AlertAction>
					) : null}
				</Alert>
			) : (
				<>
					<div className="admin-agent-filters">
						<SearchInput
							ref={searchRef}
							label="搜索 Agent"
							id={`${id}-search`}
							maxLength={adminAgentQueryMaxLength}
							value={filters.q ?? ""}
							placeholder="搜索 Agent、Owner 或来源"
							onChange={(event) =>
								onFiltersChange({
									...filters,
									q: event.target.value || undefined,
									page: undefined,
								})
							}
						/>
						<Field>
							<Label htmlFor={`${id}-status`}>运行状态</Label>
							<NativeSelect
								id={`${id}-status`}
								value={filters.status ?? "all"}
								onChange={(event) =>
									onFiltersChange({
										...filters,
										status: adminAgentStatuses.find(
											(value) => value === event.target.value,
										),
										page: undefined,
									})
								}
							>
								<NativeSelectOption value="all">全部状态</NativeSelectOption>
								{adminAgentStatuses.map((status) => (
									<NativeSelectOption key={status} value={status}>
										{agentManagementStatusLabels[status]}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
						<Field>
							<Label htmlFor={`${id}-source`}>来源</Label>
							<NativeSelect
								id={`${id}-source`}
								value={filters.source ?? "all"}
								onChange={(event) =>
									onFiltersChange({
										...filters,
										source: adminAgentSources.find(
											(value) => value === event.target.value,
										),
										page: undefined,
									})
								}
							>
								<NativeSelectOption value="all">全部来源</NativeSelectOption>
								{adminAgentSources.map((source) => (
									<NativeSelectOption key={source} value={source}>
										{sourceFilterLabels[source]}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
					</div>
					{/* 筛选结果只给读屏播报；总数在页头 chip。 */}
					<p className="sr-only" role="status" aria-live="polite">
						{state.kind === "ready" && filtered
							? `匹配 ${matches.length} 个`
							: ""}
					</p>
					{actionFailure ? (
						<Alert tone="danger" role="alert" className="mb-4">
							<AlertDescription>{actionFailure}</AlertDescription>
						</Alert>
					) : null}
					{state.kind === "ready" ? (
						<DirectoryReadAlert names={[names]} className="mb-4" />
					) : null}
					{state.kind === "loading" ? (
						<LoadingLine className="py-8">正在加载 Agent…</LoadingLine>
					) : !agents.length ? (
						<Empty>
							<EmptyDescription>暂无已创建的 Agent。</EmptyDescription>
						</Empty>
					) : !matches.length ? (
						<Empty>
							<EmptyDescription>未找到匹配的 Agent。</EmptyDescription>
							<EmptyContent>
								{/* 清除后空态随之卸载：焦点回到搜索框（同 Skill Hub，#3269 N8-3-02）。 */}
								<Button
									variant="outline"
									onClick={() => {
										searchRef.current?.focus();
										onFiltersChange({});
									}}
								>
									清除筛选
								</Button>
							</EmptyContent>
						</Empty>
					) : (
						<>
							<Table
								ref={tableRef}
								className="admin-agent-table action-reveal"
								mobileLayout="cards"
								aria-label="已创建 Agent"
							>
								<TableHeader>
									<TableRow>
										{columns.map((label) => (
											<TableHead key={label} scope="col">
												{label}
											</TableHead>
										))}
										<TableHead scope="col">
											<span className="sr-only">操作</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((agent) => (
										<TableRow key={agent.agentId}>
											<TableCell data-label="Agent">
												<strong>{agent.name}</strong>
												<small>{agent.description}</small>
											</TableCell>
											<TableCell data-label="Owner">
												{ownerNames(agent) || "未提供"}
											</TableCell>
											<TableCell data-label="来源">
												{sourceLabel(agent, templateName)}
											</TableCell>
											<TableCell data-label="状态">
												<AgentStatusChip agent={agent} />
											</TableCell>
											<TableCell data-label="可用范围">
												<AvailabilityNameList
													targets={agent.configuration.availability}
													names={names}
													identifier
													empty="未额外指定"
												/>
											</TableCell>
											<TableCell data-cell="actions">
												<AdminAgentRowActions
													agent={agent}
													onActionStart={() => setActionFailure(null)}
													onRetryAccepted={() => {
														toast("已提交重试，创建状态会在后台更新");
														onRefresh();
													}}
													onDisableAccepted={() => {
														// 该行重新读取后只剩「—」，焦点交给页面标题，不落到 body。
														heading.current?.focus();
														toast("已提交停用请求");
														onRefresh();
													}}
													onActionFailed={(_agent, error) =>
														setActionFailure(
															error.retryable === false
																? "权限或 Agent 状态已变化，请刷新页面。"
																: "操作未能提交，请稍后重试。",
														)
													}
												/>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
							<nav
								ref={paginationRef}
								className="admin-agent-pagination action-reveal"
								aria-label="Agent 列表分页"
							>
								<Button
									ref={previousPageButton}
									variant="outline"
									disabled={page <= 1}
									onClick={() => {
										pageTrigger.current = "previous";
										onFiltersChange({ ...filters, page: page - 1 });
									}}
								>
									上一页
								</Button>
								<span>
									第 {page} / {pageCount} 页
								</span>
								<Button
									ref={nextPageButton}
									variant="outline"
									disabled={page >= pageCount}
									onClick={() => {
										pageTrigger.current = "next";
										onFiltersChange({ ...filters, page: page + 1 });
									}}
								>
									下一页
								</Button>
							</nav>
						</>
					)}
					{/* 治理区不依赖 Agent 列表，放在列表之后；h2 由 FormSection 固定为正文字体 16px。 */}
					<div className="admin-agent-governance">
						<AdminUserGovernance />
						<ApplicationMaterialGovernance />
					</div>
				</>
			)}
		</section>
	);
}
