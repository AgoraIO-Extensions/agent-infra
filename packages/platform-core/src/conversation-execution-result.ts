import { parseState } from "./conversation-execution-state.js";
import type {
	ConversationCommandDecisionV1,
	ConversationCommandResultV1,
	ConversationCreatedResultV1,
	ConversationExecutionAuthorityV1,
	ConversationExecutionConversationStateV1,
	ConversationModelSelectionDecisionV1,
	ConversationModelSelectionResultV1,
	ConversationStateDecisionV1,
	ConversationStateResultV1,
	ConversationStopDecisionV1,
	ConversationStopResultV1,
	CreateConversationDecisionV1,
} from "./conversation-execution-types.js";
import {
	isPositiveSafeInteger,
	isText,
	transactionObject,
	trySnapshotObject,
	unavailable,
} from "./conversation-execution-values.js";

function parseCreateConversationResult(
	input: unknown,
	expectedAgentId: string,
): ConversationCreatedResultV1 {
	const values = transactionObject(input, [
		"schemaVersion",
		"conversationId",
		"agentId",
		"status",
	]);
	if (
		values.schemaVersion !== 1 ||
		!isText(values.conversationId) ||
		values.agentId !== expectedAgentId ||
		values.status !== "ready"
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		conversationId: values.conversationId,
		agentId: expectedAgentId,
		status: "ready",
	};
}

export function parseMessageCommandResult(
	input: unknown,
): ConversationCommandResultV1 {
	const values = transactionObject(input, [
		"schemaVersion",
		"status",
		"messageId",
		"executionId",
	]);
	if (
		values.schemaVersion !== 1 ||
		values.status !== "submitted" ||
		!isText(values.messageId) ||
		!isText(values.executionId)
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		status: "submitted",
		messageId: values.messageId,
		executionId: values.executionId,
	};
}

export function parseRegenerationCommandResult(
	input: unknown,
): ConversationCommandResultV1 {
	const values = transactionObject(input, [
		"schemaVersion",
		"status",
		"messageId",
		"executionId",
	]);
	if (
		values.schemaVersion !== 1 ||
		values.status !== "submitted" ||
		values.messageId !== null ||
		!isText(values.executionId)
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		status: "submitted",
		messageId: null,
		executionId: values.executionId,
	};
}

function parseStopCommandResult(
	input: unknown,
	expectedExecutionId: string,
): ConversationStopResultV1 {
	const values = transactionObject(input, [
		"schemaVersion",
		"status",
		"executionId",
	]);
	if (
		values.schemaVersion !== 1 ||
		(values.status !== "submitted" && values.status !== "already_finished") ||
		values.executionId !== expectedExecutionId
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		status: values.status,
		executionId: expectedExecutionId,
	};
}

function parseModelSelectionResult(
	input: unknown,
	expectedConversationId: string,
): ConversationModelSelectionResultV1 {
	const values = transactionObject(input, ["schemaVersion", "conversationId"]);
	if (
		values.schemaVersion !== 1 ||
		values.conversationId !== expectedConversationId
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		conversationId: expectedConversationId,
	};
}

function parseConversationStateResult(
	input: unknown,
	expectedConversationId: string,
	expectedAuthority: ConversationExecutionAuthorityV1,
): ConversationStateResultV1 {
	const values = transactionObject(input, [
		"schemaVersion",
		"conversation",
		"modelSelectionFallback",
	]);
	if (values.schemaVersion !== 1) unavailable();
	const state = parseState({
		conversation:
			values.conversation as ConversationExecutionConversationStateV1,
		modelConfiguration: undefined,
		sourceMessage: undefined,
		targetExecution: undefined,
		existingStop: undefined,
		activeExecution: undefined,
	});
	const conversation = state.conversation;
	if (
		!conversation ||
		conversation.conversationId !== expectedConversationId ||
		conversation.actorId !== expectedAuthority.actorId ||
		conversation.agentId !== expectedAuthority.agentId ||
		conversation.channelId !== expectedAuthority.channelId
	) {
		unavailable();
	}
	const modelSelectionFallback = (() => {
		if (values.modelSelectionFallback === null) return null;
		const fallback = transactionObject(values.modelSelectionFallback, [
			"previousModelOptionId",
			"previousReasoningLevel",
			"modelConfigurationRevision",
			"modelOptionId",
			"reasoningLevel",
		]);
		if (
			!isText(fallback.previousModelOptionId) ||
			!isText(fallback.previousReasoningLevel) ||
			!isPositiveSafeInteger(fallback.modelConfigurationRevision) ||
			!isText(fallback.modelOptionId) ||
			!isText(fallback.reasoningLevel) ||
			fallback.modelOptionId !== conversation.selectedModelOptionId ||
			fallback.reasoningLevel !== conversation.selectedReasoningLevel
		) {
			unavailable();
		}
		return {
			previousModelOptionId: fallback.previousModelOptionId,
			previousReasoningLevel: fallback.previousReasoningLevel,
			modelConfigurationRevision: fallback.modelConfigurationRevision,
			modelOptionId: conversation.selectedModelOptionId,
			reasoningLevel: conversation.selectedReasoningLevel,
		};
	})();
	return { schemaVersion: 1, conversation, modelSelectionFallback };
}

function parseAcceptedOrReplayedDecision<T>(
	input: unknown,
	parseResult: (input: unknown) => T,
):
	| { readonly outcome: "accepted" | "replayed"; readonly result: T }
	| undefined {
	const values = trySnapshotObject(input, ["outcome", "result"]);
	if (!values) return undefined;
	if (values.outcome !== "accepted" && values.outcome !== "replayed") {
		return unavailable();
	}
	return {
		outcome: values.outcome,
		result: parseResult(values.result),
	};
}

function parseConflictDecision(
	input: unknown,
):
	| { readonly outcome: "conflict"; readonly reason: "idempotency_conflict" }
	| undefined {
	const values = trySnapshotObject(input, ["outcome", "reason"]);
	if (!values) return undefined;
	if (
		values.outcome !== "conflict" ||
		values.reason !== "idempotency_conflict"
	) {
		return unavailable();
	}
	return { outcome: "conflict", reason: "idempotency_conflict" };
}

export function normalizeCreateDecision(
	input: unknown,
	expectedAgentId: string,
): CreateConversationDecisionV1 {
	const resultDecision = parseAcceptedOrReplayedDecision(input, (result) =>
		parseCreateConversationResult(result, expectedAgentId),
	);
	if (resultDecision) return resultDecision;
	const bare = trySnapshotObject(input, ["outcome"]);
	if (bare) {
		if (bare.outcome === "denied") return { outcome: "denied" };
		return unavailable();
	}
	return parseConflictDecision(input) ?? unavailable();
}

export function normalizeCommandDecision(
	input: unknown,
	parseResult: (input: unknown) => ConversationCommandResultV1,
): ConversationCommandDecisionV1 {
	const resultDecision = parseAcceptedOrReplayedDecision(input, parseResult);
	if (resultDecision) return resultDecision;
	const bare = trySnapshotObject(input, ["outcome"]);
	if (bare) {
		if (bare.outcome === "busy") return { outcome: "busy" };
		if (bare.outcome === "denied") return { outcome: "denied" };
		return unavailable();
	}
	return parseConflictDecision(input) ?? unavailable();
}

export function normalizeStopDecision(
	input: unknown,
	expectedExecutionId: string,
): ConversationStopDecisionV1 {
	const resultDecision = parseAcceptedOrReplayedDecision(input, (result) =>
		parseStopCommandResult(result, expectedExecutionId),
	);
	if (resultDecision) return resultDecision;
	const bare = trySnapshotObject(input, ["outcome"]);
	if (bare) {
		if (bare.outcome === "denied") return { outcome: "denied" };
		return unavailable();
	}
	return parseConflictDecision(input) ?? unavailable();
}

export function normalizeModelSelectionDecision(
	input: unknown,
	expectedConversationId: string,
): ConversationModelSelectionDecisionV1 {
	const resultDecision = parseAcceptedOrReplayedDecision(input, (result) =>
		parseModelSelectionResult(result, expectedConversationId),
	);
	if (resultDecision) return resultDecision;
	const bare = trySnapshotObject(input, ["outcome"]);
	if (bare) {
		if (bare.outcome === "denied") return { outcome: "denied" };
		return unavailable();
	}
	return parseConflictDecision(input) ?? unavailable();
}

export function normalizeConversationStateDecision(
	input: unknown,
	expectedConversationId: string,
	expectedAuthority: ConversationExecutionAuthorityV1,
): ConversationStateDecisionV1 {
	const found = trySnapshotObject(input, ["outcome", "result"]);
	if (found) {
		if (found.outcome !== "found") unavailable();
		return {
			outcome: "found",
			result: parseConversationStateResult(
				found.result,
				expectedConversationId,
				expectedAuthority,
			),
		};
	}
	const denied = trySnapshotObject(input, ["outcome"]);
	if (denied?.outcome === "denied") return { outcome: "denied" };
	return unavailable();
}
