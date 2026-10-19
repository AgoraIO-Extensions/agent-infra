import { RefreshCw } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LoadingLine } from "@/components/ui/spinner";
import { Timestamp } from "@/components/ui/timestamp";
import type { ChipTone } from "@/lib/status-tone";
import { PageStateCard } from "../page-state-card.js";

export type OperationsStatus =
	| "unknown"
	| "unavailable"
	| "healthy"
	| "degraded";

export type OperationsDomain = "health" | "agents" | "dependencies" | "alerts";

/** Platform API 观测采集与导出的计数，来自正式观测查询，不做推算。 */
export type OperationsCollection = {
	readonly captureFailures: number;
	readonly exportFailures: number;
	readonly droppedLogs: number;
	readonly invalidRecords: number;
	readonly lastExportFailureAt?: string;
};

export type OperationsEntryState =
	| { readonly kind: "loading" }
	/** 服务端拒绝（403）；会话没有 system_admin 时页面不发出查询，同样显示无权限卡。 */
	| { readonly kind: "denied" }
	/** 部署没有提供观测查询入口（404）。 */
	| { readonly kind: "not-connected" }
	| { readonly kind: "unavailable"; readonly message: string }
	| {
			readonly kind: "ready";
			readonly statuses: Readonly<Record<OperationsDomain, OperationsStatus>>;
			readonly collection: OperationsCollection;
	  };

// 页面结构与状态见 docs/development/web-ui.md「运维观测页」（F-12）。
const domains: ReadonlyArray<{
	key: OperationsDomain;
	title: string;
	coverage: string;
}> = [
	{
		key: "health",
		title: "平台健康",
		coverage: "服务健康、错误与延迟、流式连接",
	},
	{
		key: "agents",
		title: "Agent 与任务",
		coverage: "Agent 可用性与启动、任务积压",
	},
	{
		key: "dependencies",
		title: "依赖",
		coverage: "PostgreSQL、outbox 投递、对象存储与 Runtime 依赖",
	},
	{
		key: "alerts",
		title: "告警",
		coverage: "服务不可用、持续积压与异常错误",
	},
];

const statusChips: Record<OperationsStatus, { label: string; tone: ChipTone }> =
	{
		unknown: { label: "未接入", tone: "gray" },
		healthy: { label: "正常", tone: "green" },
		degraded: { label: "降级", tone: "amber" },
		unavailable: { label: "不可用", tone: "red" },
	};

function Fact({ term, children }: { term: string; children: ReactNode }) {
	return (
		<>
			<dt>{term}</dt>
			<dd>{children}</dd>
		</>
	);
}

/** 告警区块：告警出口尚未接入；观测采集计数是正式查询返回的独立健康信号。 */
function CollectionFacts({
	collection,
	degraded,
}: {
	collection: OperationsCollection;
	degraded: boolean;
}) {
	return (
		<>
			<Fact term="告警出口">未接入</Fact>
			<Fact term="观测采集">
				{degraded ? "Platform API · 有失败" : "Platform API · 正常"}
			</Fact>
			<Fact term="采集失败">{collection.captureFailures} 次</Fact>
			<Fact term="导出失败">{collection.exportFailures} 次</Fact>
			<Fact term="丢弃日志">{collection.droppedLogs} 条</Fact>
			<Fact term="无效记录">{collection.invalidRecords} 条</Fact>
			<Fact term="最近导出失败">
				{collection.lastExportFailureAt ? (
					<Timestamp value={collection.lastExportFailureAt} />
				) : (
					"无"
				)}
			</Fact>
		</>
	);
}

function DomainCard({
	domain,
	status,
	collection,
}: {
	domain: (typeof domains)[number];
	status: OperationsStatus;
	collection: OperationsCollection;
}) {
	const id = useId();
	const chip = statusChips[status];
	return (
		<Card
			render={<section aria-labelledby={`${id}-title`} />}
			className="operations-domain"
			data-domain={domain.key}
		>
			<div className="operations-domain-head">
				<h2 id={`${id}-title`}>{domain.title}</h2>
				<Badge tone={chip.tone}>{chip.label}</Badge>
			</div>
			<dl className="review-facts">
				<Fact term="覆盖">{domain.coverage}</Fact>
				{domain.key === "alerts" ? (
					<CollectionFacts
						collection={collection}
						degraded={status === "degraded"}
					/>
				) : (
					<Fact term="数据来源">
						{status === "unknown" ? "未接入" : "正式观测查询"}
					</Fact>
				)}
			</dl>
		</Card>
	);
}

function OperationsBody({
	state,
	onRefresh,
	isRefreshing,
}: {
	state: OperationsEntryState;
	onRefresh: () => void;
	isRefreshing: boolean;
}) {
	switch (state.kind) {
		case "loading":
			return <LoadingLine>正在读取观测状态…</LoadingLine>;
		case "denied":
			return (
				<PageStateCard
					kind="unauthorized"
					description="你没有访问运维观测的权限。"
				/>
			);
		case "not-connected":
			return (
				<PageStateCard
					kind="unavailable"
					title="观测查询未接入"
					description="当前部署没有提供运维观测查询，页面不显示指标或告警。"
					action={null}
				/>
			);
		case "unavailable":
			return (
				<PageStateCard
					kind="unavailable"
					description={state.message}
					onRetry={onRefresh}
					retrying={isRefreshing}
					retryLabel="重新读取观测状态"
				/>
			);
		case "ready":
			return (
				<div className="operations-grid">
					{domains.map((domain) => (
						<DomainCard
							key={domain.key}
							domain={domain}
							status={state.statuses[domain.key]}
							collection={state.collection}
						/>
					))}
				</div>
			);
	}
}

export function OperationsEntry({
	isAdministrator,
	onRefresh,
	state,
	isRefreshing = false,
}: {
	/** 会话角色由服务端解析；非系统管理员直接显示无权限卡，调用方不发出查询。 */
	isAdministrator: boolean;
	onRefresh: () => void;
	state: OperationsEntryState;
	isRefreshing?: boolean;
}) {
	const id = useId();
	const shown: OperationsEntryState = isAdministrator
		? state
		: { kind: "denied" };
	// 刷新只在读取中与已读取时出现；失败卡自带重试，无权限与未接入没有可刷新的内容。
	const refreshable = shown.kind === "loading" || shown.kind === "ready";
	return (
		<section aria-labelledby={`${id}-heading`}>
			<header className="page-heading">
				<div className="min-w-0">
					<p className="page-eyebrow">系统管理 / 运维观测</p>
					{/* tabIndex=-1：失败卡「重新读取」恢复后焦点移到这里。 */}
					<h1 id={`${id}-heading`} tabIndex={-1}>
						先确认平台状态，再定位故障。
					</h1>
					<p>
						只显示正式观测查询返回的状态；没有数据源的区块标为「未接入」，页面不生成指标或告警。
					</p>
				</div>
				{refreshable ? (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label="刷新运维状态"
						title="刷新运维状态"
						disabled={isRefreshing || shown.kind === "loading"}
						onClick={onRefresh}
					>
						<RefreshCw aria-hidden="true" />
					</Button>
				) : null}
			</header>
			<OperationsBody
				state={shown}
				onRefresh={onRefresh}
				isRefreshing={isRefreshing}
			/>
		</section>
	);
}
