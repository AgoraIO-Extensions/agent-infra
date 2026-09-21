import type { ConversationModelSelectionFallbackWriteV1 } from "@agent-infra/platform-core";
import {
	date,
	exactRecord,
	safeInteger,
	text,
	timestamp,
	unavailable,
} from "./conversation-execution-common.js";

export function parseExecution(value: unknown) {
	const input = exactRecord(value, [
		"executionId",
		"conversationId",
		"agentId",
		"actorId",
		"channelId",
		"turnId",
		"status",
		"sessionGeneration",
		"deliveryFence",
		"authorizationRevision",
		"modelConfigurationRevision",
		"modelOptionId",
		"reasoningLevel",
		"createdAt",
	]);
	if (input.status !== "submitted") unavailable();
	return {
		executionId: text(input.executionId),
		conversationId: text(input.conversationId),
		agentId: text(input.agentId),
		actorId: text(input.actorId),
		channelId: text(input.channelId),
		turnId: text(input.turnId),
		status: "submitted" as const,
		sessionGeneration: safeInteger(input.sessionGeneration, 1),
		deliveryFence: safeInteger(input.deliveryFence, 0),
		authorizationRevision: text(input.authorizationRevision),
		modelConfigurationRevision:
			input.modelConfigurationRevision === null
				? null
				: safeInteger(input.modelConfigurationRevision, 1),
		modelOptionId:
			input.modelOptionId === null ? null : text(input.modelOptionId),
		reasoningLevel:
			input.reasoningLevel === null ? null : text(input.reasoningLevel),
		createdAt: date(input.createdAt),
	};
}

export function parseMessage(value: unknown) {
	const input = exactRecord(value, [
		"messageId",
		"conversationId",
		"actorId",
		"text",
		"executionId",
		"status",
		"createdAt",
	]);
	if (input.status !== "submitted") unavailable();
	return {
		messageId: text(input.messageId),
		conversationId: text(input.conversationId),
		actorId: text(input.actorId),
		text: text(input.text, 65_536),
		executionId: text(input.executionId),
		status: "submitted" as const,
		createdAt: date(input.createdAt),
	};
}

export function parseMessageOutbox(value: unknown) {
	const input = exactRecord(value, [
		"operation",
		"conversationId",
		"executionId",
		"messageId",
		"turnId",
		"sessionGeneration",
		"modelConfigurationRevision",
		"modelOptionId",
		"reasoningLevel",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	if (
		input.operation !== "conversation.turn.submit.v1" &&
		input.operation !== "conversation.turn.supplement.v1"
	) {
		return unavailable();
	}
	return {
		operation: input.operation,
		conversationId: text(input.conversationId),
		executionId: text(input.executionId),
		messageId: text(input.messageId),
		turnId: text(input.turnId),
		sessionGeneration: safeInteger(input.sessionGeneration, 1),
		modelConfigurationRevision:
			input.modelConfigurationRevision === null
				? null
				: safeInteger(input.modelConfigurationRevision, 1),
		modelOptionId:
			input.modelOptionId === null ? null : text(input.modelOptionId),
		reasoningLevel:
			input.reasoningLevel === null ? null : text(input.reasoningLevel),
		traceId: text(input.traceId),
		requestId: text(input.requestId),
		occurredAt: date(input.occurredAt),
	};
}

export function parseMessageAudit(value: unknown) {
	const input = exactRecord(value, [
		"action",
		"actorId",
		"agentId",
		"conversationId",
		"executionId",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	if (
		input.action !== "conversation.message.accepted" &&
		input.action !== "conversation.message.supplemented"
	) {
		return unavailable();
	}
	return {
		action: input.action,
		actorId: text(input.actorId),
		agentId: text(input.agentId),
		conversationId: text(input.conversationId),
		executionId: text(input.executionId),
		traceId: text(input.traceId),
		requestId: text(input.requestId),
		occurredAt: date(input.occurredAt),
	};
}

export function parseRegenerationOutbox(value: unknown) {
	const input = exactRecord(value, [
		"operation",
		"conversationId",
		"executionId",
		"messageId",
		"turnId",
		"sessionGeneration",
		"modelConfigurationRevision",
		"modelOptionId",
		"reasoningLevel",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	if (input.operation !== "conversation.turn.regenerate.v1") unavailable();
	return {
		operation: "conversation.turn.regenerate.v1" as const,
		conversationId: text(input.conversationId),
		executionId: text(input.executionId),
		messageId: text(input.messageId),
		turnId: text(input.turnId),
		sessionGeneration: safeInteger(input.sessionGeneration, 1),
		modelConfigurationRevision:
			input.modelConfigurationRevision === null
				? null
				: safeInteger(input.modelConfigurationRevision, 1),
		modelOptionId:
			input.modelOptionId === null ? null : text(input.modelOptionId),
		reasoningLevel:
			input.reasoningLevel === null ? null : text(input.reasoningLevel),
		traceId: text(input.traceId),
		requestId: text(input.requestId),
		occurredAt: date(input.occurredAt),
	};
}

export function parseRegenerationAudit(value: unknown) {
	const input = exactRecord(value, [
		"action",
		"actorId",
		"agentId",
		"conversationId",
		"executionId",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	if (input.action !== "conversation.regeneration.accepted") unavailable();
	return {
		action: "conversation.regeneration.accepted" as const,
		actorId: text(input.actorId),
		agentId: text(input.agentId),
		conversationId: text(input.conversationId),
		executionId: text(input.executionId),
		traceId: text(input.traceId),
		requestId: text(input.requestId),
		occurredAt: date(input.occurredAt),
	};
}

export function parseStopOutbox(value: unknown) {
	const input = exactRecord(value, [
		"operation",
		"conversationId",
		"executionId",
		"sessionGeneration",
		"stopRequestId",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	if (input.operation !== "conversation.turn.stop.v1") unavailable();
	return {
		operation: "conversation.turn.stop.v1" as const,
		conversationId: text(input.conversationId),
		executionId: text(input.executionId),
		sessionGeneration: safeInteger(input.sessionGeneration, 1),
		stopRequestId: text(input.stopRequestId),
		traceId: text(input.traceId),
		requestId: text(input.requestId),
		occurredAt: date(input.occurredAt),
	};
}

export function parseStopAudit(value: unknown) {
	const input = exactRecord(value, [
		"action",
		"actorId",
		"agentId",
		"conversationId",
		"executionId",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	if (input.action !== "conversation.stop.accepted") unavailable();
	return {
		action: "conversation.stop.accepted" as const,
		actorId: text(input.actorId),
		agentId: text(input.agentId),
		conversationId: text(input.conversationId),
		executionId: text(input.executionId),
		traceId: text(input.traceId),
		requestId: text(input.requestId),
		occurredAt: date(input.occurredAt),
	};
}

export function parseModelSelectionAudit(value: unknown) {
	const input = exactRecord(value, [
		"action",
		"actorId",
		"agentId",
		"conversationId",
		"traceId",
		"requestId",
		"occurredAt",
		"modelConfigurationRevision",
		"modelOptionId",
		"reasoningLevel",
	]);
	if (input.action !== "conversation.model_selection.updated") unavailable();
	return {
		action: "conversation.model_selection.updated" as const,
		actorId: text(input.actorId),
		agentId: text(input.agentId),
		conversationId: text(input.conversationId),
		traceId: text(input.traceId),
		requestId: text(input.requestId),
		occurredAt: date(input.occurredAt),
		modelConfigurationRevision: safeInteger(
			input.modelConfigurationRevision,
			1,
		),
		modelOptionId: text(input.modelOptionId),
		reasoningLevel: text(input.reasoningLevel),
	};
}

export function parseModelSelectionFallback(
	value: unknown,
): ConversationModelSelectionFallbackWriteV1 | null {
	if (value === null) return null;
	const input = exactRecord(value, [
		"previousModelOptionId",
		"previousReasoningLevel",
		"modelConfigurationRevision",
		"modelOptionId",
		"reasoningLevel",
		"timelineEvent",
		"auditEvent",
	]);
	const timeline = exactRecord(input.timelineEvent, [
		"schemaVersion",
		"eventId",
		"conversationId",
		"executionId",
		"sequence",
		"conversationCursor",
		"occurredAt",
		"event",
	]);
	const payload = exactRecord(timeline.event, [
		"type",
		"modelOptionId",
		"reasoningLevel",
		"reason",
	]);
	const audit = exactRecord(input.auditEvent, [
		"action",
		"executionId",
		"actorId",
		"agentId",
		"conversationId",
		"traceId",
		"requestId",
		"occurredAt",
	]);
	if (
		timeline.schemaVersion !== 1 ||
		payload.type !== "model.selection.fell_back" ||
		payload.reason !== "selection_unavailable" ||
		audit.action !== "conversation.model_selection.fell_back"
	) {
		unavailable();
	}
	return {
		previousModelOptionId: text(input.previousModelOptionId),
		previousReasoningLevel: text(input.previousReasoningLevel),
		modelConfigurationRevision: safeInteger(
			input.modelConfigurationRevision,
			1,
		),
		modelOptionId: text(input.modelOptionId),
		reasoningLevel: text(input.reasoningLevel),
		timelineEvent: {
			schemaVersion: 1,
			eventId: text(timeline.eventId),
			conversationId: text(timeline.conversationId),
			executionId: text(timeline.executionId),
			sequence: safeInteger(timeline.sequence, 1),
			conversationCursor: safeInteger(timeline.conversationCursor, 1),
			occurredAt: timestamp(timeline.occurredAt),
			event: {
				type: "model.selection.fell_back",
				modelOptionId: text(payload.modelOptionId),
				reasoningLevel: text(payload.reasoningLevel),
				reason: "selection_unavailable",
			},
		},
		auditEvent: {
			action: "conversation.model_selection.fell_back",
			executionId: text(audit.executionId),
			actorId: text(audit.actorId),
			agentId: text(audit.agentId),
			conversationId: text(audit.conversationId),
			traceId: text(audit.traceId),
			requestId: text(audit.requestId),
			occurredAt: date(audit.occurredAt),
		},
	};
}
