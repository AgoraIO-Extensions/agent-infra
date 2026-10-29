import {
	EvaluationAnalysisDetailV1Schema,
	EvaluationAnalysisSummaryV1Schema,
	EvaluationHistoryV1Schema,
} from "@agent-infra/contracts/pilot";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import {
	listEvaluationHistoryV1,
	readEvaluationAnalysisSampleV1,
	readEvaluationAnalysisV1,
} from "../../pilot/generated-v2/sdk.gen.js";

type EvaluationModelFactsV1 = ReturnType<
	typeof EvaluationAnalysisSummaryV1Schema.parse
>["items"][number]["actual"];

import {
	comparisonLabels,
	contentLabels,
	percentage,
	scoreStateLabels,
	sourceLabels,
	taskStateLabels,
} from "./evaluation-labels.js";
import {
	EvaluationNotice,
	evaluationResponse,
	evaluationRequestOptions as options,
	useEvaluationRead,
} from "./evaluation-requests.js";

export function EvaluationAnalysis({
	selected,
	onSelect,
	onNewVersion,
}: {
	selected: string | null;
	onSelect: (id: string) => void;
	onNewVersion: (datasetId: string, versionId: string) => void;
}) {
	const [cursor, setCursor] = useState<string>();
	const history = useEvaluationRead(
		useCallback(
			async (signal) =>
				evaluationResponse(
					await listEvaluationHistoryV1({
						...options,
						query: { limit: 25, ...(cursor ? { cursor } : {}) },
						signal,
					}),
					EvaluationHistoryV1Schema,
				),
			[cursor],
		),
	);
	return (
		<section className="space-y-4" aria-labelledby="eval-analysis-heading">
			<h2 id="eval-analysis-heading">实验历史与对比</h2>
			<p>分析用途独立授权，历史保留原样本与评分版本。</p>
			<Button variant="outline" onClick={() => void history.reload()}>
				刷新实验历史
			</Button>
			<EvaluationNotice error={history.error} loading={history.loading} />
			{history.data && !history.data.items.length && (
				<p>当前没有获准查看的实验历史。</p>
			)}
			<ul className="space-y-2">
				{history.data?.items.map((e) => (
					<li
						key={e.experimentId}
						className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
					>
						<span className="min-w-0 break-all">
							{new Date(e.createdAt).toLocaleString()} · {e.sampleIds.length}{" "}
							个固定样本 · {e.variantIds.length} 个变体 ·{" "}
							{e.status === "cancelled" ? "已取消" : "已受理"} · 版本{" "}
							{e.versionId}
						</span>
						<Button
							variant="outline"
							aria-label={`分析实验 ${e.experimentId}`}
							onClick={() => onSelect(e.experimentId)}
						>
							查看对比
						</Button>
					</li>
				))}
			</ul>
			<div className="flex flex-wrap gap-3">
				{cursor && (
					<Button variant="outline" onClick={() => setCursor(undefined)}>
						历史首批
					</Button>
				)}
				{history.data?.nextCursor && (
					<Button
						variant="outline"
						onClick={() => setCursor(history.data?.nextCursor ?? undefined)}
					>
						下一批实验
					</Button>
				)}
			</div>
			{selected && (
				<AnalysisResult
					key={selected}
					experimentId={selected}
					onNewVersion={onNewVersion}
				/>
			)}
		</section>
	);
}
const metricLabels = {
	fixedSamples: "固定样本",
	scored: "已评分",
	passed: "通过",
	notPassed: "未通过",
	unscored: "未评分",
	scoreError: "评分故障或待核实",
	notApplicable: "不适用",
	businessFailed: "业务失败/取消",
	missing: "记录缺失",
} as const;
function AnalysisResult({
	experimentId,
	onNewVersion,
}: {
	experimentId: string;
	onNewVersion: (datasetId: string, versionId: string) => void;
}) {
	const [sample, setSample] = useState<string>();
	const [detailsEpoch, setDetailsEpoch] = useState(0);
	const read = useEvaluationRead(
		useCallback(
			async (signal) =>
				evaluationResponse(
					await readEvaluationAnalysisV1({
						...options,
						path: { experimentId },
						signal,
					}),
					EvaluationAnalysisSummaryV1Schema,
				),
			[experimentId],
		),
	);
	const data = read.data;
	return (
		<section
			aria-label="实验分析结果"
			className="space-y-4 rounded-lg border p-4"
		>
			<div className="flex flex-wrap gap-3">
				<Button
					variant="outline"
					onClick={() => {
						setSample(undefined);
						setDetailsEpoch((v) => v + 1);
						void read.reload();
					}}
				>
					刷新分析
				</Button>
				{data && (
					<Button
						variant="outline"
						onClick={() => onNewVersion(data.datasetId, data.versionId)}
					>
						维护新版本后再跑
					</Button>
				)}
			</div>
			<EvaluationNotice error={read.error} loading={read.loading} />
			{data && (
				<>
					<p>
						固定样本集合：{data.fixedSamples}；观察时间：
						{new Date(data.observedAt).toLocaleString()}
						。结果以本次读取时间为准，刷新后可能变化。
					</p>
					{!data.contentAvailable && (
						<p role="status">
							样本内容已到期、删除或不可读取；仅显示仍获准保留的元数据。
						</p>
					)}
					{!data.taskTypesAvailable && (
						<p>任务类型缺失，不能据此当成空评测集。</p>
					)}
					<h3>各变体、评分器的固定分母</h3>
					<Table mobileLayout="cards">
						<TableHeader>
							<TableRow>
								<TableHead>变体 / 评分器</TableHead>
								{Object.values(metricLabels).map((label) => (
									<TableHead key={label}>{label}</TableHead>
								))}
								<TableHead>已评分通过率</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.groups.map((g) => (
								<TableRow
									key={`${g.variantId}:${g.scorerId}:${g.scorerVersion}`}
								>
									<TableCell data-label="变体 / 评分器">
										{g.variantId} / {g.scorerId} · {g.scorerVersion}
									</TableCell>
									{Object.entries(metricLabels).map(([key, label]) => (
										<TableCell key={key} data-label={label}>
											{g.counts[key as keyof typeof metricLabels]}
										</TableCell>
									))}
									<TableCell data-label="已评分通过率">
										{percentage(g.passRate)}（分母 {g.counts.scored}）
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					<p>
						通过率只在已评分样本中计算；固定分母和缺失/故障覆盖同时展示，不将缺失或故障记为零分。
					</p>
					{data.groups.map((g) => (
						<Collapsible key={`${g.variantId}:${g.scorerId}:types`}>
							<CollapsibleTrigger>
								{g.variantId} / {g.scorerId} 的任务类型分布
							</CollapsibleTrigger>
							<CollapsiblePanel>
								<ul>
									{g.taskTypes.map((t) => (
										<li key={t.taskType ?? "missing"}>
											{t.taskType ?? "任务类型不可用"}：固定{" "}
											{t.counts.fixedSamples}，已评分 {t.counts.scored}
											，评分故障 {t.counts.scoreError}，业务失败{" "}
											{t.counts.businessFailed}
											，缺失 {t.counts.missing}，未评分 {t.counts.unscored}
											，不适用 {t.counts.notApplicable}，通过 {t.counts.passed}
											，未通过 {t.counts.notPassed}
										</li>
									))}
								</ul>
							</CollapsiblePanel>
						</Collapsible>
					))}
					<h3>可比覆盖</h3>
					{data.pairs.map((p) => (
						<section
							key={`${p.baselineId}:${p.candidateId}`}
							className="space-y-2"
						>
							<h4>
								{p.baselineId} → {p.candidateId}
							</h4>
							<p>
								固定 {p.counts.fixedSamples}，可比 {p.counts.comparable}
								，条件缺失 {p.counts.missingConditions}，环境不同{" "}
								{p.counts.differentEnvironment}，多模型{" "}
								{p.counts.mixedConditions}，目标未知 {p.counts.unknownTarget}
								，实际漂移 {p.counts.actualDrift}，非目标漂移{" "}
								{p.counts.nonTargetDrift}。
							</p>
							<ul>
								{p.samples.map((s) => (
									<li key={s.sampleId}>
										{s.sampleId} · {s.taskType ?? "类型缺失"} ·{" "}
										{comparisonLabels[s.status]}
										{s.conditionsChanged ? " · 条件有变化" : ""}
									</li>
								))}
							</ul>
						</section>
					))}
					<h3>逐例执行与评分</h3>
					{data.items.map((item) => (
						<article
							key={item.sampleTaskId}
							className="space-y-2 rounded-lg border p-3"
						>
							<h4>
								{item.sampleId} · {item.variantId}
							</h4>
							<p>
								{taskStateLabels[item.status]} · 任务受理至确认终态：
								{item.taskElapsedMs === null
									? "缺失"
									: `${item.taskElapsedMs} ms`}
							</p>
							<p>
								请求模型选项：{item.requested.modelOptionId ?? "未指定"} · 配置{" "}
								{item.requested.configurationRevision} · 工具环境{" "}
								{item.requested.toolEnvironment}
							</p>
							<p className="break-all">
								实际准备镜像：{item.preparedRuntime?.imageDigest ?? "缺失"} ·
								实际配置修订：
								{item.preparedRuntime?.configurationRevision ?? "缺失"}
							</p>
							<ActualFacts facts={item.actual} />
							{item.scores.map((s) => (
								<p key={s.scoreId}>
									{s.scorerId} · {sourceLabels[s.source]}
									{s.scoringModel ? `（${s.scoringModel}）` : ""}：
									{scoreStateLabels[s.status]}
									{s.status === "scored"
										? `，分数 ${s.value}，${s.passed ? "通过" : "未通过"}`
										: ""}
									{s.failureCode ? ` · ${s.failureCode}` : ""}
								</p>
							))}
							<Button
								variant="outline"
								disabled={!data.contentAvailable}
								aria-label={`查看样本 ${item.sampleId} ${item.variantId}`}
								onClick={() => setSample(item.sampleTaskId)}
							>
								查看获准样本与依据
							</Button>
						</article>
					))}
					{sample && (
						<AnalysisDetail
							key={`${sample}:${detailsEpoch}`}
							experimentId={experimentId}
							sampleTaskId={sample}
							onClose={() => setSample(undefined)}
						/>
					)}
				</>
			)}
		</section>
	);
}
export function ActualFacts({ facts }: { facts: EvaluationModelFactsV1 }) {
	return (
		<div className="space-y-1">
			<p>
				实际模型条件：
				{facts.conditionStatus === "missing"
					? "缺失"
					: facts.conditionStatus === "mixed"
						? "多个条件（mixed）"
						: "已观测"}
			</p>
			{facts.conditions.map((c) => (
				<p key={JSON.stringify(c)}>
					{c.modelId} · 配置 {c.configVersion} ·{" "}
					{c.reasoningLevel ?? "推理档位缺失"}
				</p>
			))}
			{(
				[
					["inputTokens", "输入 Token"],
					["outputTokens", "输出 Token"],
					["cachedInputTokens", "缓存输入 Token"],
					["modelDurationMs", "模型累计耗时（可能并行）"],
				] as const
			).map(([key, label]) => (
				<p key={key}>
					{label}：{facts[key].value ?? "缺失"}
					{key === "modelDurationMs" && facts[key].value !== null ? " ms" : ""}{" "}
					· 采集覆盖 {facts[key].observed}/{facts[key].total}
				</p>
			))}
		</div>
	);
}
function AnalysisDetail({
	experimentId,
	sampleTaskId,
	onClose,
}: {
	experimentId: string;
	sampleTaskId: string;
	onClose: () => void;
}) {
	const [limit, setLimit] = useState(5);
	const [page, setPage] = useState<{
		cursor?: string;
		scoreId?: string;
		reviewCursor?: string;
	}>({});
	const read = useEvaluationRead(
		useCallback(
			async (signal) =>
				evaluationResponse(
					await readEvaluationAnalysisSampleV1({
						...options,
						path: { experimentId, sampleTaskId },
						query: { limit, ...page },
						signal,
					}),
					EvaluationAnalysisDetailV1Schema,
				),
			[experimentId, sampleTaskId, page, limit],
		),
	);
	const d = read.data;
	return (
		<section aria-label="获准样本详情" className="space-y-3 rounded border p-4">
			<Label htmlFor="analysis-detail-limit">每页评分与复核条数</Label>
			<NativeSelect
				id="analysis-detail-limit"
				value={limit}
				onChange={(e) => {
					setLimit(Number(e.target.value));
					setPage({});
					read.clear();
				}}
			>
				{[1, 5, 10, 25].map((n) => (
					<NativeSelectOption key={n} value={n}>
						{n} 条
					</NativeSelectOption>
				))}
			</NativeSelect>
			<Button variant="ghost" onClick={onClose}>
				关闭样本详情
			</Button>
			<EvaluationNotice error={read.error} loading={read.loading} />
			{d && (
				<>
					<h4>样本 {d.sample.id}</h4>
					<p>任务类型：{d.sample.taskType}</p>
					<p className="whitespace-pre-wrap break-words">{d.sample.input}</p>
					{d.sample.context && (
						<p className="whitespace-pre-wrap break-words">
							上下文：{d.sample.context}
						</p>
					)}
					<p className="whitespace-pre-wrap break-words">
						预期结果：{d.sample.expectedResult ?? "未提供"}
					</p>
					{d.scores.map((s) => (
						<article key={s.scoreId} className="space-y-2 border-t pt-3">
							<h4>
								{s.scorerId} · {sourceLabels[s.source]}
								{s.scoringModel ? ` · ${s.scoringModel}` : ""}
							</h4>
							<p>
								原评分：{scoreStateLabels[s.status]}
								{s.status === "scored" ? ` · ${s.value}` : ""}
							</p>
							<p className="whitespace-pre-wrap break-words">
								输出：
								{!s.output
									? "未产生"
									: s.output.contentStatus === "available"
										? s.output.value.text
										: contentLabels[s.output.contentStatus]}
							</p>
							<p className="whitespace-pre-wrap break-words">
								原评分依据：
								{!s.reason
									? "未产生"
									: s.reason.contentStatus === "available"
										? s.reason.value.reason
										: contentLabels[s.reason.contentStatus]}
							</p>
							<h5>独立复核</h5>
							{s.reviews.map((r) => (
								<div key={r.reviewId}>
									<p>
										复核者 {r.reviewer.kind} · {r.reviewer.id}，原评分修订{" "}
										{r.scoreRevision}
									</p>
									{r.result.contentStatus === "available" ? (
										<p className="whitespace-pre-wrap break-words">
											{r.result.value.status === "scored"
												? `分数 ${r.result.value.value}`
												: "不适用"}{" "}
											· {r.result.value.reason}
										</p>
									) : (
										<p>{contentLabels[r.result.contentStatus]}</p>
									)}
								</div>
							))}
							{!s.reviews.length && <p>此页无复核记录。</p>}
							{s.nextReviewCursor && (
								<Button
									variant="outline"
									onClick={() =>
										setPage({
											scoreId: s.scoreId,
											reviewCursor: s.nextReviewCursor ?? undefined,
										})
									}
								>
									下一批复核：{s.scorerId}
								</Button>
							)}
						</article>
					))}
					<div className="flex flex-wrap gap-3">
						{Object.keys(page).length > 0 && (
							<Button variant="outline" onClick={() => setPage({})}>
								详情首批
							</Button>
						)}
						{d.nextCursor && (
							<Button
								variant="outline"
								onClick={() => setPage({ cursor: d.nextCursor ?? undefined })}
							>
								下一批评分依据
							</Button>
						)}
					</div>
				</>
			)}
		</section>
	);
}
