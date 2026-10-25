import {
	type ConversationEventStatusV1,
	parseConversationPersistedEventPayloadV1,
} from "./conversation-events.js";
import { conversationQueuePositionV1 } from "./conversation-queue.js";

type VisibleMessageStatusV1 = Exclude<ConversationEventStatusV1, "unknown">;

export interface ConversationReadMessageV1 {
	readonly messageId: string;
	readonly text: string;
	readonly executionId: string;
	readonly status: string;
	readonly failureCode?: string | null;
	readonly createdAt: Date;
}

export interface ConversationReadExecutionV1 {
	readonly executionId: string;
	readonly conversationId: string;
	readonly sourceMessageId: string | null;
	readonly status: string;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly traceId: string | null;
	/** 经排队受理的 Execution 保存的等待顺序（§12.5）；其他 Execution 为 null 或缺省。 */
	readonly taskWaitOrder?: number | null;
}

/**
 * 排队消息在时间线上的状态（工程 Spec §12.5）。位次从持久等待顺序派生；开始处理后不再带此状态。
 */
export type ConversationMessageQueueStateV1 =
	| { readonly status: "waiting"; readonly position: number }
	| { readonly status: "withdrawn" }
	| { readonly status: "timed_out" }
	| {
			readonly status: "cancelled";
			readonly reason:
				| "AGENT_UNAVAILABLE"
				| "CONVERSATION_UNAVAILABLE"
				| "AUTHORIZATION_REVOKED";
	  };

export interface ConversationReadEventV1 {
	readonly executionId: string;
	readonly sequence: number;
	readonly eventType: string;
	readonly eventPayload: unknown;
	readonly occurredAt: Date;
}

export interface ConversationMessageReadModelV1 {
	readonly messages: readonly ConversationReadMessageV1[];
	readonly executions: readonly ConversationReadExecutionV1[];
	readonly events: readonly ConversationReadEventV1[];
}

export interface ConversationMessageProjectionV1 {
	readonly messageId: string;
	readonly role: "user" | "assistant";
	readonly text: string;
	readonly status: VisibleMessageStatusV1;
	readonly executionId: string;
	readonly replyToMessageId: string | null;
	readonly answerVersion: number | null;
	readonly isCurrentAnswer: boolean | null;
	readonly failureTraceId: string | null;
	readonly failureCode:
		| "EXECUTION_FAILED"
		| "AUTHORIZATION_REVOKED"
		| "ORIGINAL_RESPONSE_NOT_STARTED"
		| "ORIGINAL_RESPONSE_ALREADY_FINISHED"
		| null;
	readonly createdAt: Date;
	/** 只出现在经排队受理、尚未开始处理或未开始即结束的用户消息上。 */
	readonly queue?: ConversationMessageQueueStateV1;
}

export interface ConversationExecutionReadModelV1 {
	readonly execution: ConversationReadExecutionV1;
	readonly events: readonly ConversationReadEventV1[];
}

export type ConversationExecutionProcessSummaryV1 =
	| {
			readonly occurredAt: Date;
			readonly kind: "status";
			readonly status: ConversationEventStatusV1;
			readonly summary: string;
	  }
	| {
			readonly occurredAt: Date;
			readonly kind: "agent_summary";
			readonly category: "status" | "model_call" | "connection_call";
			readonly summary: string;
			readonly callId?: string;
	  };

export interface ConversationExecutionProjectionV1 {
	readonly executionId: string;
	readonly conversationId: string;
	readonly status: ConversationEventStatusV1;
	readonly processSummary: readonly ConversationExecutionProcessSummaryV1[];
	readonly startedAt: Date | null;
	readonly finishedAt: Date | null;
	readonly failureTraceId: string | null;
}

function unavailable(): never {
	throw new Error("Conversation read projection is unavailable");
}

function executionStatus(input: string): ConversationEventStatusV1 {
	if (
		input === "submitted" ||
		input === "processing" ||
		input === "completed" ||
		input === "failed" ||
		input === "cancelled" ||
		input === "unknown"
	) {
		return input;
	}
	// 排队中的 Execution 尚未投递，按已受理、等待处理投影；位次见消息的 queue 状态。
	if (input === "waiting") return "submitted";
	return unavailable();
}

/** 排队消息未开始即结束时写在用户消息上的原因（finishWaitingTask）。 */
const queueFailureCodes = new Set([
	"TASK_WAIT_TIMEOUT",
	"AGENT_UNAVAILABLE",
	"CONVERSATION_UNAVAILABLE",
	"AUTHORIZATION_REVOKED",
	"WITHDRAWN",
	"TASK_CANCELLED",
]);

function queueOutcome(
	failureCode: string,
): Exclude<ConversationMessageQueueStateV1, { status: "waiting" }> {
	switch (failureCode) {
		case "TASK_WAIT_TIMEOUT":
			return { status: "timed_out" };
		case "WITHDRAWN":
		case "TASK_CANCELLED":
			return { status: "withdrawn" };
		case "AGENT_UNAVAILABLE":
		case "CONVERSATION_UNAVAILABLE":
		case "AUTHORIZATION_REVOKED":
			return { status: "cancelled", reason: failureCode };
		default:
			return unavailable();
	}
}

function messageStatus(input: string): VisibleMessageStatusV1 {
	const status = executionStatus(input);
	if (status === "unknown") return "processing";
	return status;
}

function userMessageStatus(input: string): VisibleMessageStatusV1 {
	const status = executionStatus(input);
	if (status === "unknown") return unavailable();
	return status;
}

function isTerminalStatus(input: ConversationEventStatusV1): boolean {
	return input === "completed" || input === "failed" || input === "cancelled";
}

function date(input: Date): Date {
	const milliseconds = Date.prototype.getTime.call(input);
	if (!Number.isFinite(milliseconds)) return unavailable();
	return new Date(milliseconds);
}

function failureTraceId(
	status: ConversationEventStatusV1,
	traceId: string | null,
): string | null {
	if (status !== "failed") return null;
	if (typeof traceId !== "string" || traceId.length === 0) return unavailable();
	return traceId;
}

function eventPayload(input: ConversationReadEventV1) {
	const payload = parseConversationPersistedEventPayloadV1(input.eventPayload);
	if (payload.type !== input.eventType) return unavailable();
	return payload;
}

function eventSequence(input: ConversationReadEventV1): number {
	if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
		return unavailable();
	}
	return input.sequence;
}

export function projectConversationMessagesV1(
	input: ConversationMessageReadModelV1,
): readonly ConversationMessageProjectionV1[] {
	const traceByExecution = new Map(
		input.executions.map(({ executionId, traceId }) => [executionId, traceId]),
	);
	const executionById = new Map(
		input.executions.map((execution) => [execution.executionId, execution]),
	);
	const waitingOrders = input.executions.flatMap((execution) =>
		execution.status === "waiting" &&
		typeof execution.taskWaitOrder === "number"
			? [execution.taskWaitOrder]
			: [],
	);
	/** 排队消息自身（Execution 的来源消息）在未开始前的状态；补充指令等其他消息不带。 */
	const queueState = (
		item: ConversationReadMessageV1,
	): ConversationMessageQueueStateV1 | undefined => {
		const execution = executionById.get(item.executionId);
		if (
			!execution ||
			execution.taskWaitOrder === null ||
			execution.taskWaitOrder === undefined ||
			execution.sourceMessageId !== item.messageId
		)
			return undefined;
		if (execution.status === "waiting") {
			if (item.status !== "submitted") return unavailable();
			return {
				status: "waiting",
				position: conversationQueuePositionV1(
					execution.taskWaitOrder,
					waitingOrders,
				),
			};
		}
		if (
			item.status === "failed" &&
			queueFailureCodes.has(item.failureCode ?? "")
		)
			return queueOutcome(item.failureCode as string);
		return undefined;
	};
	const neverStarted = new Set<string>();
	const userMessages = input.messages.map((item) => {
		const queue = queueState(item);
		if (queue && queue.status !== "waiting") neverStarted.add(item.executionId);
		// 撤回与取消排队不是失败；超时与其他原因按失败投影，具体结果见 queue。
		const status =
			queue?.status === "withdrawn"
				? ("cancelled" as const)
				: userMessageStatus(item.status);
		const failureCode: ConversationMessageProjectionV1["failureCode"] =
			status === "failed" &&
			(item.failureCode === "EXECUTION_FAILED" ||
				item.failureCode === "AUTHORIZATION_REVOKED" ||
				item.failureCode === "ORIGINAL_RESPONSE_NOT_STARTED" ||
				item.failureCode === "ORIGINAL_RESPONSE_ALREADY_FINISHED")
				? item.failureCode
				: status === "failed" && queue
					? "EXECUTION_FAILED"
					: null;
		if (
			(status === "failed") !== (failureCode !== null) ||
			(status !== "failed" && item.failureCode != null && !queue)
		) {
			return unavailable();
		}
		return {
			messageId: item.messageId,
			role: "user" as const,
			text: item.text,
			status,
			executionId: item.executionId,
			replyToMessageId: null,
			answerVersion: null,
			isCurrentAnswer: null,
			failureTraceId: failureTraceId(
				status,
				traceByExecution.get(item.executionId) ?? null,
			),
			failureCode,
			createdAt: date(item.createdAt),
			...(queue ? { queue } : {}),
		};
	});
	const bySource = new Map<string, ConversationReadExecutionV1[]>();
	for (const execution of input.executions) {
		if (!execution.sourceMessageId) continue;
		const items = bySource.get(execution.sourceMessageId);
		if (items) items.push(execution);
		else bySource.set(execution.sourceMessageId, [execution]);
	}
	for (const items of bySource.values()) {
		items.sort(
			(left, right) =>
				date(left.createdAt).getTime() - date(right.createdAt).getTime() ||
				left.executionId.localeCompare(right.executionId),
		);
	}
	const byExecution = new Map<string, ConversationReadEventV1[]>();
	for (const event of input.events) {
		const events = byExecution.get(event.executionId);
		if (events) events.push(event);
		else byExecution.set(event.executionId, [event]);
	}
	for (const events of byExecution.values()) {
		events.sort((left, right) => eventSequence(left) - eventSequence(right));
	}
	const answers = [...bySource.entries()].flatMap(([sourceMessageId, items]) =>
		items.flatMap((item, index) => {
			// 未开始即结束的排队消息没有回复；结果只显示在用户消息的 queue 状态上。
			if (neverStarted.has(item.executionId)) return [];
			const events = byExecution.get(item.executionId) ?? [];
			const text = events
				.filter((event) => event.eventType === "text.delta")
				.map((event) => {
					const payload = eventPayload(event);
					if (payload.type !== "text.delta") return unavailable();
					return payload.text;
				})
				.join("");
			const status = executionStatus(item.status);
			if (text.length === 0 && !isTerminalStatus(status)) {
				return [];
			}
			return [
				{
					messageId: `assistant:${item.executionId}`,
					role: "assistant" as const,
					text,
					status: messageStatus(status),
					executionId: item.executionId,
					replyToMessageId: sourceMessageId,
					answerVersion: index + 1,
					isCurrentAnswer: index === items.length - 1,
					failureTraceId: failureTraceId(status, item.traceId),
					failureCode: null,
					createdAt: date(events[0]?.occurredAt ?? item.updatedAt),
				},
			];
		}),
	);
	return [...userMessages, ...answers].toSorted(
		(left, right) =>
			left.createdAt.getTime() - right.createdAt.getTime() ||
			left.messageId.localeCompare(right.messageId),
	);
}

export function projectConversationExecutionV1(
	input: ConversationExecutionReadModelV1,
): ConversationExecutionProjectionV1 {
	const status = executionStatus(input.execution.status);
	const processSummary = input.events
		.toSorted((left, right) => eventSequence(left) - eventSequence(right))
		.flatMap<ConversationExecutionProcessSummaryV1>((item) => {
			if (
				item.eventType !== "execution.status" &&
				item.eventType !== "execution.detail" &&
				item.eventType !== "browser.handoff"
			) {
				return [];
			}
			const payload = eventPayload(item);
			if (payload.type === "browser.handoff") {
				return [
					{
						occurredAt: date(item.occurredAt),
						kind: "agent_summary" as const,
						category: "status" as const,
						summary: `Browser handoff ${payload.status} (${payload.reason}).`,
						callId: payload.handoffId,
					},
				];
			}
			if (payload.type === "execution.detail") {
				return [
					{
						occurredAt: date(item.occurredAt),
						kind: "agent_summary" as const,
						category: payload.category,
						summary: payload.summary,
						...(payload.callId === undefined ? {} : { callId: payload.callId }),
					},
				];
			}
			if (payload.type !== "execution.status") return unavailable();
			const eventStatus = executionStatus(payload.status);
			return [
				{
					occurredAt: date(item.occurredAt),
					kind: "status" as const,
					status: eventStatus,
					summary: `Execution ${eventStatus}.`,
				},
			];
		});
	return {
		executionId: input.execution.executionId,
		conversationId: input.execution.conversationId,
		status,
		processSummary,
		startedAt:
			processSummary.find(
				(item) => item.kind === "status" && item.status === "processing",
			)?.occurredAt ?? null,
		finishedAt:
			processSummary.find(
				(item) => item.kind === "status" && isTerminalStatus(item.status),
			)?.occurredAt ?? null,
		failureTraceId: failureTraceId(status, input.execution.traceId),
	};
}
