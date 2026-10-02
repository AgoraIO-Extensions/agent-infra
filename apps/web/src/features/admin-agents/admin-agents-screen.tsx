import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useId } from "react";
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
import type { AgentProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import { agentServiceAvailabilityLabel } from "../agent-discovery/agent-discovery-screen.js";
import { agentManagementStatusLabels } from "../agent-management-status.js";
import type { AdminAgentsState } from "./admin-agents.js";

export const adminAgentStatuses = [
	"creating",
	"available",
	"stopped",
	"creation_failed",
	"disabled",
] as const;
export type AdminAgentFilters = {
	q?: string;
	status?: (typeof adminAgentStatuses)[number];
	page?: number;
};
export const adminAgentQueryMaxLength = 256;
const pageSize = 10;

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
		page:
			Number.isInteger(page) && page >= 1 && page <= 1000 ? page : undefined,
	};
}

function sourceLabel(agent: AgentProjectionV2) {
	return agent.source.kind === "standard"
		? `标准模板 · ${agent.source.templateId}`
		: `自定义镜像 · ${agent.source.imageReference}`;
}

export function AdminAgentsScreen({
	state,
	filters,
	onFiltersChange,
	onRefresh,
	refreshing = false,
}: {
	state: AdminAgentsState;
	filters: AdminAgentFilters;
	onFiltersChange: (filters: AdminAgentFilters) => void;
	onRefresh: () => void;
	refreshing?: boolean;
}) {
	const id = useId();
	const agents = state.kind === "ready" ? state.agents : [];
	const search = (filters.q ?? "").trim().toLocaleLowerCase();
	const matches = agents.filter(
		(agent) =>
			(!filters.status || filters.status === agent.managementStatus) &&
			`${agent.name}\n${agent.description}\n${sourceLabel(agent)}\n${agent.configuration.owners.map((owner) => `${owner.displayName}\n${owner.userId}`).join("\n")}`
				.toLocaleLowerCase()
				.includes(search),
	);
	const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
	const page = Math.min(filters.page ?? 1, pageCount);
	const rows = matches.slice((page - 1) * pageSize, page * pageSize);
	const denied = state.kind === "denied";
	return (
		<section aria-labelledby={`${id}-heading`}>
			<header className="page-heading">
				<div>
					<p className="page-eyebrow">系统管理 / Agent 管理</p>
					<h1 id={`${id}-heading`}>看清所有 Agent 的运行资格。</h1>
					<p>
						查看已创建 Agent 的来源、Owner
						和管理状态。创建申请请在“创建审批”中处理。
					</p>
				</div>
				{!denied && (
					<Link
						to="/admin/approvals"
						className={buttonVariants({ variant: "outline" })}
					>
						创建审批
					</Link>
				)}
			</header>
			{denied ? (
				<Alert>
					<AlertDescription>当前无权访问 Agent 管理。</AlertDescription>
				</Alert>
			) : (
				<>
					<div className="admin-agent-filters">
						<div className="space-y-2">
							<Label htmlFor={`${id}-status`}>产品状态</Label>
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
						</div>
						<div className="space-y-2">
							<Label htmlFor={`${id}-search`}>搜索 Agent 或 Owner</Label>
							<Input
								id={`${id}-search`}
								type="search"
								maxLength={adminAgentQueryMaxLength}
								value={filters.q ?? ""}
								placeholder="输入名称、说明、来源或 Owner 标识"
								onChange={(event) =>
									onFiltersChange({
										...filters,
										q: event.target.value || undefined,
										page: undefined,
									})
								}
							/>
						</div>
					</div>
					<div className="admin-agent-summary">
						<p role="status" aria-live="polite">
							{state.kind === "loading"
								? "正在加载 Agent…"
								: state.kind === "error"
									? "Agent 列表暂时无法读取。"
									: `${agents.length} 个已创建 Agent，匹配 ${matches.length} 个${refreshing ? "，正在刷新…" : ""}`}
						</p>
						<Button
							variant="outline"
							disabled={
								refreshing ||
								state.kind === "loading" ||
								(state.kind === "error" && !state.retryable)
							}
							onClick={onRefresh}
						>
							<RefreshCw aria-hidden="true" />
							{state.kind === "error" ? "重新加载" : "刷新列表"}
						</Button>
					</div>
					{state.kind === "error" ? (
						<Alert>
							<AlertDescription>
								{state.retryable
									? "请重试读取列表。"
									: "暂时无法访问此列表，请联系管理员。"}
							</AlertDescription>
						</Alert>
					) : state.kind === "ready" && !agents.length ? (
						<Empty>
							<EmptyDescription>暂无已创建的 Agent。</EmptyDescription>
						</Empty>
					) : state.kind === "ready" && !matches.length ? (
						<Empty>
							<EmptyDescription>未找到匹配的 Agent。</EmptyDescription>
							<Button variant="outline" onClick={() => onFiltersChange({})}>
								清除筛选
							</Button>
						</Empty>
					) : state.kind === "ready" ? (
						<>
							<Table className="admin-agent-table" aria-label="已创建 Agent">
								<TableHeader>
									<TableRow>
										{["Agent", "来源", "Owner", "状态", "系统操作"].map(
											(label) => (
												<TableHead key={label} scope="col">
													{label}
												</TableHead>
											),
										)}
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((agent) => (
										<TableRow key={agent.agentId}>
											<TableCell data-label="Agent">
												<div>
													<strong>{agent.name}</strong>
													<p className="mt-1 text-muted-foreground">
														{agent.description}
													</p>
												</div>
											</TableCell>
											<TableCell data-label="来源">
												{sourceLabel(agent)}
											</TableCell>
											<TableCell data-label="Owner">
												{agent.configuration.owners
													.map(
														(owner) => `${owner.displayName} (${owner.userId})`,
													)
													.join("、")}
											</TableCell>
											<TableCell data-label="状态">
												<div className="space-y-2">
													<Badge
														variant="outline"
														data-status={agent.managementStatus}
													>
														{
															agentManagementStatusLabels[
																agent.managementStatus
															]
														}
													</Badge>
													{agent.serviceAvailability !== null && (
														<p className="text-muted-foreground">
															服务：
															{agentServiceAvailabilityLabel(
																agent.serviceAvailability,
															)}
														</p>
													)}
												</div>
											</TableCell>
											<TableCell
												data-label="系统操作"
												aria-label="无可执行的系统操作"
											>
												<span aria-hidden="true">—</span>
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
					) : null}
				</>
			)}
		</section>
	);
}
