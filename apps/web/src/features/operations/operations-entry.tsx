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

type OperationsStatus = "unknown" | "unavailable" | "healthy" | "degraded";

const domains: Array<{
	icon: typeof Activity;
	label: string;
	description: string;
}> = [
	{
		icon: Activity,
		label: "服务健康与延迟",
		description: "API、SSE 和后台依赖的可用性与延迟。",
	},
	{
		icon: Server,
		label: "Agent 与任务",
		description: "Agent 启动、更新、不可用和任务积压。",
	},
	{
		icon: Database,
		label: "数据与投递",
		description: "PostgreSQL、outbox 和投递重试状态。",
	},
	{
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

export function OperationsEntry({
	isAdministrator,
	onRefresh,
}: {
	isAdministrator: boolean;
	onRefresh?: () => void;
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
					onClick={onRefresh}
					aria-label="刷新运维状态"
				>
					<RefreshCcw aria-hidden="true" />
					刷新
				</Button>
			</header>
			<div className="grid gap-4 md:grid-cols-2">
				{domains.map(({ icon: Icon, label, description }) => (
					<section key={label} className="rounded-[14px] border bg-card p-5">
						<div className="flex items-start justify-between gap-3">
							<div className="flex items-center gap-3">
								<Icon
									className="size-5 text-muted-foreground"
									aria-hidden="true"
								/>
								<h2 className="font-medium">{label}</h2>
							</div>
							<StatusBadge status="unknown" />
						</div>
						<p className="mt-3 text-muted-foreground text-sm">{description}</p>
					</section>
				))}
			</div>
			<Empty className="min-h-52 border">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<Activity aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle>观测查询尚未接入</EmptyTitle>
					<EmptyDescription>
						当前页面不生成指标或告警事实；待 #441
						的正式遥测查询和告警出口接入后，这里才会显示真实状态。
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		</div>
	);
}
