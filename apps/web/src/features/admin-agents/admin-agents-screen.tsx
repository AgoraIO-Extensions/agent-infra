import { RefreshCw } from "lucide-react";
import { useId, useRef, useState } from "react";
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

export function AdminAgentsScreen({
	state,
	filters,
	onFiltersChange,
	onRefresh,
	refreshing = false,
	templateName,
}: {
	state: AdminAgentsState;
	filters: AdminAgentFilters;
	onFiltersChange: (filters: AdminAgentFilters) => void;
	onRefresh: () => void;
	refreshing?: boolean;
	/** 模板显示名（部署配置）；未提供或读不到时显示「标准模板」（F-02）。 */
	templateName?: TemplateNameLookup;
}) {
	const id = useId();
	const toast = useToast();
	const [actionFailure, setActionFailure] = useState<string | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
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
						<Button
							variant="ghost"
							size="icon"
							aria-label="刷新 Agent 列表"
							title="刷新 Agent 列表"
							disabled={refreshing || state.kind === "loading"}
							onClick={onRefresh}
						>
							<RefreshCw aria-hidden="true" />
						</Button>
					</div>
				)}
			</header>
			{denied ? (
				<Alert tone="warn">
					<AlertDescription>当前无权访问 Agent 管理。</AlertDescription>
				</Alert>
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
								<Button variant="outline" onClick={() => onFiltersChange({})}>
									清除筛选
								</Button>
							</EmptyContent>
						</Empty>
					) : (
						<>
							<Table
								className="admin-agent-table"
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
								className="admin-agent-pagination"
								aria-label="Agent 列表分页"
							>
								<Button
									variant="outline"
									disabled={page <= 1}
									onClick={() =>
										onFiltersChange({ ...filters, page: page - 1 })
									}
								>
									上一页
								</Button>
								<span>
									第 {page} / {pageCount} 页
								</span>
								<Button
									variant="outline"
									disabled={page >= pageCount}
									onClick={() =>
										onFiltersChange({ ...filters, page: page + 1 })
									}
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
