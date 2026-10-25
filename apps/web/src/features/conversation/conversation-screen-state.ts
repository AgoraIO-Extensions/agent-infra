import type { PilotProtocolErrorV1 } from "../../pilot/generated/types.gen.js";
import type {
	ConversationDetailProjectionV2,
	QueuedMessageStateV2,
} from "../../pilot/generated-v2/types.gen.js";
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
export function isTerminal(status: ExecutionStatus | undefined) {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}
type StatusEvent = Extract<
	ConversationTimelineEventV2,
	{ type: "execution.status" | "task.status" }
>;

function isStatusEvent(
	event: ConversationTimelineEventV2,
): event is StatusEvent {
	return event.type === "execution.status" || event.type === "task.status";
}

function statusReason(event: StatusEvent): string | undefined {
	return "reason" in event.payload ? event.payload.reason : undefined;
}

/**
 * 排队消息出队时，平台在交给 Runtime 前先写入不带原因的 `task.status: unknown`（投递预写），
 * Runtime 接受后再报告处理中。页面按「处理中」显示（PRD 10.5「开始处理」）；与普通消息投递中
 * 的显示一致。停止确认超时带原因，仍是待核实。
 */
function statusOf(event: StatusEvent): ExecutionStatus {
	return event.type === "task.status" &&
		event.payload.status === "unknown" &&
		statusReason(event) === undefined
		? "processing"
		: event.payload.status;
}

export function executionStatus(
	events: readonly ConversationTimelineEventV2[],
	executionId: string | null,
	fallback?: ExecutionStatus,
): ExecutionStatus | undefined {
	const last = events.findLast(
		(event): event is StatusEvent =>
			event.executionId === executionId && isStatusEvent(event),
	);
	return last ? statusOf(last) : fallback;
}

/**
 * 排队消息在页面上的状态（PRD 10.5）。`waiting` 的位次在投影之后才入队、尚未读到投影时未知。
 * 已开始处理的消息不再有排队状态，按普通回复显示。
 */
export type QueueDisplay =
	| { readonly status: "waiting"; readonly position?: number }
	| { readonly status: "withdrawn" }
	| { readonly status: "timed_out" }
	| {
			readonly status: "cancelled";
			readonly reason: Extract<
				QueuedMessageStateV2,
				{ status: "cancelled" }
			>["reason"];
	  };

/** 排队消息未开始即结束的状态事件；其他终态等投影刷新后确定。 */
function queueOutcome(event: StatusEvent): QueueDisplay | undefined {
	if (event.type !== "task.status") return undefined;
	const reason = statusReason(event);
	if (event.payload.status === "cancelled")
		return reason === "AUTHORIZATION_REVOKED"
			? { status: "cancelled", reason }
			: { status: "withdrawn" };
	if (event.payload.status !== "failed") return undefined;
	if (reason === "TASK_WAIT_TIMEOUT") return { status: "timed_out" };
	if (reason === "AGENT_UNAVAILABLE" || reason === "CONVERSATION_UNAVAILABLE")
		return { status: "cancelled", reason };
	return undefined;
}

/**
 * 按 Execution 给出排队消息的状态（工程 Spec §12.5）。投影给出位次与结果；投影之后到达的状态
 * 事件立即生效：排在前面的消息开始处理、被撤回、超时或取消后，后面的位次随之前移，投影刷新后
 * 再以服务端位次为准。
 */
export function queueStates(
	history: ConversationDetailProjectionV2 | null,
	events: readonly ConversationTimelineEventV2[],
): ReadonlyMap<string, QueueDisplay> {
	const last = new Map<string, StatusEvent>();
	for (const event of events)
		if (isStatusEvent(event)) last.set(event.executionId, event);
	const states = new Map<string, QueueDisplay>();
	const waiting: { executionId: string; position: number }[] = [];
	const projected = new Set<string>();
	for (const entry of history?.queue ?? []) {
		projected.add(entry.executionId);
		if (entry.status !== "waiting") {
			const {
				executionId: _executionId,
				messageId: _messageId,
				...state
			} = entry;
			states.set(entry.executionId, state);
			continue;
		}
		const event = last.get(entry.executionId);
		if (!event || event.payload.status === "waiting") {
			waiting.push({
				executionId: entry.executionId,
				position: entry.position,
			});
			continue;
		}
		const outcome = queueOutcome(event);
		if (outcome) states.set(entry.executionId, outcome);
	}
	waiting.sort((left, right) => left.position - right.position);
	for (const [index, { executionId }] of waiting.entries())
		states.set(executionId, { status: "waiting", position: index + 1 });
	for (const [executionId, event] of last)
		if (
			!projected.has(executionId) &&
			event.type === "task.status" &&
			event.payload.status === "waiting"
		)
			states.set(executionId, { status: "waiting" });
	return states;
}

/** 会话中仍有排队消息：重新生成、原生命令与 Skill 不进入排队（§12.5），页面不提供入口。 */
export function hasWaitingMessages(queue: ReadonlyMap<string, QueueDisplay>) {
	return [...queue.values()].some((state) => state.status === "waiting");
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
 * persisted status stream is authoritative even when an older answer is last.
 * 排队消息（仍在等待或未开始即结束）不是当前回复（§12.5）：停止、浏览器卡与回复卡只对应
 * 正在处理或刚结束的 Execution。 */
export function currentExecution(
	history: ConversationDetailProjectionV2 | null,
	events: readonly ConversationTimelineEventV2[],
	acceptedExecution?: string,
	queue: ReadonlyMap<string, QueueDisplay> = queueStates(history, events),
): { executionId: string | undefined; status: ExecutionStatus | undefined } {
	const messages = history?.messages ?? [];
	const statuses = new Map<string, ExecutionStatus>();
	const persistedStatuses = new Set<string>();
	const eventStatuses = new Map<string, ExecutionStatus>();
	const queued = (executionId: string | null | undefined) =>
		Boolean(executionId && queue.has(executionId));
	for (const message of messages) {
		// A terminal user-message status describes delivery of that message, not
		// the execution it started. Keep only its non-terminal state as a
		// candidate; assistant messages carry the execution result itself.
		if (
			message.executionId &&
			!queued(message.executionId) &&
			(message.role !== "user" || !isTerminal(message.status))
		)
			statuses.set(message.executionId, message.status);
	}
	for (const event of events) {
		if (!isStatusEvent(event) || queued(event.executionId)) continue;
		const status = statusOf(event);
		persistedStatuses.add(event.executionId);
		eventStatuses.set(event.executionId, status);
		statuses.delete(event.executionId);
		statuses.set(event.executionId, status);
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
			!queued(message.executionId) &&
			!persistedStatuses.has(message.executionId ?? ""),
	)?.executionId;
	const pendingExecution =
		acceptedExecution &&
		!queued(acceptedExecution) &&
		!persistedStatuses.has(acceptedExecution)
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
		events.findLast((event) => !queued(event.executionId))?.executionId ??
		messages.findLast(
			(message) => message.executionId && !queued(message.executionId),
		)?.executionId ??
		(queued(acceptedExecution) ? undefined : acceptedExecution);
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

/** 排队已满的繁忙提示（PRD 10.5）：说明已有几条消息在排队，建议等前面的消息处理后再发送。 */
export function queueFullText(queuedCount?: number): string {
	return queuedCount && queuedCount > 0
		? `当前会话已有 ${queuedCount} 条消息在排队，这条消息未发送，草稿已保留。请等前面的消息处理后再发送。`
		: "当前会话排队已满，这条消息未发送，草稿已保留。请等前面的消息处理后再发送。";
}

/** 排队消息在时间线上的状态说明（PRD 10.5 Web 列）。 */
export function queueStatusText(state: QueueDisplay): string {
	switch (state.status) {
		case "waiting":
			return state.position === undefined
				? "排队中"
				: `排队中（第 ${state.position} 位），前面还有 ${state.position - 1} 条消息`;
		case "withdrawn":
			return "已撤回，本条消息不再处理";
		case "timed_out":
			return "排队超时：等待超过 10 分钟仍未开始，本条消息未处理。请稍后重新发送。";
		case "cancelled":
			switch (state.reason) {
				case "AGENT_UNAVAILABLE":
					return "已取消：Agent 当前不可用，本条消息未处理。";
				case "CONVERSATION_UNAVAILABLE":
					return "已取消：当前会话不可用，本条消息未处理。你可以明确新建会话。";
				case "AUTHORIZATION_REVOKED":
					return "已取消：权限已失效，本条消息未处理。请联系 Agent Owner 或管理员。";
			}
	}
}

export function commandFailure(
	code: PilotProtocolErrorV1["code"] | undefined,
): string {
	switch (code) {
		case "AGENT_BUSY":
			return queueFullText();
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
