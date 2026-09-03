import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { types } from "node:util";

import { platformIdempotencyV1 } from "./idempotency.js";

const idempotencyKeyPattern = /^[A-Za-z0-9._~-]{1,128}$/;

export interface ConversationExecutionAuthorityV1 {
	readonly schemaVersion: 1;
	readonly actorId: string;
	readonly agentId: string;
	readonly channelId: string;
	readonly authorizationRevision: string;
	readonly supportsSupplementaryInstruction: boolean;
}

export interface ConversationExecutionAuthorizationPortV1 {
	authorize(input: {
		readonly schemaVersion: 1;
		readonly operation:
			| "conversation.create"
			| "message"
			| "regenerate"
			| "stop";
		readonly agentId?: string;
		readonly conversationId?: string;
	}): Promise<
		| {
				readonly outcome: "allowed";
				readonly authority: ConversationExecutionAuthorityV1;
		  }
		| { readonly outcome: "denied" }
	>;
}

export interface CreateConversationCommandV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export interface ConversationMessageCommandV1 {
	readonly schemaVersion: 1;
	readonly command: "message";
	readonly conversationId: string;
	readonly text: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export interface ConversationRegenerateCommandV1 {
	readonly schemaVersion: 1;
	readonly command: "regenerate";
	readonly conversationId: string;
	readonly sourceMessageId: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export interface ConversationStopCommandV1 {
	readonly schemaVersion: 1;
	readonly command: "stop";
	readonly conversationId: string;
	readonly targetExecutionId: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export interface ConversationExecutionConversationStateV1 {
	readonly schemaVersion: 1;
	readonly conversationId: string;
	readonly agentId: string;
	readonly actorId: string;
	readonly channelId: string;
	readonly status: "ready" | "active" | "unavailable";
	readonly sessionGeneration: number;
	readonly hostSessionRef: string | null;
	readonly authorizationRevision: string;
	readonly lastConversationCursor: number;
}

export interface ConversationExecutionStateV1 {
	readonly conversation: ConversationExecutionConversationStateV1 | undefined;
	readonly sourceMessage:
		| {
				readonly messageId: string;
				readonly conversationId: string;
				readonly actorId: string;
				readonly role: "user";
		  }
		| undefined;
	readonly targetExecution:
		| {
				readonly executionId: string;
				readonly conversationId: string;
				readonly actorId: string;
				readonly status:
					| "submitted"
					| "processing"
					| "unknown"
					| "completed"
					| "failed"
					| "cancelled";
		  }
		| undefined;
	readonly existingStop:
		| {
				readonly executionId: string;
				readonly stopRequestId: string;
				readonly status: "submitted" | "completed";
		  }
		| undefined;
	readonly activeExecution:
		| {
				readonly executionId: string;
				readonly conversationId: string;
				readonly actorId: string;
				readonly turnId: string;
				readonly status: "submitted" | "processing" | "unknown";
		  }
		| undefined;
}

export interface ConversationCreatedResultV1 {
	readonly schemaVersion: 1;
	readonly conversationId: string;
	readonly agentId: string;
	readonly status: "ready";
}

export interface ConversationCommandResultV1 {
	readonly schemaVersion: 1;
	readonly status: "submitted";
	readonly messageId: string | null;
	readonly executionId: string;
}

export interface ConversationStopResultV1 {
	readonly schemaVersion: 1;
	readonly status: "submitted" | "already_finished";
	readonly executionId: string;
}

export type CreateConversationDecisionV1 =
	| {
			readonly outcome: "accepted" | "replayed";
			readonly result: ConversationCreatedResultV1;
	  }
	| { readonly outcome: "denied" }
	| { readonly outcome: "conflict"; readonly reason: "idempotency_conflict" };

export type ConversationCommandDecisionV1 =
	| {
			readonly outcome: "accepted" | "replayed";
			readonly result: ConversationCommandResultV1;
	  }
	| { readonly outcome: "busy" }
	| { readonly outcome: "denied" }
	| { readonly outcome: "conflict"; readonly reason: "idempotency_conflict" };

export type ConversationStopDecisionV1 =
	| {
			readonly outcome: "accepted" | "replayed";
			readonly result: ConversationStopResultV1;
	  }
	| { readonly outcome: "denied" }
	| { readonly outcome: "conflict"; readonly reason: "idempotency_conflict" };

export interface CreateConversationWritePlanV1 {
	readonly schemaVersion: 1;
	readonly conversation: ConversationExecutionConversationStateV1;
	readonly result: ConversationCreatedResultV1;
	readonly idempotency: {
		readonly scopeType: "agent";
		readonly scopeId: string;
		readonly actorId: string;
		readonly channelId: string;
		readonly commandType: "conversation.create";
		readonly key: string;
		readonly requestDigest: string;
	};
}

export interface ConversationMessageWritePlanV1 {
	readonly schemaVersion: 1;
	readonly kind: "initial" | "supplement";
	readonly conversation: ConversationExecutionConversationStateV1;
	readonly message: {
		readonly messageId: string;
		readonly conversationId: string;
		readonly actorId: string;
		readonly text: string;
		readonly executionId: string;
		readonly status: "submitted";
		readonly createdAt: Date;
	};
	readonly execution?: {
		readonly executionId: string;
		readonly conversationId: string;
		readonly agentId: string;
		readonly actorId: string;
		readonly channelId: string;
		readonly turnId: string;
		readonly status: "submitted";
		readonly sessionGeneration: number;
		readonly deliveryFence: number;
		readonly authorizationRevision: string;
		readonly createdAt: Date;
	};
	readonly outboxIntent: {
		readonly operation:
			| "conversation.turn.submit.v1"
			| "conversation.turn.supplement.v1";
		readonly conversationId: string;
		readonly executionId: string;
		readonly messageId: string;
		readonly turnId: string;
		readonly sessionGeneration: number;
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
	readonly auditEvent: {
		readonly action:
			| "conversation.message.accepted"
			| "conversation.message.supplemented";
		readonly actorId: string;
		readonly agentId: string;
		readonly conversationId: string;
		readonly executionId: string;
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
	readonly result: ConversationCommandResultV1;
	readonly idempotency: {
		readonly scopeType: "conversation";
		readonly scopeId: string;
		readonly actorId: string;
		readonly commandType: "message";
		readonly key: string;
		readonly requestDigest: string;
	};
}

export interface ConversationRegenerationWritePlanV1 {
	readonly schemaVersion: 1;
	readonly kind: "regenerate";
	readonly conversation: ConversationExecutionConversationStateV1;
	readonly execution: {
		readonly executionId: string;
		readonly conversationId: string;
		readonly agentId: string;
		readonly actorId: string;
		readonly channelId: string;
		readonly turnId: string;
		readonly status: "submitted";
		readonly sessionGeneration: number;
		readonly deliveryFence: number;
		readonly authorizationRevision: string;
		readonly createdAt: Date;
	};
	readonly outboxIntent: {
		readonly operation: "conversation.turn.regenerate.v1";
		readonly conversationId: string;
		readonly executionId: string;
		readonly messageId: string;
		readonly turnId: string;
		readonly sessionGeneration: number;
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
	readonly auditEvent: {
		readonly action: "conversation.regeneration.accepted";
		readonly actorId: string;
		readonly agentId: string;
		readonly conversationId: string;
		readonly executionId: string;
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
	readonly result: ConversationCommandResultV1;
	readonly idempotency: {
		readonly scopeType: "conversation";
		readonly scopeId: string;
		readonly actorId: string;
		readonly commandType: "regenerate";
		readonly key: string;
		readonly requestDigest: string;
	};
}

export interface ConversationStopWritePlanV1 {
	readonly schemaVersion: 1;
	readonly targetExecution: {
		readonly executionId: string;
		readonly conversationId: string;
		readonly actorId: string;
	};
	readonly stopRequestId: string;
	readonly outboxIntent: {
		readonly operation: "conversation.turn.stop.v1";
		readonly conversationId: string;
		readonly executionId: string;
		readonly sessionGeneration: number;
		readonly stopRequestId: string;
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
	readonly auditEvent: {
		readonly action: "conversation.stop.accepted";
		readonly actorId: string;
		readonly agentId: string;
		readonly conversationId: string;
		readonly executionId: string;
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
	readonly result: ConversationStopResultV1;
	readonly idempotency: {
		readonly scopeType: "conversation";
		readonly scopeId: string;
		readonly actorId: string;
		readonly commandType: "stop";
		readonly key: string;
		readonly requestDigest: string;
	};
}

export interface ConversationExecutionTransactionPortV1 {
	/**
	 * Existing Conversation commands validate the persisted authority binding
	 * before replay, then inspect active execution only after a replay miss.
	 */
	createConversation(
		request: {
			readonly command: CreateConversationCommandV1;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
		decide: () => CreateConversationWritePlanV1,
	): Promise<CreateConversationDecisionV1>;
	executeMessage(
		request: {
			readonly command: ConversationMessageCommandV1;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
		decide: (
			state: ConversationExecutionStateV1,
		) =>
			| ConversationMessageWritePlanV1
			| Extract<ConversationCommandDecisionV1, { outcome: "busy" | "denied" }>,
	): Promise<ConversationCommandDecisionV1>;
	executeRegeneration(
		request: {
			readonly command: ConversationRegenerateCommandV1;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
		decide: (
			state: ConversationExecutionStateV1,
		) =>
			| ConversationRegenerationWritePlanV1
			| Extract<ConversationCommandDecisionV1, { outcome: "busy" | "denied" }>,
	): Promise<ConversationCommandDecisionV1>;
	executeStop(
		request: {
			readonly command: ConversationStopCommandV1;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
		decide: (
			state: ConversationExecutionStateV1,
		) =>
			| ConversationStopWritePlanV1
			| Extract<
					ConversationStopDecisionV1,
					{ outcome: "accepted" | "replayed" | "denied" }
			  >,
	): Promise<ConversationStopDecisionV1>;
}

export interface ConversationExecutionUseCaseV1 {
	createConversation(
		command: CreateConversationCommandV1,
	): Promise<CreateConversationDecisionV1>;
	accept(
		command: ConversationMessageCommandV1,
	): Promise<ConversationCommandDecisionV1>;
	regenerate(
		command: ConversationRegenerateCommandV1,
	): Promise<ConversationCommandDecisionV1>;
	stop(command: ConversationStopCommandV1): Promise<ConversationStopDecisionV1>;
}

export interface ConversationExecutionUseCaseDependenciesV1 {
	readonly authorization: ConversationExecutionAuthorizationPortV1;
	readonly transaction: ConversationExecutionTransactionPortV1;
}

export interface ConversationExecutionUseCaseOptionsV1 {
	readonly now?: () => Date;
	readonly newId?: () => string;
}

export class ConversationExecutionError extends Error {
	readonly code: "invalid_input" | "unavailable";

	constructor(code: "invalid_input" | "unavailable") {
		super(
			code === "invalid_input"
				? "Invalid conversation command"
				: "Conversation persistence is unavailable",
		);
		this.name = "ConversationExecutionError";
		this.code = code;
	}
}

function invalidInput(): never {
	throw new ConversationExecutionError("invalid_input");
}

function unavailable(): never {
	throw new ConversationExecutionError("unavailable");
}

function snapshotObject(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			types.isProxy(input)
		) {
			invalidInput();
		}
		const descriptors = Object.getOwnPropertyDescriptors(input);
		if (
			Reflect.ownKeys(descriptors).length !== keys.length ||
			keys.some((key) => !Object.hasOwn(descriptors, key))
		) {
			invalidInput();
		}
		const values: Record<string, unknown> = {};
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (
				descriptor?.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
				invalidInput();
			}
			values[key] = descriptor.value;
		}
		return values;
	} catch (error) {
		if (error instanceof ConversationExecutionError) throw error;
		invalidInput();
	}
}

function isText(value: unknown, maximum = 65_536): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= maximum
	);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseCreateCommand(input: unknown): CreateConversationCommandV1 {
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

function parseMessageCommand(input: unknown): ConversationMessageCommandV1 {
	const values = snapshotObject(input, [
		"schemaVersion",
		"command",
		"conversationId",
		"text",
		"idempotencyKey",
		"requestId",
		"traceId",
	]);
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
	return {
		schemaVersion: 1,
		command: "message",
		conversationId: values.conversationId,
		text: values.text,
		idempotencyKey: values.idempotencyKey,
		requestId: values.requestId,
		traceId: values.traceId,
	};
}

function parseRegenerateCommand(
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

function parseStopCommand(input: unknown): ConversationStopCommandV1 {
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

function parseAuthority(input: unknown): ConversationExecutionAuthorityV1 {
	const values = snapshotObject(input, [
		"schemaVersion",
		"actorId",
		"agentId",
		"channelId",
		"authorizationRevision",
		"supportsSupplementaryInstruction",
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
	return {
		schemaVersion: 1,
		actorId: values.actorId,
		agentId: values.agentId,
		channelId: values.channelId,
		authorizationRevision: values.authorizationRevision,
		supportsSupplementaryInstruction: values.supportsSupplementaryInstruction,
	};
}

async function authorize(
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
	} catch (error) {
		if (error instanceof ConversationExecutionError) throw error;
		unavailable();
	}
}

function safeNow(now: () => Date): Date {
	try {
		const milliseconds = Date.prototype.getTime.call(now());
		if (!Number.isFinite(milliseconds)) throw new Error();
		return new Date(milliseconds);
	} catch {
		return unavailable();
	}
}

function nextOpaqueId(newId: () => string): string {
	try {
		const value = newId();
		if (!isText(value)) unavailable();
		return value;
	} catch {
		return unavailable();
	}
}

function parseState(
	input: ConversationExecutionStateV1,
): ConversationExecutionStateV1 {
	try {
		const values = snapshotObject(input, [
			"conversation",
			"sourceMessage",
			"targetExecution",
			"existingStop",
			"activeExecution",
		]);
		if (values.conversation === undefined) {
			if (
				values.sourceMessage !== undefined ||
				values.targetExecution !== undefined ||
				values.existingStop !== undefined ||
				values.activeExecution !== undefined
			) {
				unavailable();
			}
			return {
				conversation: undefined,
				sourceMessage: undefined,
				targetExecution: undefined,
				existingStop: undefined,
				activeExecution: undefined,
			};
		}
		const conversation = snapshotObject(values.conversation, [
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
		const sessionGenerationInput = conversation.sessionGeneration;
		const lastConversationCursorInput = conversation.lastConversationCursor;
		if (
			conversation.schemaVersion !== 1 ||
			!isText(conversation.conversationId) ||
			!isText(conversation.agentId) ||
			!isText(conversation.actorId) ||
			!isText(conversation.channelId) ||
			(conversation.status !== "ready" &&
				conversation.status !== "active" &&
				conversation.status !== "unavailable") ||
			!isPositiveSafeInteger(sessionGenerationInput) ||
			(conversation.hostSessionRef !== null &&
				!isText(conversation.hostSessionRef)) ||
			!isText(conversation.authorizationRevision) ||
			!isNonNegativeSafeInteger(lastConversationCursorInput)
		) {
			unavailable();
		}
		const sourceMessage = (() => {
			if (values.sourceMessage === undefined) return undefined;
			const message = snapshotObject(values.sourceMessage, [
				"messageId",
				"conversationId",
				"actorId",
				"role",
			]);
			if (
				!isText(message.messageId) ||
				!isText(message.conversationId) ||
				!isText(message.actorId) ||
				message.role !== "user"
			) {
				unavailable();
			}
			return {
				messageId: message.messageId,
				conversationId: message.conversationId,
				actorId: message.actorId,
				role: "user" as const,
			};
		})();
		const targetExecution = (() => {
			if (values.targetExecution === undefined) return undefined;
			const execution = snapshotObject(values.targetExecution, [
				"executionId",
				"conversationId",
				"actorId",
				"status",
			]);
			const status = execution.status;
			if (
				!isText(execution.executionId) ||
				!isText(execution.conversationId) ||
				!isText(execution.actorId) ||
				(status !== "submitted" &&
					status !== "processing" &&
					status !== "unknown" &&
					status !== "completed" &&
					status !== "failed" &&
					status !== "cancelled")
			) {
				unavailable();
			}
			return {
				executionId: execution.executionId,
				conversationId: execution.conversationId,
				actorId: execution.actorId,
				status: status as NonNullable<
					ConversationExecutionStateV1["targetExecution"]
				>["status"],
			};
		})();
		const existingStop = (() => {
			if (values.existingStop === undefined) return undefined;
			const stop = snapshotObject(values.existingStop, [
				"executionId",
				"stopRequestId",
				"status",
			]);
			if (
				!isText(stop.executionId) ||
				!isText(stop.stopRequestId) ||
				(stop.status !== "submitted" && stop.status !== "completed")
			) {
				unavailable();
			}
			return {
				executionId: stop.executionId,
				stopRequestId: stop.stopRequestId,
				status: stop.status as "submitted" | "completed",
			};
		})();
		const activeExecution = (() => {
			if (values.activeExecution === undefined) return undefined;
			const execution = snapshotObject(values.activeExecution, [
				"executionId",
				"conversationId",
				"actorId",
				"turnId",
				"status",
			]);
			const executionStatus = execution.status;
			if (
				!isText(execution.executionId) ||
				!isText(execution.conversationId) ||
				!isText(execution.actorId) ||
				!isText(execution.turnId) ||
				(executionStatus !== "submitted" &&
					executionStatus !== "processing" &&
					executionStatus !== "unknown")
			) {
				unavailable();
			}
			return {
				executionId: execution.executionId,
				conversationId: execution.conversationId,
				actorId: execution.actorId,
				turnId: execution.turnId,
				status: executionStatus as "submitted" | "processing" | "unknown",
			};
		})();
		if (
			activeExecution &&
			activeExecution.conversationId !== conversation.conversationId
		) {
			unavailable();
		}
		if (
			sourceMessage &&
			sourceMessage.conversationId !== conversation.conversationId
		) {
			unavailable();
		}
		if (
			targetExecution &&
			targetExecution.conversationId !== conversation.conversationId
		) {
			unavailable();
		}
		if (
			existingStop &&
			(!targetExecution ||
				existingStop.executionId !== targetExecution.executionId)
		) {
			unavailable();
		}
		const sessionGeneration = conversation.sessionGeneration as number;
		const lastConversationCursor =
			conversation.lastConversationCursor as number;
		const status =
			conversation.status as ConversationExecutionConversationStateV1["status"];
		return {
			conversation: {
				schemaVersion: 1,
				conversationId: conversation.conversationId,
				agentId: conversation.agentId,
				actorId: conversation.actorId,
				channelId: conversation.channelId,
				status,
				sessionGeneration,
				hostSessionRef: conversation.hostSessionRef,
				authorizationRevision: conversation.authorizationRevision,
				lastConversationCursor,
			},
			sourceMessage,
			targetExecution,
			existingStop,
			activeExecution,
		};
	} catch {
		return unavailable();
	}
}

function digest(input: unknown): string {
	try {
		return platformIdempotencyV1.canonicalRequestDigest(input as never);
	} catch {
		return unavailable();
	}
}

function trySnapshotObject(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> | undefined {
	try {
		return snapshotObject(input, keys);
	} catch {
		return undefined;
	}
}

function transactionObject(
	input: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	return trySnapshotObject(input, keys) ?? unavailable();
}

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

function parseMessageCommandResult(
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

function parseRegenerationCommandResult(
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

function normalizeCreateDecision(
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

function normalizeCommandDecision(
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

function normalizeStopDecision(
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

export function createConversationExecutionUseCaseV1(
	dependencies: ConversationExecutionUseCaseDependenciesV1,
	options: ConversationExecutionUseCaseOptionsV1 = {},
): ConversationExecutionUseCaseV1 {
	const now = options.now ?? (() => new Date());
	const newId = options.newId ?? randomUUID;
	return {
		async createConversation(commandInput) {
			const command = parseCreateCommand(commandInput);
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "conversation.create",
				agentId: command.agentId,
			});
			if (!authority || authority.agentId !== command.agentId)
				return { outcome: "denied" };
			const requestDigest = digest({
				schemaVersion: command.schemaVersion,
				command: "conversation.create",
				agentId: command.agentId,
			});
			try {
				return normalizeCreateDecision(
					await dependencies.transaction.createConversation(
						{ command, authority, requestDigest },
						() => {
							const conversationId = nextOpaqueId(newId);
							const result: ConversationCreatedResultV1 = {
								schemaVersion: 1,
								conversationId,
								agentId: authority.agentId,
								status: "ready",
							};
							return {
								schemaVersion: 1,
								conversation: {
									schemaVersion: 1,
									conversationId,
									agentId: authority.agentId,
									actorId: authority.actorId,
									channelId: authority.channelId,
									status: "ready",
									sessionGeneration: 1,
									hostSessionRef: null,
									authorizationRevision: authority.authorizationRevision,
									lastConversationCursor: 0,
								},
								result,
								idempotency: {
									scopeType: "agent",
									scopeId: authority.agentId,
									actorId: authority.actorId,
									channelId: authority.channelId,
									commandType: "conversation.create",
									key: command.idempotencyKey,
									requestDigest,
								},
							};
						},
					),
					authority.agentId,
				);
			} catch (error) {
				if (error instanceof ConversationExecutionError) throw error;
				return unavailable();
			}
		},
		async accept(commandInput) {
			const command = parseMessageCommand(commandInput);
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "message",
				conversationId: command.conversationId,
			});
			if (!authority) return { outcome: "denied" };
			const requestDigest = digest({
				schemaVersion: command.schemaVersion,
				command: command.command,
				conversationId: command.conversationId,
				text: command.text,
			});
			try {
				return normalizeCommandDecision(
					await dependencies.transaction.executeMessage(
						{ command, authority, requestDigest },
						(stateInput) => {
							const state = parseState(stateInput);
							const conversation = state.conversation;
							if (
								!conversation ||
								conversation.conversationId !== command.conversationId ||
								conversation.actorId !== authority.actorId ||
								conversation.agentId !== authority.agentId ||
								conversation.channelId !== authority.channelId
							) {
								return { outcome: "denied" };
							}
							if (conversation.status === "unavailable")
								return { outcome: "denied" };
							if (state.activeExecution) {
								if (
									!authority.supportsSupplementaryInstruction ||
									state.activeExecution.actorId !== authority.actorId
								) {
									return { outcome: "busy" };
								}
								const occurredAt = safeNow(now);
								const messageId = nextOpaqueId(newId);
								const result: ConversationCommandResultV1 = {
									schemaVersion: 1,
									status: "submitted",
									messageId,
									executionId: state.activeExecution.executionId,
								};
								return {
									schemaVersion: 1,
									kind: "supplement",
									conversation: {
										...conversation,
										authorizationRevision: authority.authorizationRevision,
									},
									message: {
										messageId,
										conversationId: conversation.conversationId,
										actorId: authority.actorId,
										text: command.text,
										executionId: state.activeExecution.executionId,
										status: "submitted",
										createdAt: occurredAt,
									},
									outboxIntent: {
										operation: "conversation.turn.supplement.v1",
										conversationId: conversation.conversationId,
										executionId: state.activeExecution.executionId,
										messageId,
										turnId: state.activeExecution.turnId,
										sessionGeneration: conversation.sessionGeneration,
										traceId: command.traceId,
										requestId: command.requestId,
										occurredAt,
									},
									auditEvent: {
										action: "conversation.message.supplemented",
										actorId: authority.actorId,
										agentId: authority.agentId,
										conversationId: conversation.conversationId,
										executionId: state.activeExecution.executionId,
										traceId: command.traceId,
										requestId: command.requestId,
										occurredAt,
									},
									result,
									idempotency: {
										scopeType: "conversation",
										scopeId: conversation.conversationId,
										actorId: authority.actorId,
										commandType: "message",
										key: command.idempotencyKey,
										requestDigest,
									},
								};
							}
							const occurredAt = safeNow(now);
							const messageId = nextOpaqueId(newId);
							const executionId = nextOpaqueId(newId);
							const turnId = nextOpaqueId(newId);
							const result: ConversationCommandResultV1 = {
								schemaVersion: 1,
								status: "submitted",
								messageId,
								executionId,
							};
							return {
								schemaVersion: 1,
								kind: "initial",
								conversation: {
									...conversation,
									status: "active",
									authorizationRevision: authority.authorizationRevision,
								},
								message: {
									messageId,
									conversationId: conversation.conversationId,
									actorId: authority.actorId,
									text: command.text,
									executionId,
									status: "submitted",
									createdAt: occurredAt,
								},
								execution: {
									executionId,
									conversationId: conversation.conversationId,
									agentId: authority.agentId,
									actorId: authority.actorId,
									channelId: authority.channelId,
									turnId,
									status: "submitted",
									sessionGeneration: conversation.sessionGeneration,
									deliveryFence: 0,
									authorizationRevision: authority.authorizationRevision,
									createdAt: occurredAt,
								},
								outboxIntent: {
									operation: "conversation.turn.submit.v1",
									conversationId: conversation.conversationId,
									executionId,
									messageId,
									turnId,
									sessionGeneration: conversation.sessionGeneration,
									traceId: command.traceId,
									requestId: command.requestId,
									occurredAt,
								},
								auditEvent: {
									action: "conversation.message.accepted",
									actorId: authority.actorId,
									agentId: authority.agentId,
									conversationId: conversation.conversationId,
									executionId,
									traceId: command.traceId,
									requestId: command.requestId,
									occurredAt,
								},
								result,
								idempotency: {
									scopeType: "conversation",
									scopeId: conversation.conversationId,
									actorId: authority.actorId,
									commandType: "message",
									key: command.idempotencyKey,
									requestDigest,
								},
							};
						},
					),
					parseMessageCommandResult,
				);
			} catch (error) {
				if (error instanceof ConversationExecutionError) throw error;
				return unavailable();
			}
		},
		async regenerate(commandInput) {
			const command = parseRegenerateCommand(commandInput);
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "regenerate",
				conversationId: command.conversationId,
			});
			if (!authority) return { outcome: "denied" };
			const requestDigest = digest({
				schemaVersion: command.schemaVersion,
				command: command.command,
				conversationId: command.conversationId,
				sourceMessageId: command.sourceMessageId,
			});
			try {
				return normalizeCommandDecision(
					await dependencies.transaction.executeRegeneration(
						{ command, authority, requestDigest },
						(stateInput) => {
							const state = parseState(stateInput);
							const conversation = state.conversation;
							const sourceMessage = state.sourceMessage;
							if (
								!conversation ||
								conversation.conversationId !== command.conversationId ||
								conversation.actorId !== authority.actorId ||
								conversation.agentId !== authority.agentId ||
								conversation.channelId !== authority.channelId ||
								!sourceMessage ||
								sourceMessage.messageId !== command.sourceMessageId ||
								sourceMessage.actorId !== authority.actorId
							) {
								return { outcome: "denied" };
							}
							if (conversation.status === "unavailable")
								return { outcome: "denied" };
							if (state.activeExecution) return { outcome: "busy" };
							const occurredAt = safeNow(now);
							const executionId = nextOpaqueId(newId);
							const turnId = nextOpaqueId(newId);
							const result: ConversationCommandResultV1 = {
								schemaVersion: 1,
								status: "submitted",
								messageId: null,
								executionId,
							};
							return {
								schemaVersion: 1,
								kind: "regenerate",
								conversation: {
									...conversation,
									status: "active",
									authorizationRevision: authority.authorizationRevision,
								},
								execution: {
									executionId,
									conversationId: conversation.conversationId,
									agentId: authority.agentId,
									actorId: authority.actorId,
									channelId: authority.channelId,
									turnId,
									status: "submitted",
									sessionGeneration: conversation.sessionGeneration,
									deliveryFence: 0,
									authorizationRevision: authority.authorizationRevision,
									createdAt: occurredAt,
								},
								outboxIntent: {
									operation: "conversation.turn.regenerate.v1",
									conversationId: conversation.conversationId,
									executionId,
									messageId: sourceMessage.messageId,
									turnId,
									sessionGeneration: conversation.sessionGeneration,
									traceId: command.traceId,
									requestId: command.requestId,
									occurredAt,
								},
								auditEvent: {
									action: "conversation.regeneration.accepted",
									actorId: authority.actorId,
									agentId: authority.agentId,
									conversationId: conversation.conversationId,
									executionId,
									traceId: command.traceId,
									requestId: command.requestId,
									occurredAt,
								},
								result,
								idempotency: {
									scopeType: "conversation",
									scopeId: conversation.conversationId,
									actorId: authority.actorId,
									commandType: "regenerate",
									key: command.idempotencyKey,
									requestDigest,
								},
							};
						},
					),
					parseRegenerationCommandResult,
				);
			} catch (error) {
				if (error instanceof ConversationExecutionError) throw error;
				return unavailable();
			}
		},
		async stop(commandInput) {
			const command = parseStopCommand(commandInput);
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "stop",
				conversationId: command.conversationId,
			});
			if (!authority) return { outcome: "denied" };
			const requestDigest = digest({
				schemaVersion: command.schemaVersion,
				command: command.command,
				conversationId: command.conversationId,
				targetExecutionId: command.targetExecutionId,
			});
			try {
				return normalizeStopDecision(
					await dependencies.transaction.executeStop(
						{ command, authority, requestDigest },
						(stateInput) => {
							const state = parseState(stateInput);
							const conversation = state.conversation;
							const targetExecution = state.targetExecution;
							if (
								!conversation ||
								conversation.conversationId !== command.conversationId ||
								conversation.actorId !== authority.actorId ||
								conversation.agentId !== authority.agentId ||
								conversation.channelId !== authority.channelId ||
								!targetExecution ||
								targetExecution.executionId !== command.targetExecutionId ||
								targetExecution.actorId !== authority.actorId
							) {
								return { outcome: "denied" };
							}
							if (state.existingStop) {
								return {
									outcome: "replayed",
									result: {
										schemaVersion: 1,
										status:
											state.existingStop.status === "completed"
												? "already_finished"
												: "submitted",
										executionId: targetExecution.executionId,
									},
								};
							}
							if (
								targetExecution.status === "completed" ||
								targetExecution.status === "failed" ||
								targetExecution.status === "cancelled"
							) {
								return {
									outcome: "accepted",
									result: {
										schemaVersion: 1,
										status: "already_finished",
										executionId: targetExecution.executionId,
									},
								};
							}
							const occurredAt = safeNow(now);
							const stopRequestId = nextOpaqueId(newId);
							const result: ConversationStopResultV1 = {
								schemaVersion: 1,
								status: "submitted",
								executionId: targetExecution.executionId,
							};
							return {
								schemaVersion: 1,
								targetExecution: {
									executionId: targetExecution.executionId,
									conversationId: conversation.conversationId,
									actorId: authority.actorId,
								},
								stopRequestId,
								outboxIntent: {
									operation: "conversation.turn.stop.v1",
									conversationId: conversation.conversationId,
									executionId: targetExecution.executionId,
									sessionGeneration: conversation.sessionGeneration,
									stopRequestId,
									traceId: command.traceId,
									requestId: command.requestId,
									occurredAt,
								},
								auditEvent: {
									action: "conversation.stop.accepted",
									actorId: authority.actorId,
									agentId: authority.agentId,
									conversationId: conversation.conversationId,
									executionId: targetExecution.executionId,
									traceId: command.traceId,
									requestId: command.requestId,
									occurredAt,
								},
								result,
								idempotency: {
									scopeType: "conversation",
									scopeId: conversation.conversationId,
									actorId: authority.actorId,
									commandType: "stop",
									key: command.idempotencyKey,
									requestDigest,
								},
							};
						},
					),
					command.targetExecutionId,
				);
			} catch (error) {
				if (error instanceof ConversationExecutionError) throw error;
				return unavailable();
			}
		},
	};
}
