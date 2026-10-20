import { Button } from "../../components/ui/button.js";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog.js";
import type { ConversationTimelineEventV2 } from "./conversation-timeline.js";

export type ModelOptionName = Readonly<{
	optionId: string;
	displayName: string;
}>;

/** 某个 Execution 的模型回退事实：只有 model.selection.fell_back 事件才产生（G-07）。 */
export type ModelFallback = Readonly<{
	requestedModel: string;
	actualModel: string;
}>;

/** 请求模型读不到时的中性文案：原选项是被 Owner 移除后才回退的，不显示内部 ID（G-07）。 */
export const removedModelOptionLabel = "已删除的模型选项";

/**
 * 回退事件带实际采用的 Owner 默认选项（modelOptionId）、推理档位和固定原因。
 * V2 事件另带服务端在回退时记录的原选项显示名，请求模型只取这一记录，不按当前清单推断；
 * 旧 V1 事件和读不到显示名的 V2 事件写「已删除的模型选项」。
 * 实际模型优先取当前模型清单的显示名，其次取同一 Execution 已采集的模型调用事实，
 * 都没有时为「未提供」；任何情况下都不显示不透明的 modelOptionId。
 */
export function modelFallbacks(
	events: readonly ConversationTimelineEventV2[],
	options: readonly ModelOptionName[],
): ReadonlyMap<string, ModelFallback> {
	const result = new Map<string, ModelFallback>();
	for (const event of events) {
		if (event.type !== "model.selection.fell_back") continue;
		const listed = options.find(
			(option) => option.optionId === event.payload.modelOptionId,
		)?.displayName;
		const observed = events.findLast(
			(candidate) =>
				candidate.type === "execution.operation" &&
				candidate.executionId === event.executionId &&
				candidate.payload.kind === "model",
		);
		const fact =
			observed?.type === "execution.operation" &&
			observed.payload.kind === "model"
				? observed.payload.model.modelId
				: undefined;
		const requested =
			event.schemaVersion === 2
				? event.payload.requestedModelDisplayName?.trim()
				: undefined;
		result.set(event.executionId, {
			requestedModel: requested || removedModelOptionLabel,
			actualModel: listed?.trim() || fact?.trim() || "未提供",
		});
	}
	return result;
}

/** 回退原因：契约只有 selection_unavailable，即会话所选模型选项已被 Owner 移除（PRD §8.2）。 */
export const modelFallbackReason =
	"会话所选的模型选项已被 Owner 移除，已在当前 Agent 允许范围内改用默认选项。";

/** 设计 #states「模型回退」弹窗：请求模型、实际模型、原因与说明（G-07）。
 * 触发器是消息卡状态行里的文字链接，关闭后焦点回到触发器。 */
export function ModelFallbackDialog({
	fallback,
	triggerLabel,
}: {
	fallback: ModelFallback;
	/** 触发器的可访问名称（同页多张回退卡时带对象名）。 */
	triggerLabel: string;
}) {
	return (
		<Dialog>
			<DialogTrigger
				render={<Button variant="link" className="inline-link" />}
				aria-label={triggerLabel}
			>
				查看模型状态
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>模型回退</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<dl className="model-fallback-facts">
						<dt>请求模型</dt>
						<dd>{fallback.requestedModel}</dd>
						<dt>实际模型</dt>
						<dd>{fallback.actualModel}</dd>
						<dt>原因</dt>
						<dd>{modelFallbackReason}</dd>
					</dl>
					<p className="model-fallback-note">
						执行记录会保留实际模型；不会静默切换到个人 Key 或未授权模型。
					</p>
				</DialogBody>
				<DialogFooter>
					<DialogClose render={<Button />}>关闭</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
