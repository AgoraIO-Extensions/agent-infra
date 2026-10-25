import {
	type ExecutionProgressPhaseV1,
	executionProgressPhaseV1,
	executionToolDisplayNameV1,
} from "@agent-infra/contracts/pilot";
import type { PilotProtocolErrorV1 } from "../../pilot/generated/types.gen.js";
import type { ConversationDetailProjectionV2 } from "../../pilot/generated-v2/types.gen.js";
import type { ConversationTimelineEventV2 } from "./conversation-timeline.js";

export const executionStatusLabels = {
	waiting: "等待处理",
	submitted: "已受理，等待处理",
	processing: "处理中",
	completed: "已完成",
	failed: "执行失败",
	cancelled: "已停止",
	unknown: "执行结果待核实",
} as const;
export type ExecutionStatus = keyof typeof executionStatusLabels;

/**
 * #3377（PRD 11.2）：回复处理期间的阶段。与企微进度帧使用同一个 Contract 推导，只取该执行
 * 已持久的状态事件与实际模型/工具事实，没有事实时退回已持久的执行状态，不按时间推测。
 */
export function executionPhase(
	events: readonly ConversationTimelineEventV2[],
	executionId: string | null,
	status: ExecutionStatus | undefined,
): ExecutionProgressPhaseV1 | null {
	if (!executionId) return null;
	return executionProgressPhaseV1(
		events.filter((event) => event.executionId === executionId),
		status,
	);
}

/** 阶段名与企微阶段行一致；工具只显示展示名，不含参数或结果。 */
export function executionPhaseLabel(phase: ExecutionProgressPhaseV1): string {
	switch (phase.kind) {
		case "queued":
			return "排队中";
		case "preparing":
			return "准备会话";
		case "running":
			return "执行中";
		case "tool":
			return `调用工具：${executionToolDisplayNameV1(phase.toolId)}`;
		case "model_retry":
			return "模型重试";
	}
}

/** 已用时长的显示：与企微阶段行相同，按整秒计。 */
export function elapsedSecondsLabel(since: string, now: Date): string | null {
	const started = Date.parse(since);
	if (!Number.isFinite(started)) return null;
	return `已用 ${Math.max(0, Math.floor((now.getTime() - started) / 1000))} 秒`;
}
export function isTerminal(status: ExecutionStatus | undefined) {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}
export function executionStatus(
	events: readonly ConversationTimelineEventV2[],
	executionId: string | null,
	fallback?: ExecutionStatus,
): ExecutionStatus | undefined {
	const last = events.findLast(
		(event) =>
			event.executionId === executionId &&
			(event.type === "execution.status" || event.type === "task.status"),
	);
	return last?.type === "execution.status" || last?.type === "task.status"
		? last.payload.status
		: fallback;
}

/** A stored terminal answer result is final even when the timeline lacks its
 * terminal event; a later terminal event still wins (#1524). */
export function answerStatus(
	events: readonly ConversationTimelineEventV2[],
	executionId: string | null,
	stored: ExecutionStatus,
): ExecutionStatus | undefined {
	const status = executionStatus(events, executionId, stored);
	return isTerminal(stored) && !isTerminal(status) ? stored : status;
}

/** Answer projections can omit an execution until its first text delta. The
 * persisted status stream is authoritative even when an older answer is last. */
export function currentExecution(
	history: ConversationDetailProjectionV2 | null,
	events: readonly ConversationTimelineEventV2[],
	acceptedExecution?: string,
): { executionId: string | undefined; status: ExecutionStatus | undefined } {
	const messages = history?.messages ?? [];
	const statuses = new Map<string, ExecutionStatus>();
	const persistedStatuses = new Set<string>();
	const eventStatuses = new Map<string, ExecutionStatus>();
	for (const message of messages) {
		// A terminal user-message status describes delivery of that message, not
		// the execution it started. Keep only its non-terminal state as a
		// candidate; assistant messages carry the execution result itself.
		if (
			message.executionId &&
			(message.role !== "user" || !isTerminal(message.status))
		)
			statuses.set(message.executionId, message.status);
	}
	for (const event of events) {
		if (event.type !== "execution.status" && event.type !== "task.status")
			continue;
		persistedStatuses.add(event.executionId);
		eventStatuses.set(event.executionId, event.payload.status);
		statuses.delete(event.executionId);
		statuses.set(event.executionId, event.payload.status);
	}
	// The projection reads each assistant result from the stored execution. A
	// terminal result is final even when its terminal event is missing, such as
	// a Turn cancelled before the Runtime accepted it (#1524).
	for (const message of messages) {
		if (
			message.role === "assistant" &&
			message.executionId &&
			isTerminal(message.status) &&
			!isTerminal(eventStatuses.get(message.executionId))
		) {
			persistedStatuses.add(message.executionId);
			statuses.delete(message.executionId);
			statuses.set(message.executionId, message.status);
		}
	}
	// A new receipt remains authoritative until its persisted execution status is
	// observed. After a reload, reconstruct that pending state from the latest
	// submitted user message so an older active event cannot take over.
	const persistedAcceptedExecution = messages.findLast(
		(message) =>
			message.role === "user" &&
			message.status === "submitted" &&
			Boolean(message.executionId) &&
			!persistedStatuses.has(message.executionId ?? ""),
	)?.executionId;
	const pendingExecution =
		acceptedExecution && !persistedStatuses.has(acceptedExecution)
			? acceptedExecution
			: persistedAcceptedExecution;
	if (pendingExecution)
		return {
			executionId: pendingExecution,
			status: "submitted",
		};
	const active = [...statuses].findLast(([, status]) => !isTerminal(status));
	if (active) return { executionId: active[0], status: active[1] };
	const executionId =
		events.at(-1)?.executionId ??
		messages.findLast((message) => message.executionId)?.executionId ??
		acceptedExecution;
	return {
		executionId,
		status: executionId
			? (statuses.get(executionId) ??
				(history?.conversation.status === "active" ? "submitted" : "unknown"))
			: undefined,
	};
}

/** Projection text already contains its persisted deltas. Append only events
 * arriving after that projection, never render both the snapshot and its replay. */
export function answerText(
	history: ConversationDetailProjectionV2,
	events: readonly ConversationTimelineEventV2[],
	executionId: string,
	text: string,
) {
	const snapshotIds = new Set(history.events.map((event) => event.eventId));
	return (
		text +
		events
			.filter(
				(event) =>
					event.executionId === executionId &&
					event.type === "text.delta" &&
					!snapshotIds.has(event.eventId),
			)
			.map((event) => (event.type === "text.delta" ? event.payload.text : ""))
			.join("")
	);
}

/**
 * #2981：每个 Execution 的思考过程（PRD §11.2）。思考没有投影文本，只来自时间线事件；
 * 时间线已按 eventId 去重，所以首屏、实时与更早页合在一起也不会重复。摘要与原始推理
 * 各自按到达顺序拼接（Runtime 只在同一 kind 的分段之间加空行），两者都有时先摘要、后原始推理。
 */
export function reasoningTexts(
	events: readonly ConversationTimelineEventV2[],
): ReadonlyMap<string, string> {
	const parts = new Map<string, { summary: string[]; raw: string[] }>();
	for (const event of events) {
		if (event.type !== "reasoning.delta") continue;
		let entry = parts.get(event.executionId);
		if (!entry) {
			entry = { summary: [], raw: [] };
			parts.set(event.executionId, entry);
		}
		entry[event.payload.kind].push(event.payload.text);
	}
	const texts = new Map<string, string>();
	for (const [executionId, { summary, raw }] of parts)
		texts.set(
			executionId,
			[summary.join(""), raw.join("")].filter(Boolean).join("\n\n"),
		);
	return texts;
}

export const answerNotWrittenYet = "尚未输出正文。";

/**
 * 回复没有正文时的判定。会话详情只返回最近一个事件窗口，窗口之外的 Execution 没有任何已加载
 * 的事件，它们的正文要「加载更早内容」才有（#2635）。只有已完成、窗口里确实没有它的任何事件、
 * 并且还有更早内容时才判定为 not_loaded；失败、已停止和进行中的回复不提示可加载（NW-15）。
 * 文案与入口由消息卡决定。
 */
export function emptyAnswerKind(
	history: ConversationDetailProjectionV2,
	events: readonly ConversationTimelineEventV2[],
	executionId: string | null,
	status: ExecutionStatus | undefined,
	hasEarlier: boolean,
): "not_loaded" | "empty" {
	if (!hasEarlier || executionId === null || status !== "completed")
		return "empty";
	const loaded = (list: readonly ConversationTimelineEventV2[]) =>
		list.some((event) => event.executionId === executionId);
	return loaded(history.events) || loaded(events) ? "empty" : "not_loaded";
}

export function commandFailure(
	code: PilotProtocolErrorV1["code"] | undefined,
): string {
	switch (code) {
		case "AGENT_BUSY":
			return "当前回复仍在处理，暂不支持补充指令。草稿已保留。";
		case "AGENT_STARTING":
			return "会话尚未准备完成，消息未发送，草稿已保留。准备完成后请重新发送。";
		case "AGENT_UPDATING":
			return "Agent 正在更新，历史只读。请稍后刷新。";
		case "CONVERSATION_UNAVAILABLE":
			return "当前会话不可用，历史只读。你可以明确新建会话。";
		case "ORIGINAL_RESPONSE_NOT_STARTED":
			return "投递失败：原回复未开始。";
		case "ORIGINAL_RESPONSE_ALREADY_FINISHED":
			return "投递失败：原回复已结束。";
		case "AUTHORIZATION_REVOKED":
			return "投递失败：权限已失效。";
		case "AUTHENTICATION_REQUIRED":
			return "请重新登录。";
		case "MODEL_SELECTION_INVALID":
			return "模型选项已变化，请刷新模型清单后重新选择。";
		case "PROVIDER_RATE_LIMITED":
			return "模型服务限流或额度不足。使用标准模板时，请检查个人 Relay Key 的额度；可稍后重试，仍失败请联系 Owner 检查模型配置。";
		case "PROVIDER_REJECTED":
			return "模型请求被拒绝。使用标准模板时，请检查个人 Relay Key 是否可用、是否有权调用所选模型；仍失败请联系 Owner 检查模型配置。";
		case "CONNECTION_AUTHORIZATION_REQUIRED":
			return "请在独立 Connection 中完成当前账号的授权。";
		case "CONNECTION_UNAVAILABLE":
			return "Connection 暂时不可用，请稍后重试。";
		case "RUNTIME_UNAVAILABLE":
			return "Agent 暂时不可用，请稍后重试或联系 Owner。";
		case "RESOURCE_UNAVAILABLE":
			return "当前 Agent 不可用，历史保持只读。";
		case "INVALID_REQUEST":
			return "无法提交，请检查输入。";
		default:
			return "请求未完成，请稍后重试或联系 Owner。";
	}
}
