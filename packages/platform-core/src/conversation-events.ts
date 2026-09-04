import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { types } from "node:util";

import { platformIdempotencyV1 } from "./idempotency.js";

export type ConversationEventStatusV1 =
	| "submitted"
	| "processing"
	| "completed"
	| "failed"
	| "cancelled"
	| "unknown";

export type ConversationNormalizedEventV1 =
	| { readonly type: "text.delta"; readonly text: string }
	| {
			readonly type: "execution.status";
			readonly status: ConversationEventStatusV1;
	  }
	| {
			readonly type: "execution.detail";
			readonly category: "status" | "model_call" | "connection_call";
			readonly summary: string;
			readonly callId?: string;
	  }
	| {
			readonly type: "result.file";
			readonly fileId: string;
			readonly name: string;
			readonly mediaType: string;
			readonly sizeBytes: number;
	  }
	| {
			readonly type: "conversation.error";
			readonly code: string;
			readonly message: string;
			readonly retryable: boolean;
	  };

export interface ConversationEventCommandV1 {
	readonly schemaVersion: 1;
	readonly conversationId: string;
	readonly executionId: string;
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
	readonly adapterEventKey: string;
	readonly runtimeCursor: string;
	readonly occurredAt: string;
	readonly event: ConversationNormalizedEventV1;
}

export interface PersistedConversationEventV1 {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly sequence: number;
	readonly conversationCursor: number;
	readonly occurredAt: string;
	readonly event: ConversationNormalizedEventV1;
}

export interface ConversationEventStateV1 {
	readonly conversation:
		| {
				readonly conversationId: string;
				readonly sessionGeneration: number;
				readonly lastConversationCursor: number;
		  }
		| undefined;
	readonly execution:
		| {
				readonly executionId: string;
				readonly conversationId: string;
				readonly sessionGeneration: number;
				readonly deliveryFence: number;
				readonly lastSequence: number;
		  }
		| undefined;
	readonly existingEvent:
		| {
				readonly event: PersistedConversationEventV1;
				readonly eventDigest: string;
		  }
		| undefined;
}

export interface ConversationEventWritePlanV1 {
	readonly schemaVersion: 1;
	readonly event: PersistedConversationEventV1;
	readonly adapterEventKey: string;
	readonly eventDigest: string;
	readonly runtimeCursor: string;
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
}

export type ConversationEventDecisionV1 =
	| {
			readonly outcome: "accepted" | "replayed";
			readonly event: PersistedConversationEventV1;
	  }
	| { readonly outcome: "stale" };

export interface ConversationEventTransactionPortV1 {
	persistEvent(
		request: {
			readonly command: ConversationEventCommandV1;
			readonly eventDigest: string;
		},
		decide: (
			state: ConversationEventStateV1,
		) => ConversationEventWritePlanV1 | ConversationEventDecisionV1,
	): Promise<ConversationEventDecisionV1>;
}

export interface ConversationEventUseCaseV1 {
	persist(
		command: ConversationEventCommandV1,
	): Promise<ConversationEventDecisionV1>;
}

export interface ConversationEventUseCaseDependenciesV1 {
	readonly transaction: ConversationEventTransactionPortV1;
}

export interface ConversationEventUseCaseOptionsV1 {
	readonly newId?: () => string;
}

export class ConversationEventError extends Error {
	readonly code: "invalid_input" | "unavailable";

	constructor(code: "invalid_input" | "unavailable") {
		super(
			code === "invalid_input"
				? "Invalid conversation event"
				: "Conversation event persistence is unavailable",
		);
		this.name = "ConversationEventError";
		this.code = code;
	}
}

function invalidInput(): never {
	throw new ConversationEventError("invalid_input");
}

function unavailable(): never {
	throw new ConversationEventError("unavailable");
}

function snapshotObject(
	input: unknown,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[] = [],
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
		const keys = new Set([...requiredKeys, ...optionalKeys]);
		const descriptors = Object.getOwnPropertyDescriptors(input);
		if (
			Reflect.ownKeys(descriptors).some(
				(key) => typeof key !== "string" || !keys.has(key),
			) ||
			requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
		) {
			invalidInput();
		}
		const values: Record<string, unknown> = {};
		for (const key of [...requiredKeys, ...optionalKeys]) {
			const descriptor = descriptors[key];
			if (descriptor === undefined) continue;
			if (
				descriptor.enumerable !== true ||
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
		if (error instanceof ConversationEventError) throw error;
		invalidInput();
	}
}

function isText(value: unknown, maximum = 1024): value is string {
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

function isEventStatus(value: unknown): value is ConversationEventStatusV1 {
	return (
		value === "submitted" ||
		value === "processing" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "unknown"
	);
}

function validOccurredAt(value: unknown): string {
	if (!isText(value, 128)) invalidInput();
	try {
		const milliseconds = Date.parse(value);
		if (!Number.isFinite(milliseconds)) invalidInput();
		return new Date(milliseconds).toISOString();
	} catch {
		invalidInput();
	}
}

function eventType(input: unknown): unknown {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			types.isProxy(input)
		) {
			invalidInput();
		}
		const descriptor = Object.getOwnPropertyDescriptor(input, "type");
		if (
			descriptor?.enumerable !== true ||
			!Object.hasOwn(descriptor, "value") ||
			Object.hasOwn(descriptor, "get") ||
			Object.hasOwn(descriptor, "set")
		) {
			invalidInput();
		}
		return descriptor.value;
	} catch (error) {
		if (error instanceof ConversationEventError) throw error;
		invalidInput();
	}
}

function parseEvent(input: unknown): ConversationNormalizedEventV1 {
	const type = eventType(input);
	if (type === "text.delta") {
		const values = snapshotObject(input, ["type", "text"]);
		if (!isText(values.text, 65_536)) invalidInput();
		return { type: "text.delta", text: values.text };
	}
	if (type === "execution.status") {
		const values = snapshotObject(input, ["type", "status"]);
		if (!isEventStatus(values.status)) invalidInput();
		return { type: "execution.status", status: values.status };
	}
	if (type === "execution.detail") {
		const values = snapshotObject(
			input,
			["type", "category", "summary"],
			["callId"],
		);
		if (
			(values.category !== "status" &&
				values.category !== "model_call" &&
				values.category !== "connection_call") ||
			!isText(values.summary, 4096) ||
			(values.callId !== undefined && !isText(values.callId))
		) {
			invalidInput();
		}
		return {
			type: "execution.detail",
			category: values.category,
			summary: values.summary,
			...(values.callId === undefined ? {} : { callId: values.callId }),
		};
	}
	if (type === "result.file") {
		const values = snapshotObject(input, [
			"type",
			"fileId",
			"name",
			"mediaType",
			"sizeBytes",
		]);
		if (
			!isText(values.fileId) ||
			!isText(values.name, 1024) ||
			!isText(values.mediaType, 255) ||
			!isNonNegativeSafeInteger(values.sizeBytes)
		) {
			invalidInput();
		}
		return {
			type: "result.file",
			fileId: values.fileId,
			name: values.name,
			mediaType: values.mediaType,
			sizeBytes: values.sizeBytes,
		};
	}
	if (type === "conversation.error") {
		const values = snapshotObject(input, [
			"type",
			"code",
			"message",
			"retryable",
		]);
		if (
			!isText(values.code, 128) ||
			!isText(values.message, 4096) ||
			typeof values.retryable !== "boolean"
		) {
			invalidInput();
		}
		return {
			type: "conversation.error",
			code: values.code,
			message: values.message,
			retryable: values.retryable,
		};
	}
	invalidInput();
}

function parseCommand(input: unknown): ConversationEventCommandV1 {
	const values = snapshotObject(input, [
		"schemaVersion",
		"conversationId",
		"executionId",
		"sessionGeneration",
		"deliveryFence",
		"adapterEventKey",
		"runtimeCursor",
		"occurredAt",
		"event",
	]);
	if (
		values.schemaVersion !== 1 ||
		!isText(values.conversationId) ||
		!isText(values.executionId) ||
		!isPositiveSafeInteger(values.sessionGeneration) ||
		!isNonNegativeSafeInteger(values.deliveryFence) ||
		!isText(values.adapterEventKey) ||
		!isText(values.runtimeCursor)
	) {
		invalidInput();
	}
	return {
		schemaVersion: 1,
		conversationId: values.conversationId,
		executionId: values.executionId,
		sessionGeneration: values.sessionGeneration,
		deliveryFence: values.deliveryFence,
		adapterEventKey: values.adapterEventKey,
		runtimeCursor: values.runtimeCursor,
		occurredAt: validOccurredAt(values.occurredAt),
		event: parseEvent(values.event),
	};
}

function parsePersistedEvent(input: unknown): PersistedConversationEventV1 {
	const values = snapshotObject(input, [
		"schemaVersion",
		"eventId",
		"conversationId",
		"executionId",
		"sequence",
		"conversationCursor",
		"occurredAt",
		"event",
	]);
	if (
		values.schemaVersion !== 1 ||
		!isText(values.eventId) ||
		!isText(values.conversationId) ||
		!isText(values.executionId) ||
		!isPositiveSafeInteger(values.sequence) ||
		!isPositiveSafeInteger(values.conversationCursor)
	) {
		invalidInput();
	}
	return {
		schemaVersion: 1,
		eventId: values.eventId,
		conversationId: values.conversationId,
		executionId: values.executionId,
		sequence: values.sequence,
		conversationCursor: values.conversationCursor,
		occurredAt: validOccurredAt(values.occurredAt),
		event: parseEvent(values.event),
	};
}

function parseState(input: ConversationEventStateV1): ConversationEventStateV1 {
	try {
		const values = snapshotObject(input, [
			"conversation",
			"execution",
			"existingEvent",
		]);
		const conversation = (() => {
			if (values.conversation === undefined) return undefined;
			const state = snapshotObject(values.conversation, [
				"conversationId",
				"sessionGeneration",
				"lastConversationCursor",
			]);
			if (
				!isText(state.conversationId) ||
				!isPositiveSafeInteger(state.sessionGeneration) ||
				!isNonNegativeSafeInteger(state.lastConversationCursor)
			) {
				unavailable();
			}
			return {
				conversationId: state.conversationId,
				sessionGeneration: state.sessionGeneration,
				lastConversationCursor: state.lastConversationCursor,
			};
		})();
		const execution = (() => {
			if (values.execution === undefined) return undefined;
			const state = snapshotObject(values.execution, [
				"executionId",
				"conversationId",
				"sessionGeneration",
				"deliveryFence",
				"lastSequence",
			]);
			if (
				!isText(state.executionId) ||
				!isText(state.conversationId) ||
				!isPositiveSafeInteger(state.sessionGeneration) ||
				!isNonNegativeSafeInteger(state.deliveryFence) ||
				!isNonNegativeSafeInteger(state.lastSequence)
			) {
				unavailable();
			}
			return {
				executionId: state.executionId,
				conversationId: state.conversationId,
				sessionGeneration: state.sessionGeneration,
				deliveryFence: state.deliveryFence,
				lastSequence: state.lastSequence,
			};
		})();
		const existingEvent = (() => {
			if (values.existingEvent === undefined) return undefined;
			const state = snapshotObject(values.existingEvent, [
				"event",
				"eventDigest",
			]);
			if (
				typeof state.eventDigest !== "string" ||
				!/^[a-f0-9]{64}$/.test(state.eventDigest)
			) {
				unavailable();
			}
			return {
				event: parsePersistedEvent(state.event),
				eventDigest: state.eventDigest,
			};
		})();
		if (
			conversation &&
			execution &&
			conversation.conversationId !== execution.conversationId
		) {
			unavailable();
		}
		return { conversation, execution, existingEvent };
	} catch {
		return unavailable();
	}
}

function eventDigest(command: ConversationEventCommandV1): string {
	try {
		return platformIdempotencyV1.canonicalRequestDigest({
			schemaVersion: command.schemaVersion,
			conversationId: command.conversationId,
			executionId: command.executionId,
			adapterEventKey: command.adapterEventKey,
			runtimeCursor: command.runtimeCursor,
			occurredAt: command.occurredAt,
			event: command.event,
		} as never);
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

function nextCounter(value: number): number {
	if (!isNonNegativeSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER)
		unavailable();
	return value + 1;
}

function isWritePlan(
	value: ConversationEventWritePlanV1 | ConversationEventDecisionV1,
): value is ConversationEventWritePlanV1 {
	return !Object.hasOwn(value, "outcome");
}

function samePersistedEvent(
	left: PersistedConversationEventV1,
	right: PersistedConversationEventV1,
) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeDecision(
	input: unknown,
	expected:
		| ConversationEventWritePlanV1
		| ConversationEventDecisionV1
		| undefined,
): ConversationEventDecisionV1 {
	try {
		if (!expected) return unavailable();
		const values = snapshotObject(input, ["outcome"], ["event"]);
		if (isWritePlan(expected)) {
			if (values.outcome !== "accepted" || values.event === undefined) {
				return unavailable();
			}
			const event = parsePersistedEvent(values.event);
			if (!samePersistedEvent(event, expected.event)) return unavailable();
			return { outcome: "accepted", event };
		}
		if (expected.outcome === "stale") {
			if (values.outcome !== "stale" || values.event !== undefined) {
				return unavailable();
			}
			return { outcome: "stale" };
		}
		if (expected.outcome !== "replayed" || values.outcome !== "replayed") {
			return unavailable();
		}
		if (values.event === undefined) return unavailable();
		const event = parsePersistedEvent(values.event);
		if (!samePersistedEvent(event, expected.event)) return unavailable();
		return { outcome: "replayed", event };
	} catch {
		return unavailable();
	}
}

export function createConversationEventUseCaseV1(
	dependencies: ConversationEventUseCaseDependenciesV1,
	options: ConversationEventUseCaseOptionsV1 = {},
): ConversationEventUseCaseV1 {
	const newId = options.newId ?? randomUUID;
	return {
		async persist(commandInput) {
			const command = parseCommand(commandInput);
			const digest = eventDigest(command);
			try {
				let expected:
					| ConversationEventWritePlanV1
					| ConversationEventDecisionV1
					| undefined;
				const decision = await dependencies.transaction.persistEvent(
					{ command, eventDigest: digest },
					(stateInput) => {
						if (expected !== undefined) return unavailable();
						const state = parseState(stateInput);
						const next = (() => {
							if (state.existingEvent) {
								if (
									state.existingEvent.eventDigest !== digest ||
									state.existingEvent.event.conversationId !==
										command.conversationId ||
									state.existingEvent.event.executionId !== command.executionId
								) {
									return unavailable();
								}
								return {
									outcome: "replayed" as const,
									event: state.existingEvent.event,
								};
							}
							const conversation = state.conversation;
							const execution = state.execution;
							if (
								!conversation ||
								!execution ||
								conversation.conversationId !== command.conversationId ||
								execution.executionId !== command.executionId ||
								execution.conversationId !== command.conversationId ||
								conversation.sessionGeneration !== command.sessionGeneration ||
								execution.sessionGeneration !== command.sessionGeneration ||
								execution.deliveryFence !== command.deliveryFence
							) {
								return { outcome: "stale" as const };
							}
							const event: PersistedConversationEventV1 = {
								schemaVersion: 1,
								eventId: nextOpaqueId(newId),
								conversationId: command.conversationId,
								executionId: command.executionId,
								sequence: nextCounter(execution.lastSequence),
								conversationCursor: nextCounter(
									conversation.lastConversationCursor,
								),
								occurredAt: command.occurredAt,
								event: command.event,
							};
							return {
								schemaVersion: 1 as const,
								event,
								adapterEventKey: command.adapterEventKey,
								eventDigest: digest,
								runtimeCursor: command.runtimeCursor,
								sessionGeneration: command.sessionGeneration,
								deliveryFence: command.deliveryFence,
							};
						})();
						expected = structuredClone(next);
						return structuredClone(next);
					},
				);
				return normalizeDecision(decision, expected);
			} catch (error) {
				if (error instanceof ConversationEventError) throw error;
				return unavailable();
			}
		},
	};
}
