import {
	type ConversationEventStatusV1,
	parseConversationPersistedEventPayloadV1,
} from "./conversation-events.js";

type VisibleMessageStatusV1 = Exclude<ConversationEventStatusV1, "unknown">;

export interface ConversationReadMessageV1 {
	readonly messageId: string;
	readonly text: string;
	readonly executionId: string;
	readonly status: string;
	readonly createdAt: Date;
}

export interface ConversationReadExecutionV1 {
	readonly executionId: string;
	readonly conversationId: string;
	readonly sourceMessageId: string | null;
	readonly status: string;
	readonly updatedAt: Date;
	readonly traceId: string | null;
}

export interface ConversationReadEventV1 {
	readonly executionId: string;
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
	readonly createdAt: Date;
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
	return unavailable();
}

function messageStatus(input: string): VisibleMessageStatusV1 {
	const status = executionStatus(input);
	if (status === "unknown") return "processing";
	return status;
}

function userMessageStatus(input: string): VisibleMessageStatusV1 {
	const status = executionStatus(input);
	if (status === "unknown" || status === "failed") return unavailable();
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

export function projectConversationMessagesV1(
	input: ConversationMessageReadModelV1,
): readonly ConversationMessageProjectionV1[] {
	const userMessages = input.messages.map((item) => ({
		messageId: item.messageId,
		role: "user" as const,
		text: item.text,
		status: userMessageStatus(item.status),
		executionId: item.executionId,
		replyToMessageId: null,
		answerVersion: null,
		isCurrentAnswer: null,
		failureTraceId: null,
		createdAt: date(item.createdAt),
	}));
	const bySource = new Map<string, ConversationReadExecutionV1[]>();
	for (const execution of input.executions) {
		if (!execution.sourceMessageId) continue;
		bySource.set(execution.sourceMessageId, [
			...(bySource.get(execution.sourceMessageId) ?? []),
			execution,
		]);
	}
	const answers = [...bySource.entries()].flatMap(([sourceMessageId, items]) =>
		items.flatMap((item, index) => {
			const events = input.events.filter(
				(event) => event.executionId === item.executionId,
			);
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
	const processSummary =
		input.events.flatMap<ConversationExecutionProcessSummaryV1>((item) => {
			if (
				item.eventType !== "execution.status" &&
				item.eventType !== "execution.detail"
			) {
				return [];
			}
			const payload = eventPayload(item);
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
