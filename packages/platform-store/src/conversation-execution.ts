import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
	type ConversationCommandDecisionV1,
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionConversationStateV1,
	ConversationExecutionError,
	type ConversationExecutionStateV1,
	type ConversationExecutionTransactionPortV1,
	type ConversationMessageWritePlanV1,
	type ConversationRegenerationWritePlanV1,
	type ConversationStopDecisionV1,
	type ConversationStopWritePlanV1,
	type CreateConversationDecisionV1,
	type CreateConversationWritePlanV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";

import { platformDatabaseUrlFromEnvironment } from "./migrate.js";

const idempotencyKeyPattern = /^[A-Za-z0-9._~-]{1,128}$/;
const requestDigestPattern = /^[a-f0-9]{64}$/;
const activeExecutionStatuses = new Set(["submitted", "processing", "unknown"]);

type Transaction = postgres.TransactionSql;
type JsonValue = Parameters<ReturnType<typeof postgres>["json"]>[0];
type CreateRequest = Parameters<
	ConversationExecutionTransactionPortV1["createConversation"]
>[0];
type CreateDecide = Parameters<
	ConversationExecutionTransactionPortV1["createConversation"]
>[1];
type MessageRequest = Parameters<
	ConversationExecutionTransactionPortV1["executeMessage"]
>[0];
type MessageDecide = Parameters<
	ConversationExecutionTransactionPortV1["executeMessage"]
>[1];
type RegenerationRequest = Parameters<
	ConversationExecutionTransactionPortV1["executeRegeneration"]
>[0];
type RegenerationDecide = Parameters<
	ConversationExecutionTransactionPortV1["executeRegeneration"]
>[1];
type StopRequest = Parameters<
	ConversationExecutionTransactionPortV1["executeStop"]
>[0];
type StopDecide = Parameters<
	ConversationExecutionTransactionPortV1["executeStop"]
>[1];

interface IdempotencyRow {
	readonly request_digest: string;
	readonly status: "reserved" | "completed";
	readonly result: unknown;
}

interface ConversationRow {
	readonly id: string;
	readonly agent_id: string;
	readonly actor_id: string;
	readonly channel_id: string;
	readonly status: string;
	readonly session_generation: string | number;
	readonly host_session_ref: string | null;
	readonly authorization_revision: string;
	readonly last_conversation_cursor: string | number;
}

interface ExecutionRow {
	readonly execution_id: string;
	readonly conversation_id: string;
	readonly actor_id: string;
	readonly turn_id: string;
	readonly session_generation: string | number;
	readonly status: string;
}

interface StopRow {
	readonly execution_id: string;
	readonly stop_request_id: string;
	readonly status: string;
}

export interface PostgresConversationExecutionOptionsV1 {
	readonly databaseUrl: string;
}

function unavailable(): never {
	throw new ConversationExecutionError("unavailable");
}

function exactRecord(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			Reflect.ownKeys(value).length !== keys.length ||
			keys.some((key) => !Object.hasOwn(value, key))
		) {
			return unavailable();
		}
		const result: Record<string, unknown> = {};
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
				return unavailable();
			}
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		return unavailable();
	}
}

function text(value: unknown, maximum = 1024): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		!String.prototype.isWellFormed.call(value) ||
		Buffer.byteLength(value, "utf8") > maximum
	) {
		return unavailable();
	}
	return value;
}

function safeInteger(value: unknown, minimum: number): number {
	const number = typeof value === "string" ? Number(value) : value;
	if (
		typeof number !== "number" ||
		!Number.isSafeInteger(number) ||
		number < minimum
	) {
		return unavailable();
	}
	return number;
}

function date(value: unknown): Date {
	try {
		if (!Number.isFinite(Date.prototype.getTime.call(value))) unavailable();
		return new Date(Date.prototype.getTime.call(value));
	} catch {
		return unavailable();
	}
}

function sameDate(left: Date, right: Date): boolean {
	return left.getTime() === right.getTime();
}

function parseAuthority(value: unknown): ConversationExecutionAuthorityV1 {
	const input = exactRecord(value, [
		"schemaVersion",
		"actorId",
		"agentId",
		"channelId",
		"authorizationRevision",
		"supportsSupplementaryInstruction",
	]);
	if (
		input.schemaVersion !== 1 ||
		typeof input.supportsSupplementaryInstruction !== "boolean"
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		actorId: text(input.actorId),
		agentId: text(input.agentId),
		channelId: text(input.channelId),
		authorizationRevision: text(input.authorizationRevision),
		supportsSupplementaryInstruction: input.supportsSupplementaryInstruction,
	};
}

function parseConversation(
	value: unknown,
): ConversationExecutionConversationStateV1 {
	const input = exactRecord(value, [
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
	]);
	if (
		input.schemaVersion !== 1 ||
		(input.status !== "ready" &&
			input.status !== "active" &&
			input.status !== "unavailable") ||
		(input.hostSessionRef !== null && typeof input.hostSessionRef !== "string")
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		conversationId: text(input.conversationId),
		agentId: text(input.agentId),
		actorId: text(input.actorId),
		channelId: text(input.channelId),
		status: input.status,
		sessionGeneration: safeInteger(input.sessionGeneration, 1),
		hostSessionRef:
			input.hostSessionRef === null ? null : text(input.hostSessionRef),
		authorizationRevision: text(input.authorizationRevision),
		lastConversationCursor: safeInteger(input.lastConversationCursor, 0),
	};
}

function conversationFromRow(
	row: ConversationRow,
): ConversationExecutionConversationStateV1 {
	return parseConversation({
		schemaVersion: 1,
		conversationId: row.id,
		agentId: row.agent_id,
		actorId: row.actor_id,
		channelId: row.channel_id,
		status: row.status,
		sessionGeneration: row.session_generation,
		hostSessionRef: row.host_session_ref,
		authorizationRevision: row.authorization_revision,
		lastConversationCursor: row.last_conversation_cursor,
	});
}

function matchesBinding(
	conversation: ConversationExecutionConversationStateV1,
	authority: ConversationExecutionAuthorityV1,
): boolean {
	return (
		conversation.agentId === authority.agentId &&
		conversation.actorId === authority.actorId &&
		conversation.channelId === authority.channelId
	);
}

function parseCreatedResult(value: unknown) {
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

function parseMessageResult(value: unknown) {
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

function parseRegenerationResult(value: unknown) {
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

function parseStopResult(value: unknown) {
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

function parseIdempotency(
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

function parseExecution(value: unknown) {
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
		createdAt: date(input.createdAt),
	};
}

function parseMessage(value: unknown) {
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

function parseMessageOutbox(value: unknown) {
	const input = exactRecord(value, [
		"operation",
		"conversationId",
		"executionId",
		"messageId",
		"turnId",
		"sessionGeneration",
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
		traceId: text(input.traceId),
		requestId: text(input.requestId),
		occurredAt: date(input.occurredAt),
	};
}

function parseMessageAudit(value: unknown) {
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

function parseRegenerationOutbox(value: unknown) {
	const input = exactRecord(value, [
		"operation",
		"conversationId",
		"executionId",
		"messageId",
		"turnId",
		"sessionGeneration",
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
		traceId: text(input.traceId),
		requestId: text(input.requestId),
		occurredAt: date(input.occurredAt),
	};
}

function parseRegenerationAudit(value: unknown) {
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

function parseStopOutbox(value: unknown) {
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

function parseStopAudit(value: unknown) {
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

function validateCreatePlan(
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

function validateMessagePlan(
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
					"result",
					"idempotency",
				],
	);
	if (input.schemaVersion !== 1 || !state.conversation) unavailable();
	const conversation = parseConversation(input.conversation);
	const message = parseMessage(input.message);
	const outbox = parseMessageOutbox(input.outboxIntent);
	const audit = parseMessageAudit(input.auditEvent);
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
		conversation.lastConversationCursor !== current.lastConversationCursor ||
		conversation.authorizationRevision !== authority.authorizationRevision ||
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
			outbox.operation !== "conversation.turn.submit.v1" ||
			outbox.executionId !== execution.executionId ||
			outbox.turnId !== execution.turnId ||
			outbox.sessionGeneration !== execution.sessionGeneration ||
			!sameDate(message.createdAt, execution.createdAt) ||
			audit.action !== "conversation.message.accepted"
		) {
			return unavailable();
		}
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
			audit.action !== "conversation.message.supplemented"
		) {
			return unavailable();
		}
	} else {
		return unavailable();
	}
	return value as ConversationMessageWritePlanV1;
}

function validateRegenerationPlan(
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
	const result = parseRegenerationResult(input.result);
	const idempotency = parseIdempotency(input.idempotency, false);
	if (
		conversation.conversationId !== current.conversationId ||
		conversation.agentId !== current.agentId ||
		conversation.actorId !== current.actorId ||
		conversation.channelId !== current.channelId ||
		current.status !== "active" ||
		conversation.status !== "active" ||
		conversation.sessionGeneration !== current.sessionGeneration ||
		conversation.hostSessionRef !== current.hostSessionRef ||
		conversation.authorizationRevision !== authority.authorizationRevision ||
		conversation.lastConversationCursor !== current.lastConversationCursor ||
		execution.executionId !== result.executionId ||
		execution.conversationId !== current.conversationId ||
		execution.agentId !== authority.agentId ||
		execution.actorId !== authority.actorId ||
		execution.channelId !== authority.channelId ||
		execution.sessionGeneration !== current.sessionGeneration ||
		execution.deliveryFence !== 0 ||
		execution.authorizationRevision !== authority.authorizationRevision ||
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
	return value as ConversationRegenerationWritePlanV1;
}

function executionIsTerminal(status: string): boolean {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

function validateStopPlan(
	value: unknown,
	request: StopRequest,
	state: ConversationExecutionStateV1,
): ConversationStopWritePlanV1 {
	const authority = parseAuthority(request.authority);
	const input = exactRecord(value, [
		"schemaVersion",
		"targetExecution",
		"stopRequestId",
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
		!sameDate(outbox.occurredAt, audit.occurredAt)
	) {
		return unavailable();
	}
	return value as ConversationStopWritePlanV1;
}

function validateStopNoop(
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

function createIdempotencyScopeId(agentId: string, channelId: string): string {
	return JSON.stringify([agentId, channelId]);
}

function outboxId(
	operation: "conversation.turn.submit.v1" | "conversation.turn.supplement.v1",
	messageId: string,
	executionId: string,
): string {
	return operation === "conversation.turn.submit.v1"
		? `conversation:turn:${executionId}`
		: `conversation:supplement:${messageId}`;
}

function isMessagePlan(
	decision: Awaited<ReturnType<MessageDecide>>,
): decision is ConversationMessageWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

function isRegenerationPlan(
	decision: Awaited<ReturnType<RegenerationDecide>>,
): decision is ConversationRegenerationWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

function isStopPlan(
	decision: Awaited<ReturnType<StopDecide>>,
): decision is ConversationStopWritePlanV1 {
	return !Object.hasOwn(decision, "outcome");
}

async function readIdempotency(
	transaction: Transaction,
	input: {
		readonly scopeType: string;
		readonly scopeId: string;
		readonly actorId: string;
		readonly commandType: string;
		readonly key: string;
	},
): Promise<IdempotencyRow | undefined> {
	const rows = await transaction<IdempotencyRow[]>`
		select request_digest, status, result
		from platform.idempotency_records
		where scope_type = ${input.scopeType}
			and scope_id = ${input.scopeId}
			and actor_id = ${input.actorId}
			and command_type = ${input.commandType}
			and idempotency_key = ${input.key}
		limit 1
	`;
	return rows[0];
}

async function reserveIdempotency(
	transaction: Transaction,
	input: {
		readonly scopeType: string;
		readonly scopeId: string;
		readonly actorId: string;
		readonly commandType: string;
		readonly key: string;
		readonly requestDigest: string;
		readonly occurredAt: Date;
	},
): Promise<string | undefined> {
	const id = randomUUID();
	const inserted = await transaction<{ id: string }[]>`
		insert into platform.idempotency_records
			(id, scope_type, scope_id, actor_id, command_type, idempotency_key,
			 request_digest, status, created_at, updated_at)
		values
			(${id}, ${input.scopeType}, ${input.scopeId}, ${input.actorId},
			 ${input.commandType}, ${input.key}, ${input.requestDigest}, 'reserved',
			 ${input.occurredAt}, ${input.occurredAt})
		on conflict (scope_type, scope_id, actor_id, command_type, idempotency_key)
		do nothing
		returning id
	`;
	return inserted[0]?.id;
}

async function completeIdempotency(
	transaction: Transaction,
	id: string,
	result: unknown,
	occurredAt: Date,
): Promise<void> {
	const completed = await transaction<{ id: string }[]>`
		update platform.idempotency_records
		set status = 'completed', result = ${transaction.json(result as JsonValue)},
			updated_at = ${occurredAt}
		where id = ${id} and status = 'reserved'
		returning id
	`;
	if (completed.length !== 1) unavailable();
}

async function lockConversation(
	transaction: Transaction,
	conversationId: string,
): Promise<ConversationExecutionConversationStateV1 | undefined> {
	const rows = await transaction<ConversationRow[]>`
		select id, agent_id, actor_id, channel_id, status, session_generation,
			host_session_ref, authorization_revision, last_conversation_cursor
		from platform.conversations where id = ${conversationId} for update
	`;
	return rows[0] ? conversationFromRow(rows[0]) : undefined;
}

async function readMessageState(
	transaction: Transaction,
	conversation: ConversationExecutionConversationStateV1,
): Promise<ConversationExecutionStateV1> {
	const activeRows = await transaction<ExecutionRow[]>`
		select execution_id, conversation_id, actor_id, turn_id, session_generation,
			status
		from platform.conversation_executions
		where conversation_id = ${conversation.conversationId}
			and status in ('submitted', 'processing', 'unknown')
		limit 2
		for update
	`;
	if (activeRows.length > 1) unavailable();
	const active = activeRows[0];
	if (!active) {
		return {
			conversation,
			sourceMessage: undefined,
			targetExecution: undefined,
			existingStop: undefined,
			activeExecution: undefined,
		};
	}
	const status = text(active.status);
	if (!activeExecutionStatuses.has(status)) unavailable();
	const stopRows = await transaction<StopRow[]>`
		select execution_id, stop_request_id, status
		from platform.conversation_stops
		where execution_id = ${active.execution_id}
		limit 1
	`;
	const stop = stopRows[0];
	if (stop && stop.status !== "submitted" && stop.status !== "completed")
		unavailable();
	return {
		conversation,
		sourceMessage: undefined,
		targetExecution: undefined,
		existingStop: undefined,
		activeExecution: {
			executionId: text(active.execution_id),
			conversationId: text(active.conversation_id),
			actorId: text(active.actor_id),
			turnId: text(active.turn_id),
			sessionGeneration: safeInteger(active.session_generation, 1),
			stopPending: stop?.status === "submitted",
			status: status as "submitted" | "processing" | "unknown",
		},
	};
}

async function readRegenerationState(
	transaction: Transaction,
	conversation: ConversationExecutionConversationStateV1,
	sourceMessageId: string,
): Promise<ConversationExecutionStateV1> {
	const state = await readMessageState(transaction, conversation);
	const rows = await transaction<
		{
			readonly message_id: string;
			readonly conversation_id: string;
			readonly actor_id: string;
			readonly role: string;
		}[]
	>`
		select message_id, conversation_id, actor_id, role
		from platform.conversation_messages
		where conversation_id = ${conversation.conversationId}
			and message_id = ${sourceMessageId}
		limit 1
	`;
	const source = rows[0];
	if (!source) return state;
	if (source.role !== "user") unavailable();
	return {
		...state,
		sourceMessage: {
			messageId: text(source.message_id),
			conversationId: text(source.conversation_id),
			actorId: text(source.actor_id),
			role: "user",
		},
	};
}

async function readStopState(
	transaction: Transaction,
	conversation: ConversationExecutionConversationStateV1,
	targetExecutionId: string,
): Promise<ConversationExecutionStateV1> {
	const state = await readMessageState(transaction, conversation);
	const rows = await transaction<
		{
			readonly execution_id: string;
			readonly conversation_id: string;
			readonly actor_id: string;
			readonly session_generation: string | number;
			readonly status: string;
		}[]
	>`
		select execution_id, conversation_id, actor_id, session_generation, status
		from platform.conversation_executions
		where conversation_id = ${conversation.conversationId}
			and execution_id = ${targetExecutionId}
		limit 1
		for update
	`;
	const target = rows[0];
	if (!target) return state;
	const status = text(target.status);
	if (!activeExecutionStatuses.has(status) && !executionIsTerminal(status)) {
		unavailable();
	}
	const stops = await transaction<StopRow[]>`
		select execution_id, stop_request_id, status
		from platform.conversation_stops
		where execution_id = ${target.execution_id}
		limit 1
	`;
	const stop = stops[0];
	if (stop && stop.status !== "submitted" && stop.status !== "completed") {
		unavailable();
	}
	return {
		...state,
		targetExecution: {
			executionId: text(target.execution_id),
			conversationId: text(target.conversation_id),
			actorId: text(target.actor_id),
			sessionGeneration: safeInteger(target.session_generation, 1),
			status: status as
				| "submitted"
				| "processing"
				| "unknown"
				| "completed"
				| "failed"
				| "cancelled",
		},
		existingStop: stop
			? {
					executionId: text(stop.execution_id),
					stopRequestId: text(stop.stop_request_id),
					status: stop.status as "submitted" | "completed",
				}
			: undefined,
	};
}

async function requireCreateReplay(
	transaction: Transaction,
	result: ReturnType<typeof parseCreatedResult>,
	authority: ConversationExecutionAuthorityV1,
): Promise<void> {
	const rows = await transaction<ConversationRow[]>`
		select id, agent_id, actor_id, channel_id, status, session_generation,
			host_session_ref, authorization_revision, last_conversation_cursor
		from platform.conversations where id = ${result.conversationId} limit 1
	`;
	const conversation = rows[0] && conversationFromRow(rows[0]);
	if (
		!conversation ||
		result.agentId !== authority.agentId ||
		!matchesBinding(conversation, authority)
	) {
		unavailable();
	}
}

async function requireMessageReplay(
	transaction: Transaction,
	result: ReturnType<typeof parseMessageResult>,
	conversationId: string,
	authority: ConversationExecutionAuthorityV1,
): Promise<void> {
	const rows = await transaction<
		{
			readonly message_id: string;
			readonly message_conversation_id: string;
			readonly message_actor_id: string;
			readonly execution_id: string;
			readonly execution_conversation_id: string;
			readonly execution_actor_id: string;
		}[]
	>`
		select message.message_id, message.conversation_id as message_conversation_id,
			message.actor_id as message_actor_id, execution.execution_id,
			execution.conversation_id as execution_conversation_id,
			execution.actor_id as execution_actor_id
		from platform.conversation_messages as message
		join platform.conversation_executions as execution
			on execution.execution_id = message.execution_id
		where message.message_id = ${result.messageId}
		limit 1
	`;
	const row = rows[0];
	if (
		!row ||
		row.message_conversation_id !== conversationId ||
		row.execution_conversation_id !== conversationId ||
		row.message_actor_id !== authority.actorId ||
		row.execution_actor_id !== authority.actorId ||
		row.execution_id !== result.executionId
	) {
		unavailable();
	}
}

async function requireRegenerationReplay(
	transaction: Transaction,
	result: ReturnType<typeof parseRegenerationResult>,
	conversationId: string,
	authority: ConversationExecutionAuthorityV1,
): Promise<void> {
	const rows = await transaction<
		{
			readonly execution_id: string;
			readonly conversation_id: string;
			readonly actor_id: string;
		}[]
	>`
		select execution_id, conversation_id, actor_id
		from platform.conversation_executions
		where execution_id = ${result.executionId}
		limit 1
	`;
	const execution = rows[0];
	if (
		!execution ||
		execution.conversation_id !== conversationId ||
		execution.actor_id !== authority.actorId
	) {
		unavailable();
	}
}

async function requireStopReplay(
	transaction: Transaction,
	result: ReturnType<typeof parseStopResult>,
	conversationId: string,
	authority: ConversationExecutionAuthorityV1,
): Promise<void> {
	const rows = await transaction<
		{
			readonly execution_id: string;
			readonly conversation_id: string;
			readonly actor_id: string;
			readonly status: string;
			readonly stop_request_id: string | null;
		}[]
	>`
		select execution.execution_id, execution.conversation_id, execution.actor_id,
			execution.status, stop.stop_request_id
		from platform.conversation_executions as execution
		left join platform.conversation_stops as stop
			on stop.execution_id = execution.execution_id
		where execution.execution_id = ${result.executionId}
		limit 1
	`;
	const execution = rows[0];
	if (
		!execution ||
		execution.conversation_id !== conversationId ||
		execution.actor_id !== authority.actorId ||
		(result.status === "submitted" && execution.stop_request_id === null) ||
		(result.status === "already_finished" &&
			!executionIsTerminal(execution.status))
	) {
		unavailable();
	}
}

export class PostgresConversationExecutionTransactionV1
	implements ConversationExecutionTransactionPortV1
{
	readonly #client: ReturnType<typeof postgres>;

	constructor(options: PostgresConversationExecutionOptionsV1) {
		try {
			this.#client = postgres(
				platformDatabaseUrlFromEnvironment({
					PLATFORM_DATABASE_URL: options.databaseUrl,
				}),
				{ max: 10 },
			);
		} catch {
			unavailable();
		}
	}

	async createConversation(
		request: CreateRequest,
		decide: CreateDecide,
	): Promise<CreateConversationDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			if (request.command.agentId !== authority.agentId) {
				return { outcome: "denied" };
			}
			const scope = {
				scopeType: "agent",
				scopeId: createIdempotencyScopeId(
					authority.agentId,
					authority.channelId,
				),
				actorId: authority.actorId,
				commandType: "conversation.create",
				key: text(request.command.idempotencyKey, 128),
			};
			const existing = await readIdempotency(transaction, scope);
			if (existing) {
				if (existing.request_digest !== request.requestDigest) {
					return { outcome: "conflict", reason: "idempotency_conflict" };
				}
				if (existing.status !== "completed") unavailable();
				const result = parseCreatedResult(existing.result);
				await requireCreateReplay(transaction, result, authority);
				return { outcome: "replayed", result };
			}
			const plan = validateCreatePlan(decide(), request);
			const occurredAt = new Date();
			const reservationId = await reserveIdempotency(transaction, {
				...scope,
				requestDigest: request.requestDigest,
				occurredAt,
			});
			if (!reservationId) {
				const raced = await readIdempotency(transaction, scope);
				if (!raced) unavailable();
				if (raced.request_digest !== request.requestDigest) {
					return { outcome: "conflict", reason: "idempotency_conflict" };
				}
				if (raced.status !== "completed") unavailable();
				const result = parseCreatedResult(raced.result);
				await requireCreateReplay(transaction, result, authority);
				return { outcome: "replayed", result };
			}
			await transaction`
				insert into platform.conversations
					(id, agent_id, actor_id, channel_id, status, session_generation,
					 host_session_ref, authorization_revision, last_conversation_cursor,
					 created_at, updated_at)
				values
					(${plan.conversation.conversationId}, ${plan.conversation.agentId},
					 ${plan.conversation.actorId}, ${plan.conversation.channelId},
					 ${plan.conversation.status}, ${plan.conversation.sessionGeneration},
					 ${plan.conversation.hostSessionRef},
					 ${plan.conversation.authorizationRevision},
					 ${plan.conversation.lastConversationCursor}, ${occurredAt}, ${occurredAt})
			`;
			await completeIdempotency(
				transaction,
				reservationId,
				plan.result,
				occurredAt,
			);
			return { outcome: "accepted", result: plan.result };
		});
	}

	async executeMessage(
		request: MessageRequest,
		decide: MessageDecide,
	): Promise<ConversationCommandDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			const conversation = await lockConversation(
				transaction,
				text(request.command.conversationId),
			);
			if (!conversation || !matchesBinding(conversation, authority)) {
				return { outcome: "denied" };
			}
			const scope = {
				scopeType: "conversation",
				scopeId: conversation.conversationId,
				actorId: authority.actorId,
				commandType: "message",
				key: text(request.command.idempotencyKey, 128),
			};
			const existing = await readIdempotency(transaction, scope);
			if (existing) {
				if (existing.request_digest !== request.requestDigest) {
					return { outcome: "conflict", reason: "idempotency_conflict" };
				}
				if (existing.status !== "completed") unavailable();
				const result = parseMessageResult(existing.result);
				await requireMessageReplay(
					transaction,
					result,
					conversation.conversationId,
					authority,
				);
				return { outcome: "replayed", result };
			}
			const state = await readMessageState(transaction, conversation);
			const decision = decide(state);
			if (!isMessagePlan(decision)) {
				return decision;
			}
			const plan = validateMessagePlan(decision, request, state);
			const reservationId = await reserveIdempotency(transaction, {
				...scope,
				requestDigest: request.requestDigest,
				occurredAt: plan.message.createdAt,
			});
			if (!reservationId) unavailable();
			const updated = await transaction<{ id: string }[]>`
				update platform.conversations
				set status = ${plan.conversation.status},
					authorization_revision = ${plan.conversation.authorizationRevision},
					updated_at = ${plan.message.createdAt}
				where id = ${conversation.conversationId}
				returning id
			`;
			if (updated.length !== 1) unavailable();
			if (plan.execution) {
				await transaction`
					insert into platform.conversation_executions
						(execution_id, conversation_id, agent_id, actor_id, channel_id,
						 turn_id, status, session_generation, delivery_fence,
						 authorization_revision, created_at, updated_at)
					values
						(${plan.execution.executionId}, ${plan.execution.conversationId},
						 ${plan.execution.agentId}, ${plan.execution.actorId},
						 ${plan.execution.channelId}, ${plan.execution.turnId},
						 ${plan.execution.status}, ${plan.execution.sessionGeneration},
						 ${plan.execution.deliveryFence},
						 ${plan.execution.authorizationRevision}, ${plan.execution.createdAt},
						 ${plan.execution.createdAt})
				`;
			}
			await transaction`
				insert into platform.conversation_messages
					(message_id, conversation_id, actor_id, role, text, execution_id,
					 status, created_at, updated_at)
				values
					(${plan.message.messageId}, ${plan.message.conversationId},
					 ${plan.message.actorId}, 'user', ${plan.message.text},
					 ${plan.message.executionId}, ${plan.message.status},
					 ${plan.message.createdAt}, ${plan.message.createdAt})
			`;
			await transaction`
				insert into platform.outbox_items
					(id, scope_type, scope_id, operation, payload, trace_id, request_id,
					 available_at, created_at, updated_at)
				values
					(${outboxId(
						plan.outboxIntent.operation,
						plan.outboxIntent.messageId,
						plan.outboxIntent.executionId,
					)}, 'conversation', ${plan.outboxIntent.conversationId},
					 ${plan.outboxIntent.operation}, ${transaction.json({
							schemaVersion: 1,
							conversationId: plan.outboxIntent.conversationId,
							executionId: plan.outboxIntent.executionId,
							messageId: plan.outboxIntent.messageId,
							turnId: plan.outboxIntent.turnId,
							sessionGeneration: plan.outboxIntent.sessionGeneration,
						} as JsonValue)}, ${plan.outboxIntent.traceId},
					 ${plan.outboxIntent.requestId}, ${plan.outboxIntent.occurredAt},
					 ${plan.outboxIntent.occurredAt}, ${plan.outboxIntent.occurredAt})
			`;
			await transaction`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id,
					 request_id, occurred_at)
				values
					(${randomUUID()}, ${plan.auditEvent.conversationId},
					 ${plan.auditEvent.executionId}, ${plan.auditEvent.agentId},
					 ${plan.auditEvent.actorId}, ${plan.auditEvent.action},
					 ${plan.auditEvent.traceId}, ${plan.auditEvent.requestId},
					 ${plan.auditEvent.occurredAt})
			`;
			await completeIdempotency(
				transaction,
				reservationId,
				plan.result,
				plan.message.createdAt,
			);
			return { outcome: "accepted", result: plan.result };
		});
	}

	async executeRegeneration(
		request: RegenerationRequest,
		decide: RegenerationDecide,
	): Promise<ConversationCommandDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			const conversation = await lockConversation(
				transaction,
				text(request.command.conversationId),
			);
			if (!conversation || !matchesBinding(conversation, authority)) {
				return { outcome: "denied" };
			}
			const scope = {
				scopeType: "conversation",
				scopeId: conversation.conversationId,
				actorId: authority.actorId,
				commandType: "regenerate",
				key: text(request.command.idempotencyKey, 128),
			};
			const existing = await readIdempotency(transaction, scope);
			if (existing) {
				if (existing.request_digest !== request.requestDigest) {
					return { outcome: "conflict", reason: "idempotency_conflict" };
				}
				if (existing.status !== "completed") unavailable();
				const result = parseRegenerationResult(existing.result);
				await requireRegenerationReplay(
					transaction,
					result,
					conversation.conversationId,
					authority,
				);
				return { outcome: "replayed", result };
			}
			const state = await readRegenerationState(
				transaction,
				conversation,
				text(request.command.sourceMessageId),
			);
			const decision = decide(state);
			if (!isRegenerationPlan(decision)) return decision;
			const plan = validateRegenerationPlan(decision, request, state);
			const reservationId = await reserveIdempotency(transaction, {
				...scope,
				requestDigest: request.requestDigest,
				occurredAt: plan.execution.createdAt,
			});
			if (!reservationId) unavailable();
			const updated = await transaction<{ id: string }[]>`
				update platform.conversations
				set status = ${plan.conversation.status},
					authorization_revision = ${plan.conversation.authorizationRevision},
					updated_at = ${plan.execution.createdAt}
				where id = ${conversation.conversationId}
				returning id
			`;
			if (updated.length !== 1) unavailable();
			await transaction`
				insert into platform.conversation_executions
					(execution_id, conversation_id, agent_id, actor_id, channel_id,
					 turn_id, status, session_generation, delivery_fence,
					 authorization_revision, created_at, updated_at)
				values
					(${plan.execution.executionId}, ${plan.execution.conversationId},
					 ${plan.execution.agentId}, ${plan.execution.actorId},
					 ${plan.execution.channelId}, ${plan.execution.turnId},
					 ${plan.execution.status}, ${plan.execution.sessionGeneration},
					 ${plan.execution.deliveryFence},
					 ${plan.execution.authorizationRevision}, ${plan.execution.createdAt},
					 ${plan.execution.createdAt})
			`;
			await transaction`
				insert into platform.outbox_items
					(id, scope_type, scope_id, operation, payload, trace_id, request_id,
					 available_at, created_at, updated_at)
				values
					(${`conversation:regenerate:${plan.execution.executionId}`},
					 'conversation', ${plan.outboxIntent.conversationId},
					 ${plan.outboxIntent.operation}, ${transaction.json({
							schemaVersion: 1,
							conversationId: plan.outboxIntent.conversationId,
							executionId: plan.outboxIntent.executionId,
							messageId: plan.outboxIntent.messageId,
							turnId: plan.outboxIntent.turnId,
							sessionGeneration: plan.outboxIntent.sessionGeneration,
						} as JsonValue)}, ${plan.outboxIntent.traceId},
					 ${plan.outboxIntent.requestId}, ${plan.outboxIntent.occurredAt},
					 ${plan.outboxIntent.occurredAt}, ${plan.outboxIntent.occurredAt})
			`;
			await transaction`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id,
					 request_id, occurred_at)
				values
					(${randomUUID()}, ${plan.auditEvent.conversationId},
					 ${plan.auditEvent.executionId}, ${plan.auditEvent.agentId},
					 ${plan.auditEvent.actorId}, ${plan.auditEvent.action},
					 ${plan.auditEvent.traceId}, ${plan.auditEvent.requestId},
					 ${plan.auditEvent.occurredAt})
			`;
			await completeIdempotency(
				transaction,
				reservationId,
				plan.result,
				plan.execution.createdAt,
			);
			return { outcome: "accepted", result: plan.result };
		});
	}

	async executeStop(
		request: StopRequest,
		decide: StopDecide,
	): Promise<ConversationStopDecisionV1> {
		return this.#transaction(async (transaction) => {
			const authority = parseAuthority(request.authority);
			const conversation = await lockConversation(
				transaction,
				text(request.command.conversationId),
			);
			if (!conversation || !matchesBinding(conversation, authority)) {
				return { outcome: "denied" };
			}
			const scope = {
				scopeType: "conversation",
				scopeId: conversation.conversationId,
				actorId: authority.actorId,
				commandType: "stop",
				key: text(request.command.idempotencyKey, 128),
			};
			const existing = await readIdempotency(transaction, scope);
			if (existing) {
				if (existing.request_digest !== request.requestDigest) {
					return { outcome: "conflict", reason: "idempotency_conflict" };
				}
				if (existing.status !== "completed") unavailable();
				const result = parseStopResult(existing.result);
				await requireStopReplay(
					transaction,
					result,
					conversation.conversationId,
					authority,
				);
				return { outcome: "replayed", result };
			}
			const state = await readStopState(
				transaction,
				conversation,
				text(request.command.targetExecutionId),
			);
			const decision = decide(state);
			if (!isStopPlan(decision)) {
				const validated = validateStopNoop(decision, request, state);
				if (validated.outcome === "denied") return validated;
				const occurredAt = new Date();
				const reservationId = await reserveIdempotency(transaction, {
					...scope,
					requestDigest: request.requestDigest,
					occurredAt,
				});
				if (!reservationId) unavailable();
				await completeIdempotency(
					transaction,
					reservationId,
					validated.result,
					occurredAt,
				);
				return validated;
			}
			const plan = validateStopPlan(decision, request, state);
			const reservationId = await reserveIdempotency(transaction, {
				...scope,
				requestDigest: request.requestDigest,
				occurredAt: plan.outboxIntent.occurredAt,
			});
			if (!reservationId) unavailable();
			await transaction`
				insert into platform.conversation_stops
					(execution_id, stop_request_id, status, created_at, updated_at)
				values
					(${plan.targetExecution.executionId}, ${plan.stopRequestId}, 'submitted',
					 ${plan.outboxIntent.occurredAt}, ${plan.outboxIntent.occurredAt})
			`;
			await transaction`
				insert into platform.outbox_items
					(id, scope_type, scope_id, operation, payload, trace_id, request_id,
					 available_at, created_at, updated_at)
				values
					(${`conversation:stop:${plan.stopRequestId}`}, 'conversation',
					 ${plan.outboxIntent.conversationId}, ${plan.outboxIntent.operation},
					 ${transaction.json({
							schemaVersion: 1,
							conversationId: plan.outboxIntent.conversationId,
							executionId: plan.outboxIntent.executionId,
							sessionGeneration: plan.outboxIntent.sessionGeneration,
							stopRequestId: plan.outboxIntent.stopRequestId,
						} as JsonValue)}, ${plan.outboxIntent.traceId},
					 ${plan.outboxIntent.requestId}, ${plan.outboxIntent.occurredAt},
					 ${plan.outboxIntent.occurredAt}, ${plan.outboxIntent.occurredAt})
			`;
			await transaction`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id,
					 request_id, occurred_at)
				values
					(${randomUUID()}, ${plan.auditEvent.conversationId},
					 ${plan.auditEvent.executionId}, ${plan.auditEvent.agentId},
					 ${plan.auditEvent.actorId}, ${plan.auditEvent.action},
					 ${plan.auditEvent.traceId}, ${plan.auditEvent.requestId},
					 ${plan.auditEvent.occurredAt})
			`;
			await completeIdempotency(
				transaction,
				reservationId,
				plan.result,
				plan.outboxIntent.occurredAt,
			);
			return { outcome: "accepted", result: plan.result };
		});
	}

	async close(): Promise<void> {
		try {
			await this.#client.end();
		} catch {
			unavailable();
		}
	}

	async #transaction<T>(
		work: (transaction: Transaction) => Promise<T>,
	): Promise<T> {
		try {
			return (await this.#client.begin(async (transaction) => {
				await transaction`select set_config('lock_timeout', '5s', true)`;
				return work(transaction);
			})) as T;
		} catch (error) {
			if (error instanceof ConversationExecutionError) throw error;
			return unavailable();
		}
	}
}
