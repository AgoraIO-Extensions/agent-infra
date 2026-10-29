import { TaskFeedbackSummaryV1Schema } from "@agent-infra/contracts/pilot";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { readTaskFeedbackSummaryV1 } from "../../pilot/generated-v2/sdk.gen.js";
import { loadAgentDiscovery } from "../agent-discovery/agent-discovery.js";
import { feedbackLabels, percentage } from "./evaluation-labels.js";
import {
	EvaluationNotice,
	evaluationResponse,
	evaluationRequestOptions as options,
	useEvaluationRead,
} from "./evaluation-requests.js";

const localTime = (time: number) => {
	const d = new Date(time);
	return new Date(time - d.getTimezoneOffset() * 60000)
		.toISOString()
		.slice(0, 16);
};
export function EvaluationFeedbackSummary() {
	const [view, setView] = useState<"self" | "owner">("self");
	const [agent, setAgent] = useState("");
	const [from, setFrom] = useState(() => localTime(Date.now() - 86400000));
	const [to, setTo] = useState(() => localTime(Date.now()));
	const [model, setModel] = useState("");
	const [config, setConfig] = useState("");
	const [error, setError] = useState("");
	const [query, setQuery] = useState<{
		from: string;
		to: string;
		modelId?: string;
		configVersion?: string;
	} | null>(null);
	const agents = useEvaluationRead(
		useCallback(
			async (signal) => {
				const r = await loadAgentDiscovery(
					undefined,
					view === "owner" ? "owner" : "visible",
					signal,
				);
				if (r.kind !== "ready") throw new Error();
				return r.agents;
			},
			[view],
		),
	);
	const summary = useEvaluationRead(
		useCallback(
			async (signal) => {
				if (!agent || !query) throw new Error();
				return evaluationResponse(
					await readTaskFeedbackSummaryV1({
						...options,
						path: { agentId: agent },
						query: { view, ...query },
						signal,
					}),
					TaskFeedbackSummaryV1Schema,
				);
			},
			[agent, query, view],
		),
		Boolean(agent && query),
	);
	const data = summary.data;
	return (
		<section className="space-y-4" aria-labelledby="feedback-summary-heading">
			<h2 id="feedback-summary-heading">线上主动反馈</h2>
			<p>
				反馈由使用者在自己的任务中主动提交；未反馈不表示认可，线上反馈不混入离线评分通过率。
			</p>
			<EvaluationNotice
				error={error || agents.error || summary.error}
				loading={agents.loading || summary.loading}
			/>
			<form
				className="grid gap-3 sm:grid-cols-2"
				onSubmit={(e) => {
					e.preventDefault();
					setError("");
					const start = new Date(from);
					const end = new Date(to);
					if (
						!Number.isFinite(+start) ||
						!Number.isFinite(+end) ||
						+start >= +end
					) {
						setError("请选择有效的起止时间，结束时间须晚于开始时间。");
						return;
					}
					summary.clear();
					setQuery({
						from: start.toISOString(),
						to: end.toISOString(),
						...(model.trim() ? { modelId: model.trim() } : {}),
						...(config.trim() ? { configVersion: config.trim() } : {}),
					});
				}}
			>
				<div>
					<Label htmlFor="feedback-view">查看范围</Label>
					<NativeSelect
						id="feedback-view"
						value={view}
						onChange={(e) => {
							const next = e.target.value === "owner" ? "owner" : "self";
							if (next === view) return;
							setView(next);
							setAgent("");
							setQuery(null);
							summary.clear();
							agents.clear();
						}}
					>
						<NativeSelectOption value="self">本人任务</NativeSelectOption>
						<NativeSelectOption value="owner">
							Owner 获准汇总
						</NativeSelectOption>
					</NativeSelect>
				</div>
				<div>
					<Label htmlFor="feedback-agent">Agent</Label>
					<NativeSelect
						id="feedback-agent"
						value={agent}
						onChange={(e) => {
							setAgent(e.target.value);
							setQuery(null);
							summary.clear();
						}}
					>
						<NativeSelectOption value="">选择当前可见 Agent</NativeSelectOption>
						{agents.data?.map((a) => (
							<NativeSelectOption key={a.agentId} value={a.agentId}>
								{a.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
				<div>
					<Label htmlFor="feedback-from">确认终态起始时间（本地）</Label>
					<Input
						type="datetime-local"
						id="feedback-from"
						value={from}
						onChange={(e) => setFrom(e.target.value)}
						required
					/>
				</div>
				<div>
					<Label htmlFor="feedback-to">确认终态结束时间（不含，本地）</Label>
					<Input
						type="datetime-local"
						id="feedback-to"
						value={to}
						onChange={(e) => setTo(e.target.value)}
						required
					/>
				</div>
				<div>
					<Label htmlFor="feedback-model">实际模型（可选）</Label>
					<Input
						id="feedback-model"
						value={model}
						onChange={(e) => setModel(e.target.value)}
						maxLength={256}
					/>
				</div>
				<div>
					<Label htmlFor="feedback-config">实际配置版本（可选）</Label>
					<Input
						id="feedback-config"
						value={config}
						onChange={(e) => setConfig(e.target.value)}
						maxLength={256}
					/>
				</div>
				<div className="flex flex-wrap gap-3 sm:col-span-2">
					<Button type="submit" disabled={!agent || summary.loading}>
						查询反馈汇总
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							setAgent("");
							setQuery(null);
							summary.clear();
							void agents.reload();
						}}
					>
						刷新可见 Agent
					</Button>
				</div>
			</form>
			{agents.data && !agents.data.length && <p>当前没有可见的 Agent。</p>}
			{data && (
				<section aria-label="反馈汇总结果" className="space-y-3">
					<p>
						查询窗口：{data.query.from} 至 {data.query.to}（不含）。观察时间{" "}
						{data.observedAt}。
					</p>
					<p>
						范围：
						{data.view === "owner"
							? "Owner 授权汇总（无他人任务或正文下钻）"
							: "本人任务"}
					</p>
					<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
						{[
							["可反馈任务", data.eligibleTasks],
							["已反馈任务", data.feedbackTasks],
							["未反馈任务", data.unfeedbackTasks],
							["反馈率", percentage(data.feedbackRate)],
							["有用", data.usefulTasks],
							["无用", data.notUsefulTasks],
							["条件已变化", data.conditionChangedTasks],
							["实际模型缺失", data.missingActualTasks],
							["终态时间缺失", data.terminalTimeMissingTasks],
						].map(([label, value]) => (
							<div key={label} className="rounded border p-3">
								<dt>{label}</dt>
								<dd className="font-semibold">{value}</dd>
							</div>
						))}
					</dl>
					{data.eligibleTasks === 0 && (
						<p>此窗口没有可计入的任务，不推断为全部通过。</p>
					)}
					<p>
						终态时间缺失的历史任务单独列出，不虚构其所属窗口。条件已变化的旧反馈不进入有效反馈分子。
					</p>
					<h3>问题分类分布</h3>
					<ul>
						{Object.entries(data.classification).map(([category, n]) => (
							<li key={category}>
								{feedbackLabels[category as keyof typeof feedbackLabels]}：{n}
							</li>
						))}
					</ul>
					<h3>实际模型与配置分布</h3>
					<Table mobileLayout="cards">
						<TableHeader>
							<TableRow>
								<TableHead>实际条件集合</TableHead>
								<TableHead>任务数</TableHead>
								<TableHead>已反馈</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.conditions.map((c) => (
								<TableRow key={JSON.stringify(c.conditions)}>
									<TableCell data-label="实际条件集合">
										{c.conditions.length
											? c.conditions
													.map(
														(v) =>
															`${v.modelId} / ${v.configVersion} / ${v.reasoningLevel ?? "推理档位缺失"}`,
													)
													.join("；")
											: "实际条件缺失"}
									</TableCell>
									<TableCell data-label="任务数">{c.tasks}</TableCell>
									<TableCell data-label="已反馈">{c.feedbackTasks}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</section>
			)}
		</section>
	);
}
