import type { PilotProtocolErrorV1 } from "../../pilot/generated/types.gen.js";
import type {
	ConversationDetailProjectionV2,
	PersistedConversationEventV2,
} from "../../pilot/generated-v2/types.gen.js";

export const executionStatusLabels = {
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
export function executionStatus(
	events: readonly PersistedConversationEventV2[],
	executionId: string | null,
	fallback?: ExecutionStatus,
): ExecutionStatus | undefined {
	const last = events.findLast(
		(event) =>
			event.executionId === executionId && event.type === "execution.status",
	);
	return last?.type === "execution.status" ? last.payload.status : fallback;
}

/** Answer projections can omit an execution until its first text delta. The
 * persisted status stream is authoritative even when an older answer is last. */
export function currentExecution(
	history: ConversationDetailProjectionV2 | null,
	events: readonly PersistedConversationEventV2[],
	acceptedExecution?: string,
) {
	const messages = history?.messages ?? [];
	const statuses = new Map<string, ExecutionStatus>();
	for (const message of messages) {
		if (message.role === "assistant" && message.executionId)
			statuses.set(message.executionId, message.status);
	}
	for (const event of events) {
		if (event.type !== "execution.status") continue;
		statuses.delete(event.executionId);
		statuses.set(event.executionId, event.payload.status);
	}
	// A new receipt bridges the interval before its execution appears in a read.
	// Once observed, it must not shadow a newer persisted execution indefinitely.
	if (
		acceptedExecution &&
		!events.some((event) => event.executionId === acceptedExecution) &&
		!messages.some((message) => message.executionId === acceptedExecution)
	)
		return { executionId: acceptedExecution, status: "submitted" as const };
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
	events: readonly PersistedConversationEventV2[],
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

export function commandFailure(code: PilotProtocolErrorV1["code"]): string {
	switch (code) {
		case "AGENT_BUSY":
			return "当前回复仍在处理，暂不支持补充指令。草稿已保留。";
		case "AGENT_STARTING":
			return "Agent 正在启动，历史只读。请稍后刷新。";
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
			return "模型服务限流或额度不足，请稍后重试或联系 Owner。";
		case "PROVIDER_REJECTED":
			return "模型请求被拒绝，请联系 Owner 检查模型配置。";
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
