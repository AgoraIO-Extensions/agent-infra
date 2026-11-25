import {
	type OperationsTaskQueryV2,
	type OperationsTasksV2,
	OperationsTasksV2Schema,
} from "@agent-infra/contracts/pilot";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Timestamp } from "@/components/ui/timestamp";
import { getOperationsTasksV2 } from "../../pilot/generated-v2/sdk.gen.js";

const stageLabel = {
	acceptance: "受理",
	queue: "等待",
	dispatch: "投递或恢复",
	execution: "执行",
	result: "结果",
	runtime: "Runtime",
	model: "模型",
	tool: "工具",
	verification: "待核实",
};
const stateLabel = {
	accepted: "已受理",
	waiting: "等待中",
	submitted: "已提交",
	processing: "执行中",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
	unknown: "待核实",
	started: "已开始",
};

function missingStages(task: OperationsTasksV2["tasks"][number]) {
	const expected: (keyof typeof stageLabel)[] = ["acceptance", "queue"];
	if (task.status !== "waiting") expected.push("dispatch");
	if (task.status !== "waiting" && task.status !== "submitted")
		expected.push("execution");
	if (task.status === "unknown") expected.push("verification");
	if (
		task.status === "completed" ||
		task.status === "failed" ||
		task.status === "cancelled"
	)
		expected.push("result");
	const observed = new Set(task.evidence.map(({ stage }) => stage));
	return expected
		.filter((stage) => !observed.has(stage))
		.map((stage) => stageLabel[stage]);
}

function localTime(date: Date) {
	return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
		.toISOString()
		.slice(0, -1);
}

export function TaskEvidence({
	agentId,
	sessionId,
	identityKey,
	from,
	to,
}: {
	agentId: string;
	sessionId: string;
	identityKey: string;
	from?: number;
	to?: number;
}) {
	const prefix = useId();
	const [window, setWindow] = useState(() => {
		if (from !== undefined && to !== undefined)
			return {
				start: new Date(from).toISOString(),
				end: new Date(to).toISOString(),
			};
		const end = new Date();
		// Include the current minute in the half-open range.
		end.setSeconds(59, 999);
		return {
			start: new Date(end.getTime() - 3_600_000).toISOString(),
			end: end.toISOString(),
		};
	});
	const [start, setStart] = useState(() => localTime(new Date(window.start)));
	const [end, setEnd] = useState(() => localTime(new Date(window.end)));
	const [invalid, setInvalid] = useState(false);
	const query = useQuery({
		queryKey: ["ops-tasks", identityKey, agentId, sessionId, window],
		queryFn: async ({ signal }) => {
			const query: OperationsTaskQueryV2 = { agentId, sessionId, ...window };
			const response = await getOperationsTasksV2({
				headers: { Prefer: "include-observed-pod" },
				query,
				signal,
				throwOnError: false,
			});
			if (
				response.response?.status === 403 ||
				response.response?.status === 401
			)
				return { denied: true } as const;
			if (response.response?.status !== 200)
				throw new Error("Task evidence unavailable");
			return OperationsTasksV2Schema.parse(response.data);
		},
		retry: false,
		gcTime: 0,
	});
	const data =
		query.isError || !query.data || "denied" in query.data ? null : query.data;
	return (
		<Card className="space-y-4 p-4">
			<h2>会话任务阶段</h2>
			<form
				className="flex flex-wrap items-end gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					const from = new Date(start);
					const to = new Date(end);
					const span = to.getTime() - from.getTime();
					if (!(span > 0 && span <= 30 * 86_400_000)) {
						setInvalid(true);
						return;
					}
					setInvalid(false);
					const next = { start: from.toISOString(), end: to.toISOString() };
					if (window.start === next.start && window.end === next.end)
						void query.refetch();
					else setWindow(next);
				}}
			>
				<div>
					<Label htmlFor={`${prefix}-start`}>开始时间</Label>
					<Input
						id={`${prefix}-start`}
						type="datetime-local"
						step="0.001"
						value={start}
						onChange={(event) => setStart(event.target.value)}
						required
					/>
				</div>
				<div>
					<Label htmlFor={`${prefix}-end`}>结束时间</Label>
					<Input
						id={`${prefix}-end`}
						type="datetime-local"
						step="0.001"
						value={end}
						onChange={(event) => setEnd(event.target.value)}
						required
					/>
				</div>
				<Button type="submit">查询</Button>
			</form>
			{invalid && <Alert tone="warn">请选择最长 30 天的有效时间范围。</Alert>}
			{query.isPending && <p role="status">正在读取任务证据。</p>}
			{query.data && "denied" in query.data && (
				<Alert tone="warn">无法读取此会话的任务证据。</Alert>
			)}
			{(query.isError || data?.state === "unavailable") && (
				<Alert tone="warn">Platform 任务数据源暂不可用。</Alert>
			)}
			{data?.truncated && (
				<Alert tone="warn">查询达到上限。结果可能不完整。</Alert>
			)}
			{data?.state === "missing" && <p>所选时间范围内没有匹配的任务证据。</p>}
			{data?.tasks.map((task) => {
				const gaps = missingStages(task);
				return (
					<section key={task.executionId} className="space-y-2">
						<h3 className="break-all">
							{task.executionId} · {stateLabel[task.status]}
						</h3>
						<p>执行期间观测到的 Pod UID · {task.observedPodUid ?? "未知"}</p>
						{gaps.length > 0 && (
							<p>所选范围缺少阶段证据（{gaps.join("、")}）。</p>
						)}
						<ul className="space-y-1">
							{task.evidence.map((fact, index) => (
								<li key={`${index}-${fact.stage}-${fact.observedAt}`}>
									{stageLabel[fact.stage]} · {stateLabel[fact.state]} ·{" "}
									<Timestamp value={fact.observedAt} style="absolute" />
									{fact.startedAt && (
										<>
											{" "}
											· 开始{" "}
											<Timestamp value={fact.startedAt} style="absolute" />
										</>
									)}
									{fact.finishedAt && (
										<>
											{" "}
											· 结束{" "}
											<Timestamp value={fact.finishedAt} style="absolute" />
										</>
									)}
									{fact.stage !== "acceptance" && (
										<>
											{" "}
											·{" "}
											{fact.durationMs == null
												? "耗时未知"
												: `${fact.durationMs} ms`}
										</>
									)}
									{fact.state === "failed" && (
										<> · {fact.errorCode ?? "错误码缺失"}</>
									)}
								</li>
							))}
						</ul>
					</section>
				);
			})}
		</Card>
	);
}
