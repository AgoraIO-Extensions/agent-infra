import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import {
	type ConversationOperationEventV2,
	type ConversationOperationFactV2,
	parseConversationOperationEventV2,
	parseConversationOperationHistoryV2,
	requireConversationOperationSuccessorV2,
} from "./conversation-operation-facts.js";
import { platformIdempotencyV1 } from "./idempotency.js";

export type ConversationEventStatusV1 =
	| "submitted"
	| "processing"
	| "completed"
	| "failed"
	| "cancelled"
	| "unknown";

export interface ConversationEventStateTransitionV1 {
	readonly executionStatus: ConversationEventStatusV1;
	readonly conversationStatus: "ready" | "active";
}

export type ConversationBrowserHandoffStatusV1 =
	| "requested"
	| "active"
	| "returning"
	| "completed"
	| "revoked"
	| "expired"
	| "crashed"
	| "unknown";

export type ConversationBrowserHandoffReasonV1 =
	| "login"
	| "mfa"
	| "captcha"
	| "human_judgment";

export interface ConversationBrowserHandoffBindingV1 {
	readonly subjectId: string;
	readonly agentId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly sessionGeneration: number;
	readonly resourceFence: number;
	readonly workloadRevision: number;
	readonly imageDigest: string;
	readonly capabilityVersion: number;
	/** Web projection revision; Runtime V3 derives it from capabilityVersion. */
	readonly capabilityRevision: number;
	readonly pageRevision: number;
}

/** Internal bounded projection of an authenticated Runtime Browser handoff. */
export interface ConversationBrowserHandoffEventV1 {
	readonly type: "browser.handoff";
	readonly handoffId: string;
	readonly status: ConversationBrowserHandoffStatusV1;
	readonly reason: ConversationBrowserHandoffReasonV1;
	readonly requestedAt: string;
	readonly expiresAt: string;
	readonly operatorId?: string;
	readonly terminalReason?: string;
	readonly binding: ConversationBrowserHandoffBindingV1;
}

export type ConversationBrowserSideEffectStatusV1 =
	| "pending"
	| "confirmed"
	| "rejected"
	| "cancelled"
	| "expired"
	| "unknown";

export interface ConversationBrowserSideEffectBindingV1
	extends ConversationBrowserHandoffBindingV1 {
	readonly actionId: string;
	readonly confirmationId: string;
	readonly operationRef: string;
	readonly attemptRef: string;
}

export interface ConversationBrowserSideEffectEventV1 {
	readonly type: "browser.side_effect";
	readonly confirmationId: string;
	readonly status: ConversationBrowserSideEffectStatusV1;
	readonly requestedAt: string;
	readonly expiresAt: string;
	readonly operation: string;
	readonly targetOrigin: string;
	readonly redactedTargetSummary: string;
	readonly binding: ConversationBrowserSideEffectBindingV1;
}

/** #2979：思考过程的来源，`raw` 为原始推理，`summary` 为推理摘要。 */
export type ConversationReasoningKindV1 = "raw" | "summary";

export type ConversationNormalizedEventV1 =
	| ConversationOperationEventV2
	| { readonly type: "text.delta"; readonly text: string }
	| {
			readonly type: "reasoning.delta";
			readonly kind: ConversationReasoningKindV1;
			readonly text: string;
	  }
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
	  }
	| ConversationBrowserHandoffEventV1
	| ConversationBrowserSideEffectEventV1;

export interface ConversationModelSelectionFallbackEventV1 {
	readonly type: "model.selection.fell_back";
	readonly modelOptionId: string;
	readonly reasoningLevel: string;
	readonly reason: "selection_unavailable";
	/**
	 * G-07 起成对写入：会话原所选选项与受理时的显示名（读不到时为 null）。
	 * 此前写入的旧事件没有这两项，读取方继续按 V1 事件投影。
	 */
	readonly requestedModelOptionId?: string;
	readonly requestedModelDisplayName?: string | null;
}

export interface ConversationTaskStatusEventV1 {
	readonly type: "task.status";
	readonly status:
		| "waiting"
		| "submitted"
		| "processing"
		| "completed"
		| "failed"
		| "cancelled"
		| "unknown";
	readonly reason?:
		| "STOP_CONFIRMATION_TIMEOUT"
		| "TASK_WAIT_TIMEOUT"
		| "AGENT_UNAVAILABLE"
		| "CONVERSATION_UNAVAILABLE";
}

function isTaskFailureReasonV1(
	reason: unknown,
): reason is
	| "TASK_WAIT_TIMEOUT"
	| "AGENT_UNAVAILABLE"
	| "CONVERSATION_UNAVAILABLE" {
	return (
		reason === "TASK_WAIT_TIMEOUT" ||
		reason === "AGENT_UNAVAILABLE" ||
		reason === "CONVERSATION_UNAVAILABLE"
	);
}

export function publicTaskStatusEventV1(input: {
	readonly isTask: boolean;
	readonly status: ConversationTaskStatusEventV1["status"];
	readonly reason?: string;
}): ConversationTaskStatusEventV1 | null {
	if (
		!input.isTask &&
		!(
			input.status === "unknown" && input.reason === "STOP_CONFIRMATION_TIMEOUT"
		)
	)
		return null;
	const reason =
		input.status === "unknown" && input.reason === "STOP_CONFIRMATION_TIMEOUT"
			? input.reason
			: input.status === "failed" && isTaskFailureReasonV1(input.reason)
				? input.reason
				: undefined;
	return {
		type: "task.status",
		status: input.status,
		...(reason ? { reason } : {}),
	};
}

export type ConversationPersistedEventPayloadV1 =
	| ConversationNormalizedEventV1
	| ConversationModelSelectionFallbackEventV1
	| ConversationTaskStatusEventV1;

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
	readonly transition?: ConversationEventStateTransitionV1;
	/** After terminal delivery, only evidence on the original tool outcome may change. */
	readonly operationMetadataOnly?: true;
	readonly dispatchLease?: {
		readonly schemaVersion: 1;
		readonly itemId: string;
		readonly leaseOwner: string;
		readonly deliveryFence: number;
	};
}

export interface PersistedConversationEventV1 {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly sequence: number;
	readonly conversationCursor: number;
	readonly occurredAt: string;
	readonly event: ConversationPersistedEventPayloadV1;
}

export type PersistedRuntimeConversationEventV1 = Omit<
	PersistedConversationEventV1,
	"event"
> & { readonly event: ConversationNormalizedEventV1 };

export interface ConversationEventStateV1 {
	/** Trusted persisted facts from this Execution; required for new operation events. */
	readonly operationHistory?: readonly ConversationOperationFactV2[];
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
				readonly event: PersistedRuntimeConversationEventV1;
				readonly eventDigest: string;
		  }
		| undefined;
}

export interface ConversationEventWritePlanV1 {
	readonly schemaVersion: 1;
	readonly event: PersistedRuntimeConversationEventV1;
	readonly adapterEventKey: string;
	readonly eventDigest: string;
	readonly runtimeCursor: string;
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
	readonly transition?: ConversationEventStateTransitionV1;
}

export type ConversationEventDecisionV1 =
	| {
			readonly outcome: "accepted" | "replayed";
			readonly event: PersistedRuntimeConversationEventV1;
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
	if (type === "execution.operation") {
		try {
			return parseConversationOperationEventV2(input);
		} catch {
			return invalidInput();
		}
	}
	if (type === "text.delta") {
		const values = snapshotObject(input, ["type", "text"]);
		if (!isText(values.text, 65_536)) invalidInput();
		return { type: "text.delta", text: values.text };
	}
	if (type === "reasoning.delta") {
		const values = snapshotObject(input, ["type", "kind", "text"]);
		if (
			(values.kind !== "raw" && values.kind !== "summary") ||
			!isText(values.text, 65_536)
		)
			invalidInput();
		return { type: "reasoning.delta", kind: values.kind, text: values.text };
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
	if (type === "browser.handoff") {
		const values = snapshotObject(
			input,
			[
				"type",
				"handoffId",
				"status",
				"reason",
				"requestedAt",
				"expiresAt",
				"binding",
			],
			["operatorId", "terminalReason"],
		);
		if (
			!isText(values.handoffId) ||
			![
				"requested",
				"active",
				"returning",
				"completed",
				"revoked",
				"expired",
				"crashed",
				"unknown",
			].includes(values.status as string) ||
			!["login", "mfa", "captcha", "human_judgment"].includes(
				values.reason as string,
			) ||
			(values.operatorId !== undefined && !isText(values.operatorId)) ||
			(values.terminalReason !== undefined &&
				!isText(values.terminalReason, 256))
		) {
			invalidInput();
		}
		const binding = snapshotObject(values.binding, [
			"subjectId",
			"agentId",
			"conversationId",
			"executionId",
			"sessionGeneration",
			"resourceFence",
			"workloadRevision",
			"imageDigest",
			"capabilityVersion",
			"capabilityRevision",
			"pageRevision",
		]);
		const subjectId = binding.subjectId;
		const agentId = binding.agentId;
		const conversationId = binding.conversationId;
		const executionId = binding.executionId;
		const sessionGeneration = binding.sessionGeneration;
		const resourceFence = binding.resourceFence;
		const workloadRevision = binding.workloadRevision;
		const imageDigest = binding.imageDigest;
		const capabilityVersion = binding.capabilityVersion;
		const capabilityRevision = binding.capabilityRevision;
		const pageRevision = binding.pageRevision;
		if (
			!["subjectId", "agentId", "conversationId", "executionId"].every((key) =>
				isText(binding[key]),
			) ||
			![
				"sessionGeneration",
				"resourceFence",
				"workloadRevision",
				"capabilityVersion",
				"capabilityRevision",
				"pageRevision",
			].every((key) => isPositiveSafeInteger(binding[key])) ||
			!isText(imageDigest) ||
			!/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/u.test(imageDigest) ||
			!isText(subjectId) ||
			!isText(agentId) ||
			!isText(conversationId) ||
			!isText(executionId) ||
			!isPositiveSafeInteger(sessionGeneration) ||
			!isPositiveSafeInteger(resourceFence) ||
			!isPositiveSafeInteger(workloadRevision) ||
			!isPositiveSafeInteger(capabilityVersion) ||
			!isPositiveSafeInteger(capabilityRevision) ||
			!isPositiveSafeInteger(pageRevision)
		) {
			invalidInput();
		}
		return {
			type: "browser.handoff",
			handoffId: values.handoffId,
			status: values.status as ConversationBrowserHandoffStatusV1,
			reason: values.reason as ConversationBrowserHandoffReasonV1,
			requestedAt: validOccurredAt(values.requestedAt),
			expiresAt: validOccurredAt(values.expiresAt),
			...(values.operatorId === undefined
				? {}
				: { operatorId: values.operatorId }),
			...(values.terminalReason === undefined
				? {}
				: { terminalReason: values.terminalReason }),
			binding: {
				subjectId,
				agentId,
				conversationId,
				executionId,
				sessionGeneration,
				resourceFence,
				workloadRevision,
				imageDigest,
				capabilityVersion,
				capabilityRevision,
				pageRevision,
			},
		};
	}
	if (type === "browser.side_effect") {
		const values = snapshotObject(input, [
			"type",
			"confirmationId",
			"status",
			"requestedAt",
			"expiresAt",
			"operation",
			"targetOrigin",
			"redactedTargetSummary",
			"binding",
		]);
		if (
			!isText(values.confirmationId) ||
			![
				"pending",
				"confirmed",
				"rejected",
				"cancelled",
				"expired",
				"unknown",
			].includes(values.status as string) ||
			!isText(values.operation, 128) ||
			!isText(values.targetOrigin, 2048) ||
			!isText(values.redactedTargetSummary, 1024)
		)
			invalidInput();
		let origin: URL;
		try {
			origin = new URL(values.targetOrigin);
		} catch {
			invalidInput();
		}
		if (
			(origin.protocol !== "http:" && origin.protocol !== "https:") ||
			origin.username !== "" ||
			origin.password !== "" ||
			origin.pathname !== "/" ||
			origin.search !== "" ||
			origin.hash !== ""
		)
			invalidInput();
		const binding = snapshotObject(values.binding, [
			"subjectId",
			"agentId",
			"conversationId",
			"executionId",
			"sessionGeneration",
			"resourceFence",
			"workloadRevision",
			"imageDigest",
			"capabilityVersion",
			"capabilityRevision",
			"pageRevision",
			"actionId",
			"confirmationId",
			"operationRef",
			"attemptRef",
		]);
		if (
			!isText(binding.subjectId) ||
			!isText(binding.agentId) ||
			!isText(binding.conversationId) ||
			!isText(binding.executionId) ||
			!isText(binding.actionId) ||
			!isText(binding.confirmationId) ||
			!isText(binding.operationRef) ||
			!isText(binding.attemptRef) ||
			!isPositiveSafeInteger(binding.sessionGeneration) ||
			!isPositiveSafeInteger(binding.resourceFence) ||
			!isPositiveSafeInteger(binding.workloadRevision) ||
			!isPositiveSafeInteger(binding.capabilityVersion) ||
			!isPositiveSafeInteger(binding.capabilityRevision) ||
			!isPositiveSafeInteger(binding.pageRevision) ||
			!isText(binding.imageDigest) ||
			!/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/u.test(binding.imageDigest) ||
			values.confirmationId !== binding.confirmationId
		)
			invalidInput();
		return {
			type: "browser.side_effect",
			confirmationId: values.confirmationId,
			status: values.status as ConversationBrowserSideEffectStatusV1,
			requestedAt: validOccurredAt(values.requestedAt),
			expiresAt: validOccurredAt(values.expiresAt),
			operation: values.operation,
			targetOrigin: origin.origin,
			redactedTargetSummary: values.redactedTargetSummary,
			binding: binding as unknown as ConversationBrowserSideEffectBindingV1,
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

export function parseConversationPersistedEventPayloadV1(
	input: unknown,
): ConversationPersistedEventPayloadV1 {
	if (eventType(input) === "task.status") {
		const values = snapshotObject(input, ["type", "status"], ["reason"]);
		if (
			values.reason !== undefined &&
			!(
				(values.reason === "STOP_CONFIRMATION_TIMEOUT" &&
					values.status === "unknown") ||
				(values.status === "failed" && isTaskFailureReasonV1(values.reason))
			)
		)
			invalidInput();
		if (
			![
				"waiting",
				"submitted",
				"processing",
				"completed",
				"failed",
				"cancelled",
				"unknown",
			].includes(values.status as string)
		)
			invalidInput();
		const reason =
			values.reason === "STOP_CONFIRMATION_TIMEOUT" ||
			isTaskFailureReasonV1(values.reason)
				? values.reason
				: undefined;
		return {
			type: "task.status",
			status: values.status as ConversationTaskStatusEventV1["status"],
			...(reason ? { reason } : {}),
		};
	}
	if (eventType(input) !== "model.selection.fell_back")
		return parseEvent(input);
	const values = snapshotObject(
		input,
		["type", "modelOptionId", "reasoningLevel", "reason"],
		["requestedModelOptionId", "requestedModelDisplayName"],
	);
	const hasRequested = values.requestedModelOptionId !== undefined;
	if (
		!isText(values.modelOptionId) ||
		!isText(values.reasoningLevel) ||
		values.reason !== "selection_unavailable" ||
		// 原选项与显示名必须成对出现；显示名可为 null，否则是不超过 1024 字节的文本，
		// 与公共契约 ModelSelectionFallbackEventV2 的上限一致。
		hasRequested !== (values.requestedModelDisplayName !== undefined) ||
		(hasRequested &&
			(!isText(values.requestedModelOptionId) ||
				(values.requestedModelDisplayName !== null &&
					!isText(values.requestedModelDisplayName))))
	) {
		invalidInput();
	}
	return {
		type: "model.selection.fell_back",
		modelOptionId: values.modelOptionId,
		reasoningLevel: values.reasoningLevel,
		reason: "selection_unavailable",
		...(hasRequested
			? {
					requestedModelOptionId: values.requestedModelOptionId as string,
					requestedModelDisplayName: values.requestedModelDisplayName as
						| string
						| null,
				}
			: {}),
	};
}

function parseCommand(input: unknown): ConversationEventCommandV1 {
	const values = snapshotObject(
		input,
		[
			"schemaVersion",
			"conversationId",
			"executionId",
			"sessionGeneration",
			"deliveryFence",
			"adapterEventKey",
			"runtimeCursor",
			"occurredAt",
			"event",
		],
		["transition", "dispatchLease", "operationMetadataOnly"],
	);
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
	const event = parseEvent(values.event);
	if (
		values.operationMetadataOnly !== undefined &&
		(values.operationMetadataOnly !== true ||
			event.type !== "execution.operation")
	)
		invalidInput();
	const transition: ConversationEventStateTransitionV1 | undefined = (() => {
		if (values.transition === undefined) return undefined;
		const value = snapshotObject(values.transition, [
			"executionStatus",
			"conversationStatus",
		]);
		if (
			!isEventStatus(value.executionStatus) ||
			(value.conversationStatus !== "ready" &&
				value.conversationStatus !== "active") ||
			event.type !== "execution.status" ||
			value.executionStatus !== event.status ||
			value.conversationStatus !==
				(["completed", "failed", "cancelled"].includes(event.status)
					? "ready"
					: "active")
		) {
			invalidInput();
		}
		return {
			executionStatus: value.executionStatus,
			conversationStatus: value.conversationStatus,
		};
	})();
	return {
		schemaVersion: 1,
		conversationId: values.conversationId,
		executionId: values.executionId,
		sessionGeneration: values.sessionGeneration,
		deliveryFence: values.deliveryFence,
		adapterEventKey: values.adapterEventKey,
		runtimeCursor: values.runtimeCursor,
		occurredAt: validOccurredAt(values.occurredAt),
		event,
		...(values.operationMetadataOnly === true
			? { operationMetadataOnly: true as const }
			: {}),
		...(transition ? { transition } : {}),
		...(values.dispatchLease === undefined
			? {}
			: {
					dispatchLease: (() => {
						const lease = snapshotObject(values.dispatchLease, [
							"schemaVersion",
							"itemId",
							"leaseOwner",
							"deliveryFence",
						]);
						if (
							lease.schemaVersion !== 1 ||
							!isText(lease.itemId) ||
							!isText(lease.leaseOwner) ||
							!isPositiveSafeInteger(lease.deliveryFence)
						) {
							invalidInput();
						}
						return {
							schemaVersion: 1 as const,
							itemId: lease.itemId,
							leaseOwner: lease.leaseOwner,
							deliveryFence: lease.deliveryFence,
						};
					})(),
				}),
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
		event: parseConversationPersistedEventPayloadV1(values.event),
	};
}

function parsePersistedRuntimeEvent(
	input: unknown,
): PersistedRuntimeConversationEventV1 {
	const persisted = parsePersistedEvent(input);
	if (
		persisted.event.type === "model.selection.fell_back" ||
		persisted.event.type === "task.status"
	)
		invalidInput();
	return { ...persisted, event: persisted.event };
}

function parseState(input: ConversationEventStateV1): ConversationEventStateV1 {
	try {
		const values = snapshotObject(
			input,
			["conversation", "execution", "existingEvent"],
			["operationHistory"],
		);
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
			const event = parsePersistedRuntimeEvent(state.event);
			return {
				event,
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
		return {
			conversation,
			execution,
			existingEvent,
			...(values.operationHistory === undefined
				? {}
				: {
						operationHistory: parseConversationOperationHistoryV2(
							values.operationHistory,
						),
					}),
		};
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
			const event = parsePersistedRuntimeEvent(values.event);
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
		const event = parsePersistedRuntimeEvent(values.event);
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
							if (command.event.type === "execution.operation") {
								if (state.operationHistory === undefined) return unavailable();
								requireConversationOperationSuccessorV2(
									state.operationHistory,
									command.event.fact,
									command.operationMetadataOnly,
								);
							}
							const event: PersistedRuntimeConversationEventV1 = {
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
								...(command.transition
									? { transition: command.transition }
									: {}),
							};
						})();
						expected = structuredClone(next);
						return structuredClone(next);
					},
				);
				return normalizeDecision(decision, expected);
			} catch {
				return unavailable();
			}
		},
	};
}
