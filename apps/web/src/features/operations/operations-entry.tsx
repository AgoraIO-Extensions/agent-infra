import { Activity, BellRing, Database, RefreshCcw, Server } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";

export type OperationsStatus =
	| "unknown"
	| "unavailable"
	| "healthy"
	| "degraded";

export type OperationsDomain = "health" | "agents" | "delivery" | "alerts";

export type OperationsEntryState =
	| { readonly kind: "unknown" }
	| { readonly kind: "loading" }
	| { readonly kind: "empty" }
	| {
			readonly kind: "error";
			readonly message: string;
			readonly retryable?: boolean;
	  }
	| { readonly kind: "unavailable"; readonly message?: string }
	| {
			readonly kind: "ready";
			readonly statuses: Readonly<Record<OperationsDomain, OperationsStatus>>;
	  };

const domains: Array<{
	key: OperationsDomain;
	icon: typeof Activity;
	label: string;
	description: string;
}> = [
	{
		key: "health",
		icon: Activity,
		label: "服务健康与延迟",
		description: "API、SSE 和后台依赖的可用性与延迟。",
	},
	{
		key: "agents",
		icon: Server,
		label: "Agent 与任务",
		description: "Agent 启动、更新、不可用和任务积压。",
	},
	{
		key: "delivery",
		icon: Database,
		label: "数据与投递",
		description: "PostgreSQL、outbox 和投递重试状态。",
	},
	{
		key: "alerts",
		icon: BellRing,
		label: "告警与故障",
		description: "持续积压、服务不可用和异常错误。",
	},
];

function StatusBadge({ status }: { status: OperationsStatus }) {
	return (
		<Badge variant={status === "degraded" ? "destructive" : "outline"}>
			{status === "unknown"
				? "待接入"
				: status === "unavailable"
					? "不可用"
					: status === "healthy"
						? "正常"
						: "降级"}
		</Badge>
	);
}

function statusFor(state: OperationsEntryState, key: OperationsDomain) {
	return state.kind === "ready" ? state.statuses[key] : "unknown";
}

function emptyTitle(state: OperationsEntryState) {
	switch (state.kind) {
		case "loading":
			return "正在读取观测状态";
		case "empty":
			return "暂无观测数据";
		case "ready":
			return "观测状态已更新";
		default:
			return "观测查询尚未接入";
	}
}

function emptyDescription(state: OperationsEntryState) {
	switch (state.kind) {
		case "loading":
			return "正在等待正式观测查询返回。";
		case "empty":
			return "正式观测查询已接入，但当前没有可显示的状态。";
		case "ready":
			return "状态来自正式观测查询；页面不生成指标或告警事实。";
		default:
			return "当前页面不生成指标或告警事实；待 #441 的正式遥测查询和告警出口接入后，这里才会显示真实状态。";
	}
}

export function OperationsEntry({
	isAdministrator,
	onRefresh,
	state = { kind: "unknown" },
	isRefreshing = false,
}: {
	isAdministrator: boolean;
	onRefresh?: () => void;
	state?: OperationsEntryState;
	isRefreshing?: boolean;
}) {
	if (!isAdministrator) {
		return (
			<Alert>
				<AlertDescription>当前登录主体无权访问运维观测入口。</AlertDescription>
			</Alert>
		);
	}
	return (
		<div className="space-y-8">
			<header className="page-heading">
				<div className="min-w-0">
					<p className="page-eyebrow">系统管理 / 运维观测</p>
					<h1>先确认平台状态，再定位故障。</h1>
					<p>健康、积压、依赖和告警将在正式观测查询接入后显示真实结果。</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					onClick={() => onRefresh?.()}
					disabled={onRefresh === undefined || isRefreshing}
					aria-label="刷新运维状态"
					title={onRefresh === undefined ? "正式观测查询尚未接入" : undefined}
				>
					<RefreshCcw aria-hidden="true" />
					{isRefreshing ? "刷新中" : "刷新"}
				</Button>
			</header>
			<div className="grid gap-4 md:grid-cols-2">
				{domains.map(({ key, icon: Icon, label, description }) => (
					<section key={key} className="rounded-[14px] border bg-card p-5">
						<div className="flex items-start justify-between gap-3">
							<div className="flex items-center gap-3">
								<Icon
									className="size-5 text-muted-foreground"
									aria-hidden="true"
								/>
								<h2 className="font-medium">{label}</h2>
							</div>
							<StatusBadge status={statusFor(state, key)} />
						</div>
						<p className="mt-3 text-muted-foreground text-sm">{description}</p>
					</section>
				))}
			</div>
			{state.kind === "error" ? (
				<Alert variant="destructive" role="alert">
					<AlertDescription>
						{state.message}
						{state.retryable ? " 请刷新后重试。" : ""}
					</AlertDescription>
				</Alert>
			) : state.kind === "unavailable" ? (
				<Alert role="status">
					<AlertDescription>
						{state.message ?? "观测服务当前不可用。"}
					</AlertDescription>
				</Alert>
			) : (
				<Empty className="min-h-52 border" aria-live="polite">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Activity aria-hidden="true" />
						</EmptyMedia>
						<EmptyTitle>{emptyTitle(state)}</EmptyTitle>
						<EmptyDescription>{emptyDescription(state)}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}
		</div>
	);
}
