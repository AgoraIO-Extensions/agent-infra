import type {
	OperationsHistoryQueryV2,
	OperationsHistoryV2,
	OperationsResourcesV2,
} from "@agent-infra/contracts/pilot";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Timestamp } from "@/components/ui/timestamp";
import { formatTimestamp } from "@/lib/format-time";
import { resourceNumber } from "./resource-dashboard.js";
import {
	fetchOperationsHistory,
	OperationsQueryError,
} from "./resource-query.js";

const metricNames: Record<OperationsHistoryQueryV2["metric"], string> = {
	cpu: "CPU 用量",
	memory: "内存用量",
	storage: "存储用量",
	"http-requests": "HTTP 请求速率",
	"http-errors": "HTTP 错误速率",
	"http-latency": "HTTP 延迟",
	waiting: "等待投递",
	outbox: "后台积压",
	"dependency-latency": "依赖查询耗时",
	"runtime-latency": "Runtime 延迟",
	"model-latency": "模型调用耗时",
	"tool-latency": "工具调用耗时",
	"model-errors": "模型错误速率",
	"tool-errors": "工具错误速率",
	"runtime-errors": "Runtime 错误速率",
	"sse-connections": "流式连接数",
	"sse-pending": "流式事件积压",
};
const stateNames = {
	available: "已有历史样本",
	missing: "所选范围没有样本",
	unavailable: "历史数据源暂不可用",
	"not-configured": "历史查询未接入",
	"outside-retention": "超出部署声明保留范围",
	"not-supported": "数据源无法可靠提供此范围的历史",
};
function localInput(value: Date) {
	return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
		.toISOString()
		.slice(0, 16);
}

function HistoryChart({
	series,
	metric,
	stepSeconds,
}: {
	series: OperationsHistoryV2["series"][number];
	metric: OperationsHistoryQueryV2["metric"];
	stepSeconds: number;
}) {
	const id = useId();
	const values = series.points.flatMap((point) =>
		point.value === null ? [] : [point.value],
	);
	if (values.length === 0)
		return (
			<figure>
				<figcaption>{series.name}</figcaption>
				<p>数值未知，无法绘制曲线。</p>
			</figure>
		);
	const maximum = values.length ? Math.max(...values) : 0;
	const minimum = values.length ? Math.min(...values) : 0;
	const start = Date.parse(series.points[0]?.at ?? "");
	const end = Date.parse(series.points.at(-1)?.at ?? "");
	let move = true;
	let previousAt: number | undefined;
	const path = series.points
		.map((point) => {
			if (point.value === null) {
				move = true;
				return "";
			}
			const time = Date.parse(point.at);
			if (previousAt !== undefined && time - previousAt > stepSeconds * 1500)
				move = true;
			previousAt = time;
			const x =
				8 + ((Date.parse(point.at) - start) / Math.max(1, end - start)) * 384;
			const y =
				110 -
				((point.value - Math.min(0, minimum)) /
					Math.max(1e-9, maximum - Math.min(0, minimum))) *
					100;
			const command = move ? "M" : "L";
			move = false;
			return `${command}${x.toFixed(2)},${y.toFixed(2)}${command === "M" ? " l0.01,0" : ""}`;
		})
		.join(" ");
	const format = (value: number) =>
		metric === "cpu"
			? resourceNumber(value, "cpu")
			: ["memory", "storage"].includes(metric)
				? resourceNumber(value, "bytes")
				: `${value.toFixed(2)}${metric.endsWith("latency") ? " ms" : ""}`;
	return (
		<figure>
			<figcaption id={`${id}-caption`}>{series.name}</figcaption>
			<svg
				viewBox="0 0 400 120"
				role="img"
				aria-labelledby={`${id}-caption ${id}-description`}
			>
				<title id={`${id}-description`}>
					范围 {format(minimum)} 至 {format(maximum)}；缺失样本保留断点。
				</title>
				<path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
			</svg>
			<div className="ops-history-axis">
				<span>最低 {format(minimum)}</span>
				<span>最高 {format(maximum)}</span>
			</div>
			<div className="ops-history-axis">
				<Timestamp value={series.points[0]?.at} style="absolute" />
				<Timestamp value={series.points.at(-1)?.at} style="absolute" />
			</div>
		</figure>
	);
}

export function ResourceHistory({
	identityKey,
	agentId,
	sessionId,
	links,
	objects,
	onDenied,
}: {
	identityKey: string;
	agentId: string;
	sessionId: string;
	links: OperationsResourcesV2["links"];
	objects: readonly { uid: string; name: string }[];
	onDenied?: () => void;
}) {
	const id = useId();
	const [metric, setMetric] =
		useState<OperationsHistoryQueryV2["metric"]>("cpu");
	const [statistic, setStatistic] = useState<"average" | "maximum">("average");
	const [resourceUid, setResourceUid] = useState("");
	const [start, setStart] = useState(() =>
		localInput(new Date(Date.now() - 3600000)),
	);
	const [end, setEnd] = useState(() => localInput(new Date()));
	const [error, setError] = useState("");
	const [request, setRequest] = useState<OperationsHistoryQueryV2 | null>(null);
	const query = useQuery({
		queryKey: ["ops-history", identityKey, agentId, sessionId, request],
		enabled: request !== null,
		queryFn: ({ signal }) =>
			fetchOperationsHistory(
				{
					...(request ?? {
						metric: "cpu",
						statistic: "average",
						start: "",
						end: "",
					}),
					...(agentId ? { agentId } : {}),
					...(sessionId ? { sessionId } : {}),
				},
				signal,
			),
		retry: false,
		gcTime: 0,
	});
	const denied =
		query.error instanceof OperationsQueryError &&
		query.error.kind === "denied";
	useEffect(() => {
		if (denied) onDenied?.();
	}, [denied, onDenied]);
	const history = denied ? undefined : query.data;
	return (
		<Card
			render={<section aria-labelledby={`${id}-title`} />}
			className="ops-resource-panel"
		>
			<h2 id={`${id}-title`}>历史趋势与依赖</h2>
			<p>
				按当前 Agent 和会话范围查询。日志、Trace
				与基础设施数据源各自保留真实缺口。
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					const from = Date.parse(start);
					const to = Date.parse(end);
					if (
						!Number.isFinite(from) ||
						!Number.isFinite(to) ||
						to <= from ||
						to - from > 30 * 86400_000 ||
						to > Date.now() + 60000
					) {
						setError(
							"请选择不超过 30 天的有效时间范围，结束时间不能晚于当前时间。",
						);
						return;
					}
					setError("");
					const next = {
						metric,
						statistic,
						...(resourceUid ? { resourceUid } : {}),
						start: new Date(from).toISOString(),
						end: new Date(to).toISOString(),
					};
					if (request && JSON.stringify(request) === JSON.stringify(next))
						void query.refetch();
					else setRequest(next);
				}}
			>
				<div className="ops-resource-filters">
					<div>
						<Label htmlFor={`${id}-object`}>运行对象</Label>
						<NativeSelect
							id={`${id}-object`}
							value={resourceUid}
							onChange={(event) => setResourceUid(event.target.value)}
						>
							<NativeSelectOption value="">当前范围全部对象</NativeSelectOption>
							{resourceUid &&
								!objects.some((entry) => entry.uid === resourceUid) && (
									<NativeSelectOption value={resourceUid}>
										{resourceUid}（历史对象）
									</NativeSelectOption>
								)}
							{objects.map((entry) => (
								<NativeSelectOption key={entry.uid} value={entry.uid}>
									{entry.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					<div>
						<Label htmlFor={`${id}-metric`}>指标</Label>
						<NativeSelect
							id={`${id}-metric`}
							value={metric}
							onChange={(event) =>
								setMetric(event.target.value as typeof metric)
							}
						>
							{Object.entries(metricNames).map(([value, label]) => (
								<NativeSelectOption key={value} value={value}>
									{label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					<div>
						<Label htmlFor={`${id}-statistic`}>聚合口径</Label>
						<NativeSelect
							id={`${id}-statistic`}
							value={statistic}
							onChange={(event) =>
								setStatistic(event.target.value as typeof statistic)
							}
						>
							<NativeSelectOption value="average">平均值</NativeSelectOption>
							<NativeSelectOption value="maximum">峰值</NativeSelectOption>
						</NativeSelect>
					</div>
					<div>
						<Label htmlFor={`${id}-start`}>开始时间</Label>
						<Input
							type="datetime-local"
							id={`${id}-start`}
							value={start}
							required
							onChange={(event) => setStart(event.target.value)}
						/>
					</div>
					<div>
						<Label htmlFor={`${id}-end`}>结束时间</Label>
						<Input
							type="datetime-local"
							id={`${id}-end`}
							value={end}
							required
							onChange={(event) => setEnd(event.target.value)}
						/>
					</div>
					<Button type="submit" disabled={query.isFetching}>
						{query.isFetching ? "查询中…" : "查询历史"}
					</Button>
				</div>
			</form>
			{error && (
				<Alert tone="danger" role="alert">
					{error}
				</Alert>
			)}
			{query.isError && (
				<Alert tone="danger" role="alert">
					历史查询失败，请检查权限或稍后重试。已有曲线是上次查询的结果。
				</Alert>
			)}
			{history ? (
				<>
					<p role="status">
						{stateNames[history.state]} · {history.stepSeconds} 秒采样步长 ·{" "}
						{history.statistic === "maximum" ? "峰值" : "平均值"}
						{history.truncated ? " · 结果已截断" : ""}
						{history.coverage?.state === "partial"
							? ` · 部分时间超出部署声明保留范围，仅查询 ${formatTimestamp(history.coverage.start, { style: "absolute" })?.text ?? "未知"} 起的数据`
							: ""}
					</p>
					<div className="ops-history-series">
						{history.series.slice(0, 12).map((series) => (
							<HistoryChart
								key={`${series.resourceUid}:${series.name}`}
								series={series}
								metric={history.metric}
								stepSeconds={history.stepSeconds}
							/>
						))}
					</div>
					{history.series.length > 12 && (
						<p>当前显示前 12 条曲线，请缩小 Agent 或会话范围查看。</p>
					)}
				</>
			) : (
				!query.isFetching && (
					<p>选择时间范围后查询；尚未采集的时间段不会补造历史。</p>
				)
			)}
			<div className="ops-diagnosis-links">
				{links.map((link) => {
					const url = new URL(link.url);
					if (request) {
						url.searchParams.set("from", request.start);
						url.searchParams.set("to", request.end);
					}
					return (
						<a key={link.kind} href={url.href} target="_blank" rel="noreferrer">
							打开{link.kind === "logs" ? "日志" : "Trace"} ↗
						</a>
					);
				})}
			</div>
		</Card>
	);
}
