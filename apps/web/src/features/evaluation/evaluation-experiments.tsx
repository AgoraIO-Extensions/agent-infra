import {
	EvaluationChoiceCatalogV1Schema,
	EvaluationDatasetPageV1Schema,
	EvaluationExperimentPageV1Schema,
	EvaluationExperimentV1Schema,
} from "@agent-infra/contracts/pilot";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
	cancelEvaluationExperimentV1,
	createEvaluationExperimentV1,
	listEvaluationChoicesV1,
	listEvaluationDatasetsV1,
	readEvaluationExperimentV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import type { EvaluationExperimentV1 } from "../../pilot/generated-v2/types.gen.js";
import { sourceLabels, taskStateLabels } from "./evaluation-labels.js";
import {
	EvaluationNotice,
	EvaluationRetry,
	evaluationResponse,
	evaluationRequestOptions as options,
	useEvaluationCommand,
	useEvaluationRead,
} from "./evaluation-requests.js";

type Target = "model" | "configuration" | "template";
export function EvaluationRun({
	onAnalyze,
	initialVersion,
}: {
	onAnalyze: (id: string) => void;
	initialVersion?: { datasetId: string; versionId: string } | null;
}) {
	const [selection, setSelection] = useState("");
	const [progressLocked, setProgressLocked] = useState(false);
	const [baseline, setBaseline] = useState("");
	const [candidates, setCandidates] = useState<string[]>([]);
	const [scorers, setScorers] = useState<string[]>([]);
	const [targets, setTargets] = useState<Target[]>(["model"]);
	const [experiment, setExperiment] = useState<EvaluationExperimentV1 | null>(
		null,
	);
	const datasets = useEvaluationRead(
		useCallback(
			async (signal) =>
				evaluationResponse(
					await listEvaluationDatasetsV1({ ...options, signal }),
					EvaluationDatasetPageV1Schema,
				),
			[],
		),
	);
	const versions =
		datasets.data?.items.flatMap((d) =>
			d.versions
				.filter((v) => v.status === "available")
				.map((v) => ({
					key: `${d.datasetId}/${v.versionId}`,
					datasetId: d.datasetId,
					versionId: v.versionId,
					label: `${d.name} · 版本 ${v.versionId}`,
				})),
		) ?? [];
	const selected = versions.find((v) => v.key === selection);
	const datasetId = selected?.datasetId;
	const versionId = selected?.versionId;
	const choices = useEvaluationRead(
		useCallback(
			async (signal) => {
				if (!datasetId || !versionId) throw new Error();
				return evaluationResponse(
					await listEvaluationChoicesV1({
						...options,
						query: {
							datasetId,
							versionId,
						},
						signal,
					}),
					EvaluationChoiceCatalogV1Schema,
				);
			},
			[datasetId, versionId],
		),
		Boolean(selected),
	);
	const command = useEvaluationCommand<EvaluationExperimentV1>((value) => {
		setExperiment(value);
	});
	const locked = command.busy || command.uncertain || progressLocked;
	const initialSelection = initialVersion
		? `${initialVersion.datasetId}/${initialVersion.versionId}`
		: "";
	const appliedSelection = useRef("");
	useEffect(() => {
		if (
			!initialSelection ||
			locked ||
			appliedSelection.current === initialSelection
		)
			return;
		appliedSelection.current = initialSelection;
		setSelection(initialSelection);
		setBaseline("");
		setCandidates([]);
		setScorers([]);
		void datasets.reload();
	}, [initialSelection, locked, datasets.reload]);

	const resetSelection = (value: string) => {
		setSelection(value);
		setBaseline("");
		setCandidates([]);
		setScorers([]);
		choices.clear();
	};
	return (
		<section aria-labelledby="eval-run-heading" className="space-y-4">
			<h2 id="eval-run-heading">运行基线与候选</h2>
			<p>
				使用同一版本样本和评分标准。模型随机性与工具环境可能影响对比，请核对实际条件。
			</p>
			<EvaluationNotice
				error={datasets.error || choices.error || command.error}
				loading={datasets.loading || choices.loading}
			/>
			<Button
				variant="outline"
				disabled={locked}
				onClick={() => {
					resetSelection("");
					void datasets.reload();
				}}
			>
				刷新可用版本
			</Button>
			<form
				className="space-y-4"
				onSubmit={(e) => {
					e.preventDefault();
					if (
						!selected ||
						!choices.data ||
						!baseline ||
						!candidates.length ||
						!scorers.length ||
						!targets.length ||
						locked
					)
						return;
					const refs = choices.data.scorers
						.filter((s) =>
							scorers.includes(JSON.stringify([s.scorerId, s.version])),
						)
						.map((s) => ({ scorerId: s.scorerId, version: s.version }));
					const body = {
						datasetId: selected.datasetId,
						versionId: selected.versionId,
						variantIds: [baseline, ...candidates],
						scorerRefs: refs,
						comparisonTargets: [...targets],
					};
					command.run(async (key) =>
						evaluationResponse(
							await createEvaluationExperimentV1({
								...options,
								headers: { "Idempotency-Key": key },
								body,
							}),
							EvaluationExperimentV1Schema,
						),
					);
				}}
			>
				<Label htmlFor="eval-run-version">评测版本</Label>
				<NativeSelect
					id="eval-run-version"
					value={selection}
					disabled={locked || datasets.loading}
					onChange={(e) => resetSelection(e.target.value)}
				>
					<NativeSelectOption value="">选择已导入版本</NativeSelectOption>
					{versions.map((v) => (
						<NativeSelectOption key={v.key} value={v.key}>
							{v.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
				{datasets.data && !versions.length && (
					<p>当前没有可运行的已导入版本，请先准备评测集并取得运行用途权限。</p>
				)}
				{choices.data && (
					<>
						<Label htmlFor="eval-baseline">基线</Label>
						<NativeSelect
							id="eval-baseline"
							value={baseline}
							disabled={locked}
							onChange={(e) => {
								setBaseline(e.target.value);
								setCandidates((c) => c.filter((v) => v !== e.target.value));
							}}
						>
							<NativeSelectOption value="">选择批准的基线</NativeSelectOption>
							{choices.data.variants.map((v) => (
								<NativeSelectOption key={v.variantId} value={v.variantId}>
									{v.name} · {v.modelOptionId ?? "模型未指定"} · 配置{" "}
									{v.configurationRevision}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<fieldset disabled={locked} className="space-y-2">
							<legend>候选（至少一项）</legend>
							{choices.data.variants
								.filter((v) => v.variantId !== baseline)
								.map((v) => (
									<Label
										key={v.variantId}
										className="flex min-h-11 items-center gap-3"
										htmlFor={`eval-candidate-${v.variantId}`}
									>
										<Checkbox
											id={`eval-candidate-${v.variantId}`}
											checked={candidates.includes(v.variantId)}
											onCheckedChange={(checked) =>
												setCandidates((c) =>
													checked
														? [...c, v.variantId]
														: c.filter((id) => id !== v.variantId),
												)
											}
										/>
										{v.name} · {v.modelOptionId ?? "模型未指定"} · 配置{" "}
										{v.configurationRevision} · 环境 {v.toolEnvironment}
									</Label>
								))}
						</fieldset>
						<fieldset disabled={locked} className="space-y-2">
							<legend>评分器</legend>
							{choices.data.scorers.map((s) => {
								const key = JSON.stringify([s.scorerId, s.version]);
								return (
									<Label
										key={key}
										className="flex min-h-11 items-center gap-3"
										htmlFor={`eval-scorer-${s.scorerId}-${s.version}`}
									>
										<Checkbox
											id={`eval-scorer-${s.scorerId}-${s.version}`}
											checked={scorers.includes(key)}
											onCheckedChange={(checked) =>
												setScorers((v) =>
													checked ? [...v, key] : v.filter((id) => id !== key),
												)
											}
										/>
										{s.scorerId} · {s.version} · {sourceLabels[s.source]}
										{s.scoringModel ? ` · ${s.scoringModel}` : ""} · {s.minimum}
										–{s.maximum}（通过阈值 {s.passThreshold}）
									</Label>
								);
							})}
						</fieldset>
						<fieldset disabled={locked} className="space-y-2">
							<legend>比较目标</legend>
							{(
								[
									["model", "模型"],
									["configuration", "配置"],
									["template", "模板或镜像"],
								] as const
							).map(([value, label]) => (
								<Label
									key={value}
									className="flex min-h-11 items-center gap-3"
									htmlFor={`eval-target-${value}`}
								>
									<Checkbox
										id={`eval-target-${value}`}
										checked={targets.includes(value)}
										onCheckedChange={(checked) =>
											setTargets((v) =>
												checked ? [...v, value] : v.filter((t) => t !== value),
											)
										}
									/>
									{label}
								</Label>
							))}
						</fieldset>
						<div role="note" className="rounded-lg border p-3">
							<p>
								费用归属：样本运行及模型评分使用所选 Agent 的默认
								Key，不使用个人 Key。
							</p>
							{choices.data.variants
								.filter((v) => [baseline, ...candidates].includes(v.variantId))
								.map((v) => (
									<p key={v.variantId}>
										{v.name}：Agent {v.billing.subjectId} 的默认 Key
									</p>
								))}
							<p>
								本次最多允许 {choices.data.maximumTasks}{" "}
								个样本任务，服务端会再次核对权限与限制。
							</p>
						</div>
					</>
				)}
				<Button
					type="submit"
					disabled={
						locked ||
						!choices.data ||
						!baseline ||
						!candidates.length ||
						!scorers.length ||
						!targets.length
					}
				>
					{command.busy ? "正在受理…" : "创建实验"}
				</Button>
			</form>
			<EvaluationRetry command={command} />
			{experiment && (
				<EvaluationRunProgress
					key={experiment.experimentId}
					experiment={experiment}
					onAnalyze={onAnalyze}
					onLock={setProgressLocked}
				/>
			)}
		</section>
	);
}
function EvaluationRunProgress({
	experiment,
	onAnalyze,
	onLock,
}: {
	experiment: EvaluationExperimentV1;
	onAnalyze: (id: string) => void;
	onLock: (locked: boolean) => void;
}) {
	const [cursor, setCursor] = useState<string>();
	const read = useEvaluationRead(
		useCallback(
			async (signal) =>
				evaluationResponse(
					await readEvaluationExperimentV1({
						...options,
						path: { experimentId: experiment.experimentId },
						query: { limit: 50, ...(cursor ? { cursor } : {}) },
						signal,
					}),
					EvaluationExperimentPageV1Schema,
				),
			[experiment.experimentId, cursor],
		),
	);
	const cancel = useEvaluationCommand<EvaluationExperimentV1>(async () => {
		setCursor(undefined);
		await read.reload();
	});

	useEffect(() => {
		onLock(cancel.busy || cancel.uncertain);
		return () => onLock(false);
	}, [cancel.busy, cancel.uncertain, onLock]);
	return (
		<section
			aria-label="实验执行进度"
			className="space-y-3 rounded-lg border p-4"
		>
			<h3>实验已受理</h3>
			<p className="break-all">{experiment.experimentId}</p>
			<p>
				固定样本 {experiment.sampleIds.length}，变体{" "}
				{experiment.variantIds.length}。已受理不表示质量通过。
			</p>
			<div className="flex flex-wrap gap-3">
				<Button variant="outline" onClick={() => void read.reload()}>
					刷新运行进度
				</Button>
				<Button
					variant="outline"
					onClick={() => onAnalyze(experiment.experimentId)}
				>
					查看分析
				</Button>
				<Button
					variant="outline"
					disabled={
						cancel.busy ||
						cancel.uncertain ||
						read.data?.experiment.status === "cancelled"
					}
					onClick={() =>
						cancel.run(async (key) =>
							evaluationResponse(
								await cancelEvaluationExperimentV1({
									...options,
									path: { experimentId: experiment.experimentId },
									headers: { "Idempotency-Key": key },
									body: {},
								}),
								EvaluationExperimentV1Schema,
							),
						)
					}
				>
					取消实验
				</Button>
			</div>
			<EvaluationNotice
				error={read.error || cancel.error}
				loading={read.loading}
			/>
			<EvaluationRetry command={cancel} />
			{read.data && (
				<>
					<p>
						实验状态：
						{read.data.experiment.status === "cancelled"
							? "已请求取消；已发生的外部操作不会回滚"
							: "运行中或待评分"}
					</p>
					<Table mobileLayout="cards">
						<TableHeader>
							<TableRow>
								<TableHead>样本</TableHead>
								<TableHead>变体</TableHead>
								<TableHead>任务状态</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{read.data.items.map((v) => (
								<TableRow key={v.sampleTaskId}>
									<TableCell data-label="样本">{v.sampleId}</TableCell>
									<TableCell data-label="变体">{v.variantId}</TableCell>
									<TableCell data-label="任务状态">
										{v.actual
											? taskStateLabels[v.actual.status]
											: "实际状态缺失"}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					<div className="flex flex-wrap gap-3">
						{cursor && (
							<Button variant="outline" onClick={() => setCursor(undefined)}>
								回到首批样本
							</Button>
						)}
						{read.data.nextCursor && (
							<Button
								variant="outline"
								onClick={() => setCursor(read.data?.nextCursor ?? undefined)}
							>
								下一批样本
							</Button>
						)}
					</div>
				</>
			)}
		</section>
	);
}
