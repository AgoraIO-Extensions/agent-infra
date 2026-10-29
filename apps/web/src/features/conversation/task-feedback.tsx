import {
	TaskFeedbackContextV1Schema,
	TaskFeedbackRecordV1Schema,
} from "@agent-infra/contracts/pilot";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { withObjectName } from "../../lib/accessible-name.js";
import {
	readTaskFeedbackV1,
	submitTaskFeedbackV1,
} from "../../pilot/generated-v2/sdk.gen.js";
import type { TaskFeedbackRecordV1 } from "../../pilot/generated-v2/types.gen.js";
import { feedbackLabels } from "../evaluation/evaluation-labels.js";
import {
	EvaluationNotice,
	EvaluationRetry,
	evaluationResponse,
	evaluationRequestOptions as options,
	useEvaluationCommand,
	useEvaluationRead,
} from "../evaluation/evaluation-requests.js";

type TaskFeedbackCategoryV1 = TaskFeedbackRecordV1["categories"][number];

/** The Execution comes from the rendered reply version; the server owns eligibility and subject identity. */
export function TaskFeedback({
	executionId,
	objectName,
	disabled = false,
}: {
	executionId: string;
	objectName?: string;
	disabled?: boolean;
}) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const [useful, setUseful] = useState<boolean | null>(null);
	const [categories, setCategories] = useState<TaskFeedbackCategoryV1[] | null>(
		null,
	);
	const [notice, setNotice] = useState("");
	useEffect(() => {
		if (disabled) {
			setOpen(false);
			setUseful(null);
			setCategories(null);
			setNotice("");
		}
	}, [disabled]);

	const load = useCallback(
		async (signal: AbortSignal) =>
			evaluationResponse(
				await readTaskFeedbackV1({ ...options, path: { executionId }, signal }),
				TaskFeedbackContextV1Schema,
			),
		[executionId],
	);
	const read = useEvaluationRead(load, open && !disabled);
	const command = useEvaluationCommand<TaskFeedbackRecordV1>(async () => {
		setNotice("反馈已保存。");
		setUseful(null);
		setCategories(null);
		await read.reload();
	}, `${executionId}:${disabled}`);
	const context = read.data;
	const active = useful ?? context?.feedback?.useful ?? null;
	const selected = categories ?? context?.feedback?.categories ?? [];
	const locked = command.busy || command.uncertain;
	return (
		<div className="mt-2 space-y-3">
			<Button
				type="button"
				variant="link"
				className="inline-link"
				aria-label={withObjectName("任务反馈", objectName)}
				aria-expanded={open}
				aria-controls={id}
				disabled={disabled}
				onClick={() => {
					if (locked) return;
					setOpen(!open);
					setNotice("");
					setUseful(null);
					setCategories(null);
				}}
			>
				任务反馈
			</Button>
			{open && !disabled && (
				<section
					id={id}
					aria-label={withObjectName("本人任务反馈", objectName)}
					className="space-y-3 rounded-lg border p-3"
				>
					<p>仅评价这一次任务，未反馈不表示认可。</p>
					<EvaluationNotice
						loading={read.loading}
						error={read.error || command.error}
					/>
					{notice && <p role="status">{notice}</p>}
					<Button
						variant="outline"
						disabled={command.busy}
						onClick={() => {
							setUseful(null);
							setCategories(null);
							setNotice("");
							void read.reload();
						}}
					>
						刷新反馈
					</Button>
					{context?.eligibility === "not_terminal" && (
						<p>任务尚未确认结束，暂不可反馈。</p>
					)}
					{context?.eligibility === "offline_evaluation" && (
						<p>离线实验使用独立评分，不计入线上反馈。</p>
					)}
					{context?.eligibility === "eligible" && (
						<form
							className="space-y-3"
							onSubmit={(e) => {
								e.preventDefault();
								if (active === null || locked) return;
								const body = {
									expectedRevision: context.revision,
									expectedCondition: context.conditionDigest,
									useful: active,
									categories: [...selected],
								};
								command.run(async (key) =>
									evaluationResponse(
										await submitTaskFeedbackV1({
											...options,
											path: { executionId },
											headers: { "Idempotency-Key": key },
											body,
										}),
										TaskFeedbackRecordV1Schema,
									),
								);
							}}
						>
							<p className="break-words">
								实际条件：
								{context.conditions.length
									? context.conditions
											.map(
												(c) =>
													`${c.modelId} / 配置 ${c.configVersion} / ${c.reasoningLevel ?? "推理档位缺失"}`,
											)
											.join("；")
									: "未记录"}
							</p>
							{context.feedback && !context.feedbackCurrent && (
								<p role="status">实际条件已变化，请重新确认后更新反馈。</p>
							)}
							{context.terminalObservedAt === null && (
								<p>历史终态时间缺失：可以反馈，但不会虚构所属统计窗口。</p>
							)}
							<fieldset disabled={locked} className="space-y-3">
								<legend>这次任务是否有用？</legend>
								<div className="flex flex-wrap gap-3">
									{[true, false].map((value) => (
										<Button
											key={String(value)}
											type="button"
											variant={active === value ? "default" : "outline"}
											aria-pressed={active === value}
											onClick={() => {
												setUseful(value);
												setCategories([...selected]);
											}}
										>
											{value ? "有用" : "无用"}
										</Button>
									))}
								</div>
								<fieldset className="grid gap-3 sm:grid-cols-2">
									<legend>问题分类（可选）</legend>
									{context.categories.map((category) => (
										<Label
											key={category}
											className="flex min-h-11 items-center gap-3"
											htmlFor={`${id}-${category}`}
										>
											<Checkbox
												id={`${id}-${category}`}
												checked={selected.includes(category)}
												onCheckedChange={(checked) => {
													setUseful(active);
													setCategories(
														checked
															? [...selected, category]
															: selected.filter((v) => v !== category),
													);
												}}
											/>
											{feedbackLabels[category]}
										</Label>
									))}
								</fieldset>
							</fieldset>
							<Button type="submit" disabled={locked || active === null}>
								{command.busy
									? "正在保存…"
									: context.feedback
										? "更新反馈"
										: "提交反馈"}
							</Button>
						</form>
					)}
					<EvaluationRetry command={command} />
					<Button
						variant="ghost"
						disabled={locked}
						onClick={() => {
							setOpen(false);
							read.clear();
						}}
					>
						关闭反馈
					</Button>
				</section>
			)}
		</div>
	);
}
