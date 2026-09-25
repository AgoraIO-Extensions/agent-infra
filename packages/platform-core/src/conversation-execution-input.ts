import type {
	ConversationExecutionAuthorityV1,
	ConversationExecutionAuthorizationPortV1,
	ConversationMessageCommandV1,
	ConversationModelSelectionCommandV1,
	ConversationRegenerateCommandV1,
	ConversationStateQueryV1,
	ConversationStopCommandV1,
	CreateConversationCommandV1,
} from "./conversation-execution-types.js";
import {
	idempotencyKeyPattern,
	invalidInput,
	isText,
	snapshotObject,
	unavailable,
} from "./conversation-execution-values.js";
import { parseTaskAuthorizationBoundaryV1 } from "./task-authorization.js";

export function parseCreateCommand(
	input: unknown,
): CreateConversationCommandV1 {
	const values = snapshotObject(input, [
		"schemaVersion",
		"agentId",
		"idempotencyKey",
		"requestId",
		"traceId",
	]);
	if (
		values.schemaVersion !== 1 ||
		!isText(values.agentId) ||
		typeof values.idempotencyKey !== "string" ||
		!idempotencyKeyPattern.test(values.idempotencyKey) ||
		!isText(values.requestId) ||
		!isText(values.traceId)
	) {
		invalidInput();
	}
	return {
		schemaVersion: 1,
		agentId: values.agentId,
		idempotencyKey: values.idempotencyKey,
		requestId: values.requestId,
		traceId: values.traceId,
	};
}

export function parseMessageCommand(
	input: unknown,
): ConversationMessageCommandV1 {
	const values = snapshotObject(
		input,
		[
			"schemaVersion",
			"command",
			"conversationId",
			"text",
			"idempotencyKey",
			"requestId",
			"traceId",
		],
		["attachments"],
	);
	if (
		values.schemaVersion !== 1 ||
		values.command !== "message" ||
		!isText(values.conversationId) ||
		!isText(values.text) ||
		typeof values.idempotencyKey !== "string" ||
		!idempotencyKeyPattern.test(values.idempotencyKey) ||
		!isText(values.requestId) ||
		!isText(values.traceId)
	) {
		invalidInput();
	}
	if (
		values.attachments !== undefined &&
		(!Array.isArray(values.attachments) ||
			values.attachments.length > 32 ||
			values.attachments.some((value) => !isText(value)) ||
			new Set(values.attachments).size !== values.attachments.length)
	)
		invalidInput();

	return {
		schemaVersion: 1,
		command: "message",
		conversationId: values.conversationId,
		text: values.text,
		...(values.attachments === undefined
			? {}
			: { attachments: [...(values.attachments as string[])] }),
		idempotencyKey: values.idempotencyKey,
		requestId: values.requestId,
		traceId: values.traceId,
	};
}

export function parseRegenerateCommand(
	input: unknown,
): ConversationRegenerateCommandV1 {
	const values = snapshotObject(input, [
		"schemaVersion",
		"command",
		"conversationId",
		"sourceMessageId",
		"idempotencyKey",
		"requestId",
		"traceId",
	]);
	if (
		values.schemaVersion !== 1 ||
		values.command !== "regenerate" ||
		!isText(values.conversationId) ||
		!isText(values.sourceMessageId) ||
		typeof values.idempotencyKey !== "string" ||
		!idempotencyKeyPattern.test(values.idempotencyKey) ||
		!isText(values.requestId) ||
		!isText(values.traceId)
	) {
		invalidInput();
	}
	return {
		schemaVersion: 1,
		command: "regenerate",
		conversationId: values.conversationId,
		sourceMessageId: values.sourceMessageId,
		idempotencyKey: values.idempotencyKey,
		requestId: values.requestId,
		traceId: values.traceId,
	};
}

export function parseStopCommand(input: unknown): ConversationStopCommandV1 {
	const values = snapshotObject(input, [
		"schemaVersion",
		"command",
		"conversationId",
		"targetExecutionId",
		"idempotencyKey",
		"requestId",
		"traceId",
	]);
	if (
		values.schemaVersion !== 1 ||
		values.command !== "stop" ||
		!isText(values.conversationId) ||
		!isText(values.targetExecutionId) ||
		typeof values.idempotencyKey !== "string" ||
		!idempotencyKeyPattern.test(values.idempotencyKey) ||
		!isText(values.requestId) ||
		!isText(values.traceId)
	) {
		invalidInput();
	}
	return {
		schemaVersion: 1,
		command: "stop",
		conversationId: values.conversationId,
		targetExecutionId: values.targetExecutionId,
		idempotencyKey: values.idempotencyKey,
		requestId: values.requestId,
		traceId: values.traceId,
	};
}

export function parseModelSelectionCommand(
	input: unknown,
): ConversationModelSelectionCommandV1 {
	const values = snapshotObject(input, [
		"schemaVersion",
		"command",
		"conversationId",
		"modelOptionId",
		"reasoningLevel",
		"idempotencyKey",
		"requestId",
		"traceId",
	]);
	if (
		values.schemaVersion !== 1 ||
		values.command !== "model.select" ||
		!isText(values.conversationId) ||
		!isText(values.modelOptionId) ||
		!isText(values.reasoningLevel) ||
		typeof values.idempotencyKey !== "string" ||
		!idempotencyKeyPattern.test(values.idempotencyKey) ||
		!isText(values.requestId) ||
		!isText(values.traceId)
	) {
		invalidInput();
	}
	return {
		schemaVersion: 1,
		command: "model.select",
		conversationId: values.conversationId,
		modelOptionId: values.modelOptionId,
		reasoningLevel: values.reasoningLevel,
		idempotencyKey: values.idempotencyKey,
		requestId: values.requestId,
		traceId: values.traceId,
	};
}

export function parseConversationStateQuery(
	input: unknown,
): ConversationStateQueryV1 {
	const values = snapshotObject(input, ["schemaVersion", "conversationId"]);
	if (values.schemaVersion !== 1 || !isText(values.conversationId)) {
		invalidInput();
	}
	return { schemaVersion: 1, conversationId: values.conversationId };
}

export function parseAuthority(
	input: unknown,
): ConversationExecutionAuthorityV1 {
	const values = snapshotObject(input, [
		"schemaVersion",
		"actorId",
		"agentId",
		"channelId",
		"authorizationRevision",
		"supportsSupplementaryInstruction",
		...(input !== null &&
		typeof input === "object" &&
		Object.hasOwn(input, "taskBoundary")
			? ["taskBoundary"]
			: []),
	]);
	if (
		values.schemaVersion !== 1 ||
		!isText(values.actorId) ||
		!isText(values.agentId) ||
		!isText(values.channelId) ||
		!isText(values.authorizationRevision) ||
		typeof values.supportsSupplementaryInstruction !== "boolean"
	) {
		invalidInput();
	}
	const taskBoundary =
		values.taskBoundary === undefined
			? undefined
			: parseTaskAuthorizationBoundaryV1(values.taskBoundary);
	if (
		taskBoundary &&
		(taskBoundary.principal.kind !== "user" ||
			taskBoundary.principal.id !== values.actorId ||
			taskBoundary.agentId !== values.agentId ||
			taskBoundary.channelId !== values.channelId ||
			taskBoundary.agentAuthorizationRevision !== values.authorizationRevision)
	)
		invalidInput();
	return {
		schemaVersion: 1,
		actorId: values.actorId,
		agentId: values.agentId,
		channelId: values.channelId,
		authorizationRevision: values.authorizationRevision,
		supportsSupplementaryInstruction: values.supportsSupplementaryInstruction,
		...(taskBoundary ? { taskBoundary } : {}),
	};
}

export async function authorize(
	port: ConversationExecutionAuthorizationPortV1,
	input: Parameters<ConversationExecutionAuthorizationPortV1["authorize"]>[0],
): Promise<ConversationExecutionAuthorityV1 | undefined> {
	try {
		const decision = await port.authorize(input);
		const values = snapshotObject(decision, [
			"outcome",
			...(decision &&
			typeof decision === "object" &&
			"outcome" in decision &&
			(decision as { outcome?: unknown }).outcome === "allowed"
				? ["authority"]
				: []),
		]);
		if (values.outcome === "denied") return undefined;
		if (values.outcome !== "allowed") unavailable();
		return parseAuthority(values.authority);
	} catch {
		unavailable();
	}
}
