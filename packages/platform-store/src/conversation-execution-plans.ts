import type {
	ConversationExecutionAuthorityV1,
	ConversationExecutionConversationStateV1,
	ConversationExecutionStateV1,
	ConversationMessageWritePlanV1,
	ConversationModelSelectionFallbackWriteV1,
	ConversationModelSelectionWritePlanV1,
	ConversationRegenerationWritePlanV1,
	ConversationStopDecisionV1,
	ConversationStopWritePlanV1,
	CreateConversationWritePlanV1,
} from "@agent-infra/platform-core";
import { conversationStopConfirmationTimeoutMsV1 } from "@agent-infra/platform-core";
import {
	type CreateRequest,
	exactRecord,
	type MessageRequest,
	type ModelSelectionRequest,
	type RegenerationRequest,
	type StopRequest,
	sameDate,
	text,
	unavailable,
} from "./conversation-execution-common.js";
import {
	parseExecution,
	parseMessage,
	parseMessageAudit,
	parseMessageOutbox,
	parseModelSelectionAudit,
	parseModelSelectionFallback,
	parseRegenerationAudit,
	parseRegenerationOutbox,
	parseStopAudit,
	parseStopOutbox,
} from "./conversation-execution-payloads.js";
import {
	conversationSelectionMatchesConfigurationShape,
	modelSelectionMatchesConfigurationRevision,
	parseAuthority,
	parseConversation,
	parseCreatedResult,
	parseIdempotency,
	parseMessageResult,
	parseModelSelectionResult,
	parseRegenerationResult,
	parseStopResult,
	sameModelSelection,
} from "./conversation-execution-records.js";

function validateModelSelectionFallback(
	fallback: ConversationModelSelectionFallbackWriteV1 | null,
	input: {
		readonly state: ConversationExecutionStateV1;
		readonly conversation: ConversationExecutionConversationStateV1;
		readonly authority: ConversationExecutionAuthorityV1;
		readonly requestId: string;
		readonly traceId: string;
		readonly occurredAt: Date;
		readonly executionId: string;
		readonly lastEventSequence: number;
	},
): void {
	const current = input.state.conversation;
	if (
		!current ||
		input.conversation.lastConversationCursor !==
			current.lastConversationCursor + (fallback ? 1 : 0)
	) {
		unavailable();
	}
	if (!fallback) return;
	const configuration = input.state.modelConfiguration;
	if (
		!configuration ||
		fallback.previousModelOptionId !== current.selectedModelOptionId ||
		fallback.previousReasoningLevel !== current.selectedReasoningLevel ||
		fallback.modelConfigurationRevision !==
			configuration.configurationRevision ||
		fallback.modelOptionId !== input.conversation.selectedModelOptionId ||
		fallback.reasoningLevel !== input.conversation.selectedReasoningLevel ||
		fallback.timelineEvent.conversationId !== current.conversationId ||
		fallback.timelineEvent.executionId !== input.executionId ||
		fallback.timelineEvent.sequence !== input.lastEventSequence + 1 ||
		fallback.timelineEvent.conversationCursor !==
			input.conversation.lastConversationCursor ||
		fallback.timelineEvent.occurredAt !== input.occurredAt.toISOString() ||
		fallback.timelineEvent.event.modelOptionId !== fallback.modelOptionId ||
		fallback.timelineEvent.event.reasoningLevel !== fallback.reasoningLevel ||
		fallback.auditEvent.actorId !== input.authority.actorId ||
		fallback.auditEvent.agentId !== input.authority.agentId ||
		fallback.auditEvent.conversationId !== current.conversationId ||
		fallback.auditEvent.executionId !== input.executionId ||
		fallback.auditEvent.requestId !== input.requestId ||
		fallback.auditEvent.traceId !== input.traceId ||
		!sameDate(fallback.auditEvent.occurredAt, input.occurredAt)
	) {
		unavailable();
	}
}

export function validateCreatePlan(
	value: unknown,
	request: CreateRequest,
): CreateConversationWritePlanV1 {
	const authority = parseAuthority(request.authority);
	const input = exactRecord(value, [
		"schemaVersion",
		"conversation",
		"result",
		"idempotency",
	]);
	if (input.schemaVersion !== 1) unavailable();
	const conversation = parseConversation(input.conversation);
	const result = parseCreatedResult(input.result);
	const idempotency = parseIdempotency(input.idempotency, true);
	if (
		request.command.agentId !== authority.agentId ||
		conversation.conversationId !== result.conversationId ||
		conversation.agentId !== authority.agentId ||
		conversation.actorId !== authority.actorId ||
		conversation.channelId !== authority.channelId ||
		conversation.status !== "ready" ||
		conversation.sessionGeneration !== 1 ||
		conversation.hostSessionRef !== null ||
		conversation.authorizationRevision !== authority.authorizationRevision ||
		conversation.lastConversationCursor !== 0 ||
		conversation.selectedModelOptionId !== null ||
		conversation.selectedReasoningLevel !== null ||
		!sameDate(conversation.createdAt, conversation.updatedAt) ||
		result.agentId !== authority.agentId ||
		idempotency.scopeType !== "agent" ||
		idempotency.scopeId !== authority.agentId ||
		idempotency.actorId !== authority.actorId ||
		idempotency.channelId !== authority.channelId ||
		idempotency.commandType !== "conversation.create" ||
		idempotency.key !== request.command.idempotencyKey ||
		idempotency.requestDigest !== request.requestDigest
	) {
		return unavailable();
	}
	return value as CreateConversationWritePlanV1;
}

export function validateMessagePlan(
	value: unknown,
	request: MessageRequest,
	state: ConversationExecutionStateV1,
): ConversationMessageWritePlanV1 {
	const authority = parseAuthority(request.authority);
	const input = exactRecord(
		value,
		value && typeof value === "object" && Object.hasOwn(value, "execution")
			? [
					"schemaVersion",
					"kind",
					"conversation",
					"message",
					"execution",
					"outboxIntent",
					"auditEvent",
					"modelSelectionFallback",
					"result",
					"idempotency",
				]
			: [
					"schemaVersion",
					"kind",
					"conversation",
					"message",
					"outboxIntent",
					"auditEvent",
					"modelSelectionFallback",
					"result",
					"idempotency",
				],
	);
	if (input.schemaVersion !== 1 || !state.conversation) unavailable();
	const conversation = parseConversation(input.conversation);
	const message = parseMessage(input.message);
	const outbox = parseMessageOutbox(input.outboxIntent);
	const audit = parseMessageAudit(input.auditEvent);
	const modelSelectionFallback = parseModelSelectionFallback(
		input.modelSelectionFallback,
	);
	const result = parseMessageResult(input.result);
	const idempotency = parseIdempotency(input.idempotency, false);
	const current = state.conversation;
	if (
		current.status === "unavailable" ||
		conversation.conversationId !== current.conversationId ||
		conversation.agentId !== current.agentId ||
		conversation.actorId !== current.actorId ||
		conversation.channelId !== current.channelId ||
		conversation.sessionGeneration !== current.sessionGeneration ||
		conversation.hostSessionRef !== current.hostSessionRef ||
		conversation.authorizationRevision !== authority.authorizationRevision ||
		!sameDate(conversation.createdAt, current.createdAt) ||
		!sameDate(conversation.updatedAt, message.createdAt) ||
		!conversationSelectionMatchesConfigurationShape(
			conversation,
			state.modelConfiguration,
		) ||
		message.conversationId !== current.conversationId ||
		message.actorId !== authority.actorId ||
		message.text !== request.command.text ||
		result.messageId !== message.messageId ||
		outbox.conversationId !== current.conversationId ||
		outbox.messageId !== message.messageId ||
		outbox.executionId !== message.executionId ||
		outbox.traceId !== request.command.traceId ||
		outbox.requestId !== request.command.requestId ||
		audit.actorId !== authority.actorId ||
		audit.agentId !== authority.agentId ||
		audit.conversationId !== current.conversationId ||
		audit.executionId !== message.executionId ||
		audit.traceId !== request.command.traceId ||
		audit.requestId !== request.command.requestId ||
		idempotency.scopeType !== "conversation" ||
		idempotency.scopeId !== current.conversationId ||
		idempotency.actorId !== authority.actorId ||
		idempotency.commandType !== "message" ||
		idempotency.key !== request.command.idempotencyKey ||
		idempotency.requestDigest !== request.requestDigest ||
		!sameDate(message.createdAt, outbox.occurredAt) ||
		!sameDate(message.createdAt, audit.occurredAt)
	) {
		return unavailable();
	}
	if (input.kind === "initial") {
		if (state.activeExecution || conversation.status !== "active")
			unavailable();
		const execution = parseExecution(input.execution);
		if (
			execution.executionId !== message.executionId ||
			execution.executionId !== result.executionId ||
			execution.conversationId !== current.conversationId ||
			execution.agentId !== authority.agentId ||
			execution.actorId !== authority.actorId ||
			execution.channelId !== authority.channelId ||
			execution.sessionGeneration !== current.sessionGeneration ||
			execution.deliveryFence !== 0 ||
			execution.authorizationRevision !== authority.authorizationRevision ||
			!modelSelectionMatchesConfigurationRevision(
				execution,
				state.modelConfiguration,
			) ||
			conversation.selectedModelOptionId !== execution.modelOptionId ||
			conversation.selectedReasoningLevel !== execution.reasoningLevel ||
			!sameModelSelection(outbox, execution) ||
			outbox.operation !== "conversation.turn.submit.v1" ||
			outbox.executionId !== execution.executionId ||
			outbox.turnId !== execution.turnId ||
			outbox.sessionGeneration !== execution.sessionGeneration ||
			!sameDate(message.createdAt, execution.createdAt) ||
			audit.action !== "conversation.message.accepted"
		) {
			return unavailable();
		}
		validateModelSelectionFallback(modelSelectionFallback, {
			state,
			conversation,
			authority,
			requestId: request.command.requestId,
			traceId: request.command.traceId,
			occurredAt: message.createdAt,
			executionId: execution.executionId,
			lastEventSequence: 0,
		});
	} else if (input.kind === "supplement") {
		const active = state.activeExecution;
		if (
			!active ||
			current.status !== "active" ||
			conversation.status !== "active" ||
			message.executionId !== active.executionId ||
			result.executionId !== active.executionId ||
			outbox.operation !== "conversation.turn.supplement.v1" ||
			outbox.turnId !== active.turnId ||
			outbox.sessionGeneration !== active.sessionGeneration ||
			!sameModelSelection(outbox, active) ||
			audit.action !== "conversation.message.supplemented"
		) {
			return unavailable();
		}
		validateModelSelectionFallback(modelSelectionFallback, {
			state,
			conversation,
			authority,
			requestId: request.command.requestId,
			traceId: request.command.traceId,
			occurredAt: message.createdAt,
			executionId: active.executionId,
			lastEventSequence: active.lastEventSequence,
		});
	} else {
		return unavailable();
	}
	return value as ConversationMessageWritePlanV1;
}

export function validateModelSelectionPlan(
	value: unknown,
	request: ModelSelectionRequest,
	state: ConversationExecutionStateV1,
): ConversationModelSelectionWritePlanV1 {
	const authority = parseAuthority(request.authority);
	const input = exactRecord(value, [
		"schemaVersion",
		"conversation",
		"auditEvent",
		"result",
		"idempotency",
	]);
	if (input.schemaVersion !== 1 || !state.conversation) unavailable();
	const current = state.conversation;
	const configuration = state.modelConfiguration;
	const conversation = parseConversation(input.conversation);
	const audit = parseModelSelectionAudit(input.auditEvent);
	const result = parseModelSelectionResult(input.result);
	const idempotency = parseIdempotency(input.idempotency, false);
	if (
		current.status === "unavailable" ||
		!configuration ||
		conversation.conversationId !== current.conversationId ||
		conversation.agentId !== current.agentId ||
		conversation.actorId !== current.actorId ||
		conversation.channelId !== current.channelId ||
		conversation.status !== current.status ||
		conversation.sessionGeneration !== current.sessionGeneration ||
		conversation.hostSessionRef !== current.hostSessionRef ||
		conversation.lastConversationCursor !== current.lastConversationCursor ||
		conversation.authorizationRevision !== authority.authorizationRevision ||
		!sameDate(conversation.createdAt, current.createdAt) ||
		!sameDate(conversation.updatedAt, audit.occurredAt) ||
		conversation.selectedModelOptionId !== request.command.modelOptionId ||
		conversation.selectedReasoningLevel !== request.command.reasoningLevel ||
		result.conversationId !== current.conversationId ||
		audit.actorId !== authority.actorId ||
		audit.agentId !== authority.agentId ||
		audit.conversationId !== current.conversationId ||
		audit.traceId !== request.command.traceId ||
		audit.requestId !== request.command.requestId ||
		audit.modelConfigurationRevision !== configuration.configurationRevision ||
		audit.modelOptionId !== request.command.modelOptionId ||
		audit.reasoningLevel !== request.command.reasoningLevel ||
		idempotency.scopeType !== "conversation" ||
		idempotency.scopeId !== current.conversationId ||
		idempotency.actorId !== authority.actorId ||
		idempotency.commandType !== "model.select" ||
		idempotency.key !== request.command.idempotencyKey ||
		idempotency.requestDigest !== request.requestDigest
	) {
		return unavailable();
	}
	return value as ConversationModelSelectionWritePlanV1;
}

export function validateRegenerationPlan(
	value: unknown,
	request: RegenerationRequest,
	state: ConversationExecutionStateV1,
): ConversationRegenerationWritePlanV1 {
	const authority = parseAuthority(request.authority);
	const input = exactRecord(value, [
		"schemaVersion",
		"kind",
		"conversation",
		"execution",
		"outboxIntent",
		"auditEvent",
		"modelSelectionFallback",
		"result",
		"idempotency",
	]);
	if (
		input.schemaVersion !== 1 ||
		input.kind !== "regenerate" ||
		!state.conversation ||
		!state.sourceMessage ||
		state.activeExecution
	) {
		return unavailable();
	}
	const current = state.conversation;
	const conversation = parseConversation(input.conversation);
	const execution = parseExecution(input.execution);
	const outbox = parseRegenerationOutbox(input.outboxIntent);
	const audit = parseRegenerationAudit(input.auditEvent);
	const modelSelectionFallback = parseModelSelectionFallback(
		input.modelSelectionFallback,
	);
	const result = parseRegenerationResult(input.result);
	const idempotency = parseIdempotency(input.idempotency, false);
	if (
		conversation.conversationId !== current.conversationId ||
		conversation.agentId !== current.agentId ||
		conversation.actorId !== current.actorId ||
		conversation.channelId !== current.channelId ||
		(current.status !== "ready" && current.status !== "active") ||
		conversation.status !== "active" ||
		conversation.sessionGeneration !== current.sessionGeneration ||
		conversation.hostSessionRef !== current.hostSessionRef ||
		conversation.authorizationRevision !== authority.authorizationRevision ||
		!sameDate(conversation.createdAt, current.createdAt) ||
		!sameDate(conversation.updatedAt, execution.createdAt) ||
		!conversationSelectionMatchesConfigurationShape(
			conversation,
			state.modelConfiguration,
		) ||
		execution.executionId !== result.executionId ||
		execution.conversationId !== current.conversationId ||
		execution.agentId !== authority.agentId ||
		execution.actorId !== authority.actorId ||
		execution.channelId !== authority.channelId ||
		execution.sessionGeneration !== current.sessionGeneration ||
		execution.deliveryFence !== 0 ||
		execution.authorizationRevision !== authority.authorizationRevision ||
		!modelSelectionMatchesConfigurationRevision(
			execution,
			state.modelConfiguration,
		) ||
		conversation.selectedModelOptionId !== execution.modelOptionId ||
		conversation.selectedReasoningLevel !== execution.reasoningLevel ||
		!sameModelSelection(outbox, execution) ||
		outbox.conversationId !== current.conversationId ||
		outbox.executionId !== execution.executionId ||
		outbox.messageId !== state.sourceMessage.messageId ||
		outbox.turnId !== execution.turnId ||
		outbox.sessionGeneration !== execution.sessionGeneration ||
		outbox.traceId !== request.command.traceId ||
		outbox.requestId !== request.command.requestId ||
		audit.actorId !== authority.actorId ||
		audit.agentId !== authority.agentId ||
		audit.conversationId !== current.conversationId ||
		audit.executionId !== execution.executionId ||
		audit.traceId !== request.command.traceId ||
		audit.requestId !== request.command.requestId ||
		idempotency.scopeType !== "conversation" ||
		idempotency.scopeId !== current.conversationId ||
		idempotency.actorId !== authority.actorId ||
		idempotency.commandType !== "regenerate" ||
		idempotency.key !== request.command.idempotencyKey ||
		idempotency.requestDigest !== request.requestDigest ||
		!sameDate(execution.createdAt, outbox.occurredAt) ||
		!sameDate(execution.createdAt, audit.occurredAt)
	) {
		return unavailable();
	}
	validateModelSelectionFallback(modelSelectionFallback, {
		state,
		conversation,
		authority,
		requestId: request.command.requestId,
		traceId: request.command.traceId,
		occurredAt: execution.createdAt,
		executionId: execution.executionId,
		lastEventSequence: 0,
	});
	return value as ConversationRegenerationWritePlanV1;
}

export function executionIsTerminal(status: string): boolean {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

export function validateStopPlan(
	value: unknown,
	request: StopRequest,
	state: ConversationExecutionStateV1,
): ConversationStopWritePlanV1 {
	const authority = parseAuthority(request.authority);
	const input = exactRecord(value, [
		"schemaVersion",
		"targetExecution",
		"stopRequestId",
		"confirmationDeadline",
		"outboxIntent",
		"auditEvent",
		"result",
		"idempotency",
	]);
	if (
		input.schemaVersion !== 1 ||
		!state.conversation ||
		!state.targetExecution ||
		state.existingStop
	) {
		return unavailable();
	}
	const target = exactRecord(input.targetExecution, [
		"executionId",
		"conversationId",
		"actorId",
	]);
	const executionId = text(target.executionId);
	const conversationId = text(target.conversationId);
	const actorId = text(target.actorId);
	const stopRequestId = text(input.stopRequestId);
	const outbox = parseStopOutbox(input.outboxIntent);
	const audit = parseStopAudit(input.auditEvent);
	const result = parseStopResult(input.result);
	const idempotency = parseIdempotency(input.idempotency, false);
	const current = state.conversation;
	const persistedTarget = state.targetExecution;
	if (
		executionIsTerminal(persistedTarget.status) ||
		executionId !== persistedTarget.executionId ||
		executionId !== request.command.targetExecutionId ||
		conversationId !== current.conversationId ||
		actorId !== authority.actorId ||
		result.status !== "submitted" ||
		result.executionId !== executionId ||
		outbox.conversationId !== current.conversationId ||
		outbox.executionId !== executionId ||
		outbox.sessionGeneration !== persistedTarget.sessionGeneration ||
		outbox.stopRequestId !== stopRequestId ||
		outbox.traceId !== request.command.traceId ||
		outbox.requestId !== request.command.requestId ||
		audit.actorId !== authority.actorId ||
		audit.agentId !== authority.agentId ||
		audit.conversationId !== current.conversationId ||
		audit.executionId !== executionId ||
		audit.traceId !== request.command.traceId ||
		audit.requestId !== request.command.requestId ||
		idempotency.scopeType !== "conversation" ||
		idempotency.scopeId !== current.conversationId ||
		idempotency.actorId !== authority.actorId ||
		idempotency.commandType !== "stop" ||
		idempotency.key !== request.command.idempotencyKey ||
		idempotency.requestDigest !== request.requestDigest ||
		!sameDate(outbox.occurredAt, audit.occurredAt) ||
		!(input.confirmationDeadline instanceof Date) ||
		input.confirmationDeadline.getTime() - outbox.occurredAt.getTime() !==
			conversationStopConfirmationTimeoutMsV1
	) {
		return unavailable();
	}
	return value as ConversationStopWritePlanV1;
}

export function validateStopNoop(
	value: unknown,
	request: StopRequest,
	state: ConversationExecutionStateV1,
): Extract<
	ConversationStopDecisionV1,
	{ readonly outcome: "accepted" | "replayed" | "denied" }
> {
	const input = exactRecord(
		value,
		value && typeof value === "object" && Object.hasOwn(value, "result")
			? ["outcome", "result"]
			: ["outcome"],
	);
	if (input.outcome === "denied") return { outcome: "denied" };
	if (
		(input.outcome !== "accepted" && input.outcome !== "replayed") ||
		!state.targetExecution
	) {
		return unavailable();
	}
	const result = parseStopResult(input.result);
	if (result.executionId !== request.command.targetExecutionId) unavailable();
	if (
		input.outcome === "accepted" &&
		(!executionIsTerminal(state.targetExecution.status) ||
			result.status !== "already_finished")
	) {
		return unavailable();
	}
	if (
		input.outcome === "replayed" &&
		(!state.existingStop ||
			result.status !==
				(state.existingStop.status === "completed"
					? "already_finished"
					: "submitted"))
	) {
		return unavailable();
	}
	return { outcome: input.outcome, result };
}
