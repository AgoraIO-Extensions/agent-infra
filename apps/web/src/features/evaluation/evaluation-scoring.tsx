import {
	EvaluationReviewPageV1Schema,
	EvaluationReviewV1Schema,
	EvaluationScoreMetadataV1Schema,
	EvaluationScoringContextV1Schema,
	EvaluationWorklistV1Schema,
} from "@agent-infra/contracts/pilot";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
	listEvaluationReviewsV1,
	listEvaluationWorklistV1,
	readEvaluationReviewContextV1,
	readEvaluationScoreContentV1,
	reviewEvaluationScoreV1,
	submitEvaluationHumanScoreV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import type {
	EvaluationReviewV1,
	EvaluationScoreMetadataV1,
	EvaluationScoreSubmitV1,
} from "../../pilot/generated-v2/types.gen.js";
import {
	contentLabels,
	scoreStateLabels,
	sourceLabels,
} from "./evaluation-labels.js";
import {
	EvaluationNotice,
	EvaluationRetry,
	evaluationResponse,
	evaluationRequestOptions as options,
	useEvaluationCommand,
	useEvaluationRead,
} from "./evaluation-requests.js";

export function EvaluationScoring() {
	const [purpose, setPurpose] = useState<"score" | "review">("score");
	const [cursor, setCursor] = useState<string>();
	const [selected, setSelected] = useState<string>();
	const [locked, setLocked] = useState(false);
	const list = useEvaluationRead(
		useCallback(
			async (signal) =>
				evaluationResponse(
					await listEvaluationWorklistV1({
						...options,
						query: { purpose, limit: 25, ...(cursor ? { cursor } : {}) },
						signal,
					}),
					EvaluationWorklistV1Schema,
				),
			[purpose, cursor],
		),
	);
	return (
		<section className="space-y-3" aria-labelledby="eval-scoring-heading">
			<h2 id="eval-scoring-heading">评分与独立复核</h2>
			<p>各用途独立授权；复核保存独立结论，不覆盖原评分。</p>
			<Label htmlFor="eval-purpose">工作用途</Label>
			<NativeSelect
				id="eval-purpose"
				value={purpose}
				disabled={locked}
				onChange={(e) => {
					setPurpose(e.target.value === "review" ? "review" : "score");
					setCursor(undefined);
					setSelected(undefined);
					list.clear();
				}}
			>
				<option value="score">评分</option>
				<option value="review">独立复核</option>
			</NativeSelect>
			<Button
				variant="outline"
				disabled={locked}
				onClick={() => {
					setSelected(undefined);
					void list.reload();
				}}
			>
				刷新待办
			</Button>
			<EvaluationNotice error={list.error} loading={list.loading} />
			{list.data && !list.data.items.length && <p>当前没有此用途的待办。</p>}
			<ul className="space-y-2">
				{list.data?.items.map((s) => (
					<li
						key={s.scoreId}
						className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
					>
						<span>
							{s.scorerId} · {s.scorerVersion} ·{" "}
							{s.source ? sourceLabels[s.source] : "来源未记录"}
							{s.scoringModel ? ` · ${s.scoringModel}` : ""} ·{" "}
							{scoreStateLabels[s.status]}
						</span>
						<Button
							variant="outline"
							disabled={locked}
							aria-label={`打开${purpose === "review" ? "复核" : "评分"} ${s.scoreId}`}
							onClick={() => setSelected(s.scoreId)}
						>
							打开{purpose === "review" ? "复核" : "评分"}
						</Button>
					</li>
				))}
			</ul>
			<div className="flex flex-wrap gap-3">
				{cursor && (
					<Button
						variant="outline"
						disabled={locked}
						onClick={() => {
							setCursor(undefined);
							setSelected(undefined);
						}}
					>
						返回待办首批
					</Button>
				)}
				{list.data?.nextCursor && (
					<Button
						variant="outline"
						disabled={locked}
						onClick={() => {
							setCursor(list.data?.nextCursor ?? undefined);
							setSelected(undefined);
						}}
					>
						下一批待办
					</Button>
				)}
			</div>
			{selected && (
				<ScoreEditor
					key={`${purpose}:${selected}`}
					scoreId={selected}
					purpose={purpose}
					onLock={setLocked}
				/>
			)}
		</section>
	);
}
function ScoreEditor({
	scoreId,
	purpose,
	onLock,
}: {
	scoreId: string;
	purpose: "score" | "review";
	onLock: (locked: boolean) => void;
}) {
	const [resultStatus, setResultStatus] = useState<"scored" | "not_applicable">(
		"scored",
	);
	const [value, setValue] = useState("");
	const [reason, setReason] = useState("");
	const [notice, setNotice] = useState("");
	const [historyCursor, setHistoryCursor] = useState<string>();
	const load = useCallback(
		async (signal: AbortSignal) =>
			evaluationResponse(
				await (purpose === "review"
					? readEvaluationReviewContextV1
					: readEvaluationScoreContentV1)({
					...options,
					path: { scoreId },
					signal,
				}),
				EvaluationScoringContextV1Schema,
			),
		[purpose, scoreId],
	);
	const read = useEvaluationRead(load);
	const history = useEvaluationRead(
		useCallback(
			async (signal) =>
				evaluationResponse(
					await listEvaluationReviewsV1({
						...options,
						path: { scoreId },
						query: {
							limit: 10,
							...(historyCursor ? { cursor: historyCursor } : {}),
						},
						signal,
					}),
					EvaluationReviewPageV1Schema,
				),
			[scoreId, historyCursor],
		),
		purpose === "review" && Boolean(read.data),
	);
	const command = useEvaluationCommand<
		EvaluationReviewV1 | EvaluationScoreMetadataV1
	>(async () => {
		setNotice(purpose === "review" ? "独立复核已保存。" : "人工评分已保存。");
		setReason("");
		setValue("");
		await read.reload();
		if (purpose === "review") await history.reload();
	}, `${purpose}:${scoreId}`);
	const locked = command.busy || command.uncertain;
	useEffect(() => {
		onLock(locked);
		return () => onLock(false);
	}, [locked, onLock]);
	const c = read.data;
	const maySubmit =
		c &&
		(purpose === "review"
			? ["scored", "not_applicable"].includes(c.status)
			: c.scorer.source === "human" && c.status === "awaiting_human");
	return (
		<section
			className="space-y-3 rounded-lg border p-4"
			aria-label={purpose === "review" ? "独立复核编辑" : "人工评分编辑"}
		>
			<EvaluationNotice
				error={read.error || command.error}
				loading={read.loading}
			/>
			{notice && <p role="status">{notice}</p>}
			<Button
				variant="outline"
				disabled={command.busy}
				onClick={() => {
					setNotice("");
					void read.reload();
				}}
			>
				刷新评分上下文
			</Button>
			{c && (
				<>
					<h3>
						{c.scorer.scorerId} · {c.scorer.version}
					</h3>
					<p>
						{c.scorer.source ? sourceLabels[c.scorer.source] : "来源未记录"}
						{c.scorer.scoringModel ? ` · ${c.scorer.scoringModel}` : ""} ·{" "}
						{scoreStateLabels[c.status]}
					</p>
					<dl className="space-y-2">
						<dt>样本输入</dt>
						<dd className="whitespace-pre-wrap break-words">
							{c.sample.input}
						</dd>
						{c.sample.context && (
							<>
								<dt>必要上下文</dt>
								<dd className="whitespace-pre-wrap break-words">
									{c.sample.context}
								</dd>
							</>
						)}
						<dt>预期结果</dt>
						<dd className="whitespace-pre-wrap break-words">
							{c.sample.expectedResult ?? "未提供"}
						</dd>
						<dt>判定标准</dt>
						<dd className="whitespace-pre-wrap break-words">
							{c.rubric.description}
						</dd>
						<dt>任务输出</dt>
						<dd className="whitespace-pre-wrap break-words">
							{c.output?.text ?? "输出尚不可用"}
						</dd>
					</dl>
					{c.score && (
						<section aria-label="原评分结论">
							<h4>原评分结论</h4>
							<p>{c.score.status === "scored" ? c.score.value : "不适用"}</p>
							<p className="whitespace-pre-wrap break-words">
								{c.score.reason}
							</p>
						</section>
					)}
					{maySubmit ? (
						<form
							className="space-y-3"
							onSubmit={(e) => {
								e.preventDefault();
								if (locked) return;
								const n = Number(value);
								if (
									resultStatus === "scored" &&
									(!value.trim() ||
										!Number.isFinite(n) ||
										n < c.scorer.minimum ||
										n > c.scorer.maximum)
								) {
									command.setError(
										`分数须在 ${c.scorer.minimum} 至 ${c.scorer.maximum} 之间。`,
									);
									return;
								}
								if (!reason.trim()) {
									command.setError("请填写判定依据。");
									return;
								}
								const body: EvaluationScoreSubmitV1 = {
									expectedRevision: c.revision,
									result:
										resultStatus === "scored"
											? { status: "scored", value: n, reason }
											: { status: "not_applicable", value: null, reason },
								};
								command.run(async (key) =>
									purpose === "review"
										? evaluationResponse(
												await reviewEvaluationScoreV1({
													...options,
													path: { scoreId },
													headers: { "Idempotency-Key": key },
													body,
												}),
												EvaluationReviewV1Schema,
											)
										: evaluationResponse(
												await submitEvaluationHumanScoreV1({
													...options,
													path: { scoreId },
													headers: { "Idempotency-Key": key },
													body,
												}),
												EvaluationScoreMetadataV1Schema,
											),
								);
							}}
						>
							<Label htmlFor="eval-score-result">结论类型</Label>
							<NativeSelect
								id="eval-score-result"
								value={resultStatus}
								disabled={locked}
								onChange={(e) =>
									setResultStatus(
										e.target.value === "not_applicable"
											? "not_applicable"
											: "scored",
									)
								}
							>
								<option value="scored">评分</option>
								<option value="not_applicable">不适用</option>
							</NativeSelect>
							{resultStatus === "scored" && (
								<>
									<Label htmlFor="eval-score-number">
										分数（{c.scorer.minimum}–{c.scorer.maximum}）
									</Label>
									<Input
										id="eval-score-number"
										type="number"
										min={c.scorer.minimum}
										max={c.scorer.maximum}
										step="any"
										value={value}
										disabled={locked}
										onChange={(e) => setValue(e.target.value)}
									/>
								</>
							)}
							<Label htmlFor="eval-score-reason">判定依据</Label>
							<Textarea
								id="eval-score-reason"
								value={reason}
								disabled={locked}
								maxLength={1048576}
								onChange={(e) => setReason(e.target.value)}
							/>
							<Button type="submit" disabled={locked}>
								{command.busy
									? "正在保存…"
									: purpose === "review"
										? "保存独立复核"
										: "保存人工评分"}
							</Button>
						</form>
					) : (
						<p>
							此状态不能提交{purpose === "review" ? "复核" : "人工评分"}
							，请等待任务或评分完成。
						</p>
					)}
				</>
			)}
			<EvaluationRetry command={command} />
			{purpose === "review" && (
				<section aria-label="独立复核历史">
					<h4>独立复核历史</h4>
					<EvaluationNotice error={history.error} loading={history.loading} />
					{history.data?.items.map((r) => (
						<article key={r.reviewId} className="my-2 rounded border p-3">
							<p>
								复核者 {r.reviewer.kind} · {r.reviewer.id} · 原评分修订{" "}
								{r.scoreRevision}
							</p>
							{r.contentStatus === "available" ? (
								<>
									<p>
										{r.result.status === "scored"
											? `分数 ${r.result.value}`
											: "不适用"}
									</p>
									<p className="whitespace-pre-wrap break-words">
										{r.result.reason}
									</p>
								</>
							) : (
								<p>{contentLabels[r.contentStatus]}</p>
							)}
						</article>
					))}
					{history.data && !history.data.items.length && <p>尚无独立复核。</p>}
					<div className="flex flex-wrap gap-3">
						{historyCursor && (
							<Button
								variant="outline"
								onClick={() => setHistoryCursor(undefined)}
							>
								复核历史首批
							</Button>
						)}
						{history.data?.nextCursor && (
							<Button
								variant="outline"
								onClick={() =>
									setHistoryCursor(history.data?.nextCursor ?? undefined)
								}
							>
								下一批复核
							</Button>
						)}
					</div>
				</section>
			)}
		</section>
	);
}
