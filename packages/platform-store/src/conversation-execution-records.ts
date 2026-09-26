import {
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionConversationStateV1,
	type ConversationModelConfigurationV1,
	isTaskPrincipalChannelV1,
	parseTaskAuthorizationBoundaryV1,
} from "@agent-infra/platform-core";
import {
	type ConversationRow,
	date,
	exactRecord,
	idempotencyKeyPattern,
	requestDigestPattern,
	safeInteger,
	text,
	unavailable,
} from "./conversation-execution-common.js";

export function parseAuthority(
	value: unknown,
): ConversationExecutionAuthorityV1 {
	const input = exactRecord(value, [
		"schemaVersion",
		"actorId",
		"agentId",
		"channelId",
		"authorizationRevision",
		"supportsSupplementaryInstruction",
		...(value !== null &&
		typeof value === "object" &&
		Object.hasOwn(value, "taskBoundary")
			? ["taskBoundary"]
			: []),
	]);
	if (
		input.schemaVersion !== 1 ||
		typeof input.supportsSupplementaryInstruction !== "boolean"
	) {
		return unavailable();
	}
	const taskBoundary =
		input.taskBoundary === undefined
			? undefined
			: parseTaskAuthorizationBoundaryV1(input.taskBoundary);
	if (
		taskBoundary &&
		(!isTaskPrincipalChannelV1(
			taskBoundary.principal,
			taskBoundary.channelId,
		) ||
			taskBoundary.principal.id !== input.actorId ||
			taskBoundary.agentId !== input.agentId ||
			taskBoundary.channelId !== input.channelId ||
			taskBoundary.agentAuthorizationRevision !== input.authorizationRevision)
	)
		unavailable();
	return {
		schemaVersion: 1,
		actorId: text(input.actorId),
		agentId: text(input.agentId),
		channelId: text(input.channelId),
		authorizationRevision: text(input.authorizationRevision),
		supportsSupplementaryInstruction: input.supportsSupplementaryInstruction,
		...(taskBoundary ? { taskBoundary } : {}),
	};
}

export function parseConversation(
	value: unknown,
): ConversationExecutionConversationStateV1 {
	const input = exactRecord(
		value,
		[
			"schemaVersion",
			"conversationId",
			"agentId",
			"actorId",
			"channelId",
			"status",
			"sessionGeneration",
			"hostSessionRef",
			"authorizationRevision",
			"lastConversationCursor",
			"selectedModelOptionId",
			"selectedReasoningLevel",
			"createdAt",
			"updatedAt",
		],
		["isolationPending"],
	);
	if (
		input.schemaVersion !== 1 ||
		(input.isolationPending !== undefined && input.isolationPending !== true) ||
		(input.status !== "ready" &&
			input.status !== "active" &&
			input.status !== "unavailable") ||
		(input.hostSessionRef !== null &&
			typeof input.hostSessionRef !== "string") ||
		(input.selectedModelOptionId !== null &&
			typeof input.selectedModelOptionId !== "string") ||
		(input.selectedReasoningLevel !== null &&
			typeof input.selectedReasoningLevel !== "string") ||
		(input.selectedModelOptionId === null) !==
			(input.selectedReasoningLevel === null)
	) {
		return unavailable();
	}
	const createdAt = date(input.createdAt);
	const updatedAt = date(input.updatedAt);
	if (updatedAt.getTime() < createdAt.getTime()) unavailable();
	return {
		schemaVersion: 1,
		conversationId: text(input.conversationId),
		agentId: text(input.agentId),
		actorId: text(input.actorId),
		channelId: text(input.channelId),
		...(input.isolationPending === true
			? { isolationPending: true as const }
			: {}),
		status: input.status,
		sessionGeneration: safeInteger(input.sessionGeneration, 1),
		hostSessionRef:
			input.hostSessionRef === null ? null : text(input.hostSessionRef),
		authorizationRevision: text(input.authorizationRevision),
		lastConversationCursor: safeInteger(input.lastConversationCursor, 0),
		selectedModelOptionId:
			input.selectedModelOptionId === null
				? null
				: text(input.selectedModelOptionId),
		selectedReasoningLevel:
			input.selectedReasoningLevel === null
				? null
				: text(input.selectedReasoningLevel),
		createdAt,
		updatedAt,
	};
}

export function conversationFromRow(
	row: ConversationRow,
	isolationPending = false,
): ConversationExecutionConversationStateV1 {
	return parseConversation({
		schemaVersion: 1,
		conversationId: row.id,
		agentId: row.agent_id,
		actorId: row.actor_id,
		channelId: row.channel_id,
		status: row.status,
		...(isolationPending ? { isolationPending: true } : {}),
		sessionGeneration: row.session_generation,
		hostSessionRef: row.host_session_ref,
		authorizationRevision: row.authorization_revision,
		lastConversationCursor: row.last_conversation_cursor,
		selectedModelOptionId: row.selected_model_option_id,
		selectedReasoningLevel: row.selected_reasoning_level,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}

export function matchesBinding(
	conversation: ConversationExecutionConversationStateV1,
	authority: ConversationExecutionAuthorityV1,
): boolean {
	return (
		conversation.agentId === authority.agentId &&
		conversation.actorId === authority.actorId &&
		conversation.channelId === authority.channelId
	);
}

export function parseCreatedResult(value: unknown) {
	const input = exactRecord(value, [
		"schemaVersion",
		"conversationId",
		"agentId",
		"status",
	]);
	if (input.schemaVersion !== 1 || input.status !== "ready") unavailable();
	return {
		schemaVersion: 1 as const,
		conversationId: text(input.conversationId),
		agentId: text(input.agentId),
		status: "ready" as const,
	};
}

export function parseMessageResult(value: unknown) {
	const input = exactRecord(value, [
		"schemaVersion",
		"status",
		"messageId",
		"executionId",
	]);
	if (
		input.schemaVersion !== 1 ||
		input.status !== "submitted" ||
		input.messageId === null
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1 as const,
		status: "submitted" as const,
		messageId: text(input.messageId),
		executionId: text(input.executionId),
	};
}

export function parseRegenerationResult(value: unknown) {
	const input = exactRecord(value, [
		"schemaVersion",
		"status",
		"messageId",
		"executionId",
	]);
	if (
		input.schemaVersion !== 1 ||
		input.status !== "submitted" ||
		input.messageId !== null
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1 as const,
		status: "submitted" as const,
		messageId: null,
		executionId: text(input.executionId),
	};
}

export function parseStopResult(value: unknown) {
	const input = exactRecord(value, ["schemaVersion", "status", "executionId"]);
	if (
		input.schemaVersion !== 1 ||
		(input.status !== "submitted" && input.status !== "already_finished")
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1 as const,
		status: input.status as "submitted" | "already_finished",
		executionId: text(input.executionId),
	};
}

export function parseModelSelectionResult(value: unknown) {
	const input = exactRecord(value, ["schemaVersion", "conversationId"]);
	if (input.schemaVersion !== 1) unavailable();
	return {
		schemaVersion: 1 as const,
		conversationId: text(input.conversationId),
	};
}

export function modelSelectionMatchesConfigurationRevision(
	selection: {
		readonly modelConfigurationRevision: number | null;
		readonly modelOptionId: string | null;
		readonly reasoningLevel: string | null;
	},
	configuration: ConversationModelConfigurationV1 | undefined,
): boolean {
	return configuration
		? selection.modelConfigurationRevision ===
				configuration.configurationRevision &&
				selection.modelOptionId !== null &&
				selection.reasoningLevel !== null
		: selection.modelConfigurationRevision === null &&
				selection.modelOptionId === null &&
				selection.reasoningLevel === null;
}

export function conversationSelectionMatchesConfigurationShape(
	conversation: ConversationExecutionConversationStateV1,
	configuration: ConversationModelConfigurationV1 | undefined,
): boolean {
	return configuration
		? conversation.selectedModelOptionId !== null &&
				conversation.selectedReasoningLevel !== null
		: conversation.selectedModelOptionId === null &&
				conversation.selectedReasoningLevel === null;
}

export function sameModelSelection(
	left: {
		readonly modelConfigurationRevision: number | null;
		readonly modelOptionId: string | null;
		readonly reasoningLevel: string | null;
	},
	right: {
		readonly modelConfigurationRevision: number | null;
		readonly modelOptionId: string | null;
		readonly reasoningLevel: string | null;
	},
): boolean {
	return (
		left.modelConfigurationRevision === right.modelConfigurationRevision &&
		left.modelOptionId === right.modelOptionId &&
		left.reasoningLevel === right.reasoningLevel
	);
}

export function parseIdempotency(
	value: unknown,
	includeChannel: boolean,
): {
	readonly scopeType: "agent" | "conversation";
	readonly scopeId: string;
	readonly actorId: string;
	readonly channelId?: string;
	readonly commandType:
		| "conversation.create"
		| "message"
		| "model.select"
		| "regenerate"
		| "stop";
	readonly key: string;
	readonly requestDigest: string;
} {
	const input = exactRecord(
		value,
		includeChannel
			? [
					"scopeType",
					"scopeId",
					"actorId",
					"channelId",
					"commandType",
					"key",
					"requestDigest",
				]
			: [
					"scopeType",
					"scopeId",
					"actorId",
					"commandType",
					"key",
					"requestDigest",
				],
	);
	if (
		(input.scopeType !== "agent" && input.scopeType !== "conversation") ||
		(input.commandType !== "conversation.create" &&
			input.commandType !== "message" &&
			input.commandType !== "model.select" &&
			input.commandType !== "regenerate" &&
			input.commandType !== "stop") ||
		typeof input.key !== "string" ||
		!idempotencyKeyPattern.test(input.key) ||
		typeof input.requestDigest !== "string" ||
		!requestDigestPattern.test(input.requestDigest)
	) {
		return unavailable();
	}
	return {
		scopeType: input.scopeType,
		scopeId: text(input.scopeId),
		actorId: text(input.actorId),
		...(includeChannel ? { channelId: text(input.channelId) } : {}),
		commandType: input.commandType,
		key: input.key,
		requestDigest: input.requestDigest,
	};
}
