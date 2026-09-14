import { Buffer } from "node:buffer";
import { types } from "node:util";
import type {
	ConversationEventCommandV1,
	ConversationEventDecisionV1,
	ConversationEventStateTransitionV1,
	ConversationEventUseCaseV1,
	ConversationNormalizedEventV1,
} from "./conversation-events.js";
import {
	type ConversationGenerationIsolationV1,
	isConversationGenerationBarrierConfirmedV1,
} from "./conversation-generation-isolation.js";
import {
	type ConversationOperationFactV2,
	parseConversationOperationFactV2,
} from "./conversation-operation-facts.js";

export type ConversationDispatchOperationV1 =
	| "conversation.turn.submit.v1"
	| "conversation.turn.regenerate.v1"
	| "conversation.turn.supplement.v1"
	| "conversation.turn.stop.v1";

export type ConversationDispatchExecutionStatusV1 =
	| "submitted"
	| "processing"
	| "unknown"
	| "completed"
	| "failed"
	| "cancelled";

export type ConversationRuntimeStatusV1 =
	| "idle"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "unavailable"
	| "unknown";

interface ConversationRuntimeEventBaseV1 {
	readonly schemaVersion: 1;
	readonly adapterEventKey: string;
	readonly executionId: string;
	readonly cursor: string;
	readonly occurredAt: string;
}

export type ConversationRuntimeEventV1 = ConversationRuntimeEventBaseV1 &
	(
		| { readonly type: "text"; readonly payload: { readonly delta: string } }
		| {
				readonly type: "status";
				readonly payload: { readonly status: ConversationRuntimeStatusV1 };
		  }
		| {
				readonly type: "tool";
				readonly payload: {
					readonly toolCallId: string;
					readonly name: string;
					readonly phase: "started" | "completed" | "failed";
				};
		  }
		| {
				readonly type: "file";
				readonly payload: {
					readonly fileId: string;
					readonly name: string;
					readonly mimeType: string;
					readonly sizeBytes: number;
				};
		  }
		| {
				readonly type: "completed";
				readonly payload: {
					readonly status: "completed" | "failed" | "cancelled";
				};
		  }
		| {
				readonly type: "error";
				readonly payload: {
					readonly code:
						| "RUNTIME_EXECUTION_FAILED"
						| "RUNTIME_DEPENDENCY_UNAVAILABLE";
					readonly message:
						| "Runtime execution failed"
						| "Runtime dependency is unavailable";
					readonly retryable: boolean;
				};
		  }
	);

export type ConversationRuntimeOperationEventV2 = Omit<
	ConversationRuntimeEventBaseV1,
	"schemaVersion"
> & {
	readonly schemaVersion: 2;
	readonly type: "operation";
	readonly payload: ConversationOperationFactV2;
};
export type ConversationRuntimeEvent =
	| ConversationRuntimeEventV1
	| ConversationRuntimeOperationEventV2;

export interface ConversationDispatchClaimV1 {
	readonly generationIsolation?: ConversationGenerationIsolationV1;
	readonly schemaVersion: 1;
	readonly itemId: string;
	readonly leaseOwner: string;
	readonly operation: ConversationDispatchOperationV1;
	readonly requestId: string;
	readonly traceId: string;
	readonly agentId: string;
	readonly actorId: string;
	readonly channelId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly turnId: string;
	readonly messageId: string | null;
	readonly stopRequestId: string | null;
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
	readonly executionDeliveryFence: number;
	readonly authorizationRevision: string;
	readonly modelConfigurationRevision: number | null;
	readonly modelOptionId: string | null;
	readonly reasoningLevel: string | null;
	readonly hostSessionRef: string | null;
	readonly runtimeCursor: string | null;
	/** Derived by the Store from the original committed Runtime terminal event. */
	readonly runtimeTerminalEventSeen?: true;
	readonly input: {
		readonly text: string;
		readonly attachments: readonly string[];
	} | null;
	readonly executionStatus: ConversationDispatchExecutionStatusV1;
	readonly stopPending: boolean;
}

export type ConversationDispatchClaimDecisionV1 =
	| { readonly outcome: "claimed"; readonly claim: ConversationDispatchClaimV1 }
	| { readonly outcome: "busy" | "stale" | "succeeded" | "failed" };

export interface ConversationDispatchStateTransitionV1 {
	readonly executionStatus?: ConversationDispatchExecutionStatusV1;
	readonly conversationStatus?: "ready" | "active" | "unavailable";
}

export interface ConversationDispatchStorePortV1 {
	beginGenerationIsolation?(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly failureCode: "RUNTIME_SESSION_RECOVERY_FAILED";
		readonly hostSessionRef: string;
	}): Promise<boolean>;
	confirmGenerationIsolation?(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly operationId: string;
		readonly hostSessionRef: string;
	}): Promise<boolean>;
	claim(input: {
		readonly schemaVersion: 1;
		readonly itemId: string;
		readonly workerId: string;
		readonly leaseDurationMs: number;
	}): Promise<ConversationDispatchClaimDecisionV1>;
	renew(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly leaseDurationMs: number;
	}): Promise<boolean>;
	prepareRuntimeDispatch(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly leaseDurationMs: number;
	}): Promise<boolean | "capacity_wait" | "capacity_unavailable">;
	cancelUnaccepted(input: {
		readonly claim: ConversationDispatchClaimV1;
	}): Promise<boolean>;
	recordRuntimeResponse(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly hostSessionRef: string;
		readonly transition: ConversationDispatchStateTransitionV1;
	}): Promise<boolean>;
	finish(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly status: "succeeded" | "failed";
		readonly transition: ConversationDispatchStateTransitionV1;
		readonly errorCode?: string;
	}): Promise<boolean>;
	retry(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly retryDelayMs: number;
		readonly errorCode: string;
		readonly transition: ConversationDispatchStateTransitionV1;
	}): Promise<boolean>;
}

export interface ConversationDispatchAuthorityV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly actorId: string;
	readonly channelId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly turnId: string;
	readonly sessionGeneration: number;
	readonly authorizationRevision: string;
	readonly runtimeGrant: unknown;
	/** Trusted historical principal evidence permits only recovery and system controls. */
	readonly controlOnly?: true;
}

export interface ConversationDispatchAuthorizationPortV1 {
	authorize(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly schemaVersion: 1;
		readonly operation: ConversationDispatchOperationV1;
		readonly agentId: string;
		readonly actorId: string;
		readonly channelId: string;
		readonly conversationId: string;
		readonly executionId: string;
		readonly turnId: string;
		readonly sessionGeneration: number;
		readonly authorizationRevision: string;
		readonly traceId: string;
	}): Promise<
		| {
				readonly outcome: "allowed";
				readonly authority: ConversationDispatchAuthorityV1;
		  }
		| { readonly outcome: "denied" | "unavailable" }
	>;
}

export interface ConversationRuntimeDispatchRequestV1 {
	readonly schemaVersion: 1;
	readonly operation: "turn.submit" | "turn.supplement" | "turn.stop";
	readonly requestId: string;
	readonly traceId: string;
	readonly agentId: string;
	readonly actorId: string;
	readonly channelId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly turnId: string;
	readonly messageId?: string;
	readonly stopRequestId?: string;
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
	readonly executionDeliveryFence?: number;
	readonly hostSessionRef?: string;
	readonly input?: {
		readonly text: string;
		readonly attachments: readonly string[];
	};
	readonly selection?: {
		readonly schemaVersion: 1;
		readonly modelOptionId: string;
		readonly reasoningLevel: string;
	};
	readonly runtimeGrant: unknown;
}

export type ConversationRuntimeOperationResultV1 =
	| {
			readonly outcome: "accepted";
			readonly status: ConversationRuntimeStatusV1;
	  }
	| { readonly outcome: "busy" }
	| {
			readonly outcome: "rejected";
			readonly code:
				| "RUNTIME_TURN_NOT_ACTIVE"
				| "RUNTIME_MODEL_SELECTION_UNSUPPORTED";
			readonly message:
				| "Runtime turn is no longer active"
				| "Runtime model selection is unsupported";
			readonly retryable: false;
	  }
	| {
			readonly outcome: "unknown";
			readonly code: "RUNTIME_ACCEPTANCE_UNKNOWN";
			readonly message: "Runtime command acceptance could not be confirmed";
	  };

export interface ConversationRuntimeOperationResponseV1 {
	readonly schemaVersion: 1 | 2;
	readonly hostSessionRef: string;
	readonly operationId: string;
	readonly result: ConversationRuntimeOperationResultV1;
}

export interface ConversationRuntimeEventRequestV1 {
	readonly schemaVersion: 1;
	readonly requestId: string;
	readonly traceId: string;
	readonly agentId: string;
	readonly actorId: string;
	readonly channelId: string;
	readonly conversationId: string;
	readonly executionId: string;
	readonly turnId: string;
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
	readonly hostSessionRef: string;
	readonly afterCursor?: string;
	readonly runtimeGrant: unknown;
}

export type ConversationRuntimeStatusRequestV2 = Omit<
	ConversationRuntimeEventRequestV1,
	"afterCursor" | "schemaVersion"
> & {
	readonly schemaVersion: 2;
	readonly recovery: {
		readonly schemaVersion: 1;
		readonly input: {
			readonly text: string;
			readonly attachments: readonly string[];
		};
		readonly selection?: {
			readonly schemaVersion: 1;
			readonly modelOptionId: string;
			readonly reasoningLevel: string;
		};
	};
};

export type ConversationRuntimeStatusResponseV2 = {
	readonly schemaVersion: 2;
	readonly hostSessionRef: string | null;
	readonly executionId: string;
} & (
	| {
			readonly outcome: "found";
			readonly status: ConversationRuntimeStatusV1;
	  }
	| { readonly outcome: "not_found" }
	| {
			readonly outcome: "recovery_failed";
			readonly hostSessionRef: string;
			readonly code: "RUNTIME_SESSION_RECOVERY_FAILED";
	  }
);

export interface ConversationRuntimeHostPortV1 {
	cancelGeneration?(
		request: ConversationRuntimeEventRequestV1,
		signal?: AbortSignal,
	): Promise<ConversationRuntimeOperationResponseV1>;
	drainGenerationEvents?(
		request: ConversationRuntimeEventRequestV1,
		signal?: AbortSignal,
	): AsyncIterable<ConversationRuntimeEvent>;
	recoverOriginalStatus?(
		request: Omit<
			ConversationRuntimeStatusRequestV2,
			"hostSessionRef" | "recovery"
		> & { readonly hostSessionRef: string | null },
		signal?: AbortSignal,
	): Promise<ConversationRuntimeStatusResponseV2>;
	/** Confirm only after the Platform event and necessary audit transaction commits. */
	acknowledge?(
		request: ConversationRuntimeEventRequestV1 & {
			readonly confirmedCursor: string;
		},
		signal?: AbortSignal,
	): Promise<void>;
	/** Renew business authority from current user facts, never from an old Grant. */
	renewAuthorization?(
		request: ConversationRuntimeEventRequestV1,
		signal?: AbortSignal,
	): Promise<void>;
	dispatch(
		request: ConversationRuntimeDispatchRequestV1,
		signal?: AbortSignal,
	): Promise<ConversationRuntimeOperationResponseV1>;
	recoverStatus(
		request: ConversationRuntimeStatusRequestV2,
		signal?: AbortSignal,
	): Promise<ConversationRuntimeStatusResponseV2>;
	events(
		request: ConversationRuntimeEventRequestV1,
		signal?: AbortSignal,
	): AsyncIterable<ConversationRuntimeEvent>;
}

export interface DispatchConversationCommandV1 {
	readonly schemaVersion: 1;
	readonly itemId: string;
	readonly workerId: string;
}

export type ConversationDispatchDecisionV1 =
	| { readonly schemaVersion: 1; readonly outcome: "accepted" }
	| {
			readonly schemaVersion: 1;
			readonly outcome: "busy" | "unknown" | "retry";
			readonly retryScheduled: boolean;
	  }
	| { readonly schemaVersion: 1; readonly outcome: "rejected" | "stale" }
	| { readonly schemaVersion: 1; readonly outcome: "already_completed" };

export interface ConversationDispatchUseCaseV1 {
	dispatch(
		command: DispatchConversationCommandV1,
	): Promise<ConversationDispatchDecisionV1>;
}

export class ConversationDispatchError extends Error {
	readonly code: "invalid_input" | "unavailable";

	constructor(code: "invalid_input" | "unavailable") {
		super(
			code === "invalid_input"
				? "Invalid Conversation dispatch command"
				: "Conversation dispatch is unavailable",
		);
		this.name = "ConversationDispatchError";
		this.code = code;
	}
}

export class ConversationRuntimeHostError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, retryable: boolean) {
		super("RuntimeHost request failed");
		this.name = "ConversationRuntimeHostError";
		this.code = code;
		this.retryable = retryable;
	}
}

function invalidInput(): never {
	throw new ConversationDispatchError("invalid_input");
}

function unavailable(): never {
	throw new ConversationDispatchError("unavailable");
}

function exactObject(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			Array.isArray(value) ||
			types.isProxy(value)
		) {
			unavailable();
		}
		const allowed = new Set([...required, ...optional]);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (
			Reflect.ownKeys(descriptors).some(
				(key) => typeof key !== "string" || !allowed.has(key),
			) ||
			required.some((key) => !Object.hasOwn(descriptors, key))
		) {
			unavailable();
		}
		const result: Record<string, unknown> = {};
		for (const key of [...required, ...optional]) {
			const descriptor = descriptors[key];
			if (descriptor === undefined) continue;
			if (
				descriptor.enumerable !== true ||
				!Object.hasOwn(descriptor, "value") ||
				Object.hasOwn(descriptor, "get") ||
				Object.hasOwn(descriptor, "set")
			) {
				unavailable();
			}
			result[key] = descriptor.value;
		}
		return result;
	} catch (error) {
		if (error instanceof ConversationDispatchError) throw error;
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

function positiveInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		return unavailable();
	}
	return value;
}

function nonNegativeInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		return unavailable();
	}
	return value;
}

function nullableText(value: unknown): string | null {
	return value === null ? null : text(value);
}

function operation(value: unknown): ConversationDispatchOperationV1 {
	if (
		value !== "conversation.turn.submit.v1" &&
		value !== "conversation.turn.regenerate.v1" &&
		value !== "conversation.turn.supplement.v1" &&
		value !== "conversation.turn.stop.v1"
	) {
		return unavailable();
	}
	return value;
}

function executionStatus(
	value: unknown,
): ConversationDispatchExecutionStatusV1 {
	if (
		value !== "submitted" &&
		value !== "processing" &&
		value !== "unknown" &&
		value !== "completed" &&
		value !== "failed" &&
		value !== "cancelled"
	) {
		return unavailable();
	}
	return value;
}

function parseCommand(value: unknown): DispatchConversationCommandV1 {
	try {
		const input = exactObject(value, ["schemaVersion", "itemId", "workerId"]);
		if (input.schemaVersion !== 1) invalidInput();
		return {
			schemaVersion: 1,
			itemId: text(input.itemId),
			workerId: text(input.workerId),
		};
	} catch {
		return invalidInput();
	}
}

function parseClaim(value: unknown): ConversationDispatchClaimV1 {
	const input = exactObject(
		value,
		[
			"schemaVersion",
			"itemId",
			"leaseOwner",
			"operation",
			"requestId",
			"traceId",
			"agentId",
			"actorId",
			"channelId",
			"conversationId",
			"executionId",
			"turnId",
			"messageId",
			"stopRequestId",
			"sessionGeneration",
			"deliveryFence",
			"executionDeliveryFence",
			"authorizationRevision",
			"modelConfigurationRevision",
			"modelOptionId",
			"reasoningLevel",
			"hostSessionRef",
			"runtimeCursor",
			"input",
			"executionStatus",
			"stopPending",
		],
		["generationIsolation", "runtimeTerminalEventSeen"],
	);
	if (
		input.schemaVersion !== 1 ||
		(input.runtimeTerminalEventSeen !== undefined &&
			(input.runtimeTerminalEventSeen !== true ||
				!["completed", "failed", "cancelled"].includes(
					String(input.executionStatus),
				) ||
				input.runtimeCursor === null))
	)
		return unavailable();
	const parsedOperation = operation(input.operation);
	const messageId = nullableText(input.messageId);
	const stopRequestId = nullableText(input.stopRequestId);
	const modelConfigurationRevision =
		input.modelConfigurationRevision === null
			? null
			: positiveInteger(input.modelConfigurationRevision);
	const modelOptionId = nullableText(input.modelOptionId);
	const reasoningLevel = nullableText(input.reasoningLevel);
	const runtimeInput = (() => {
		if (input.input === null) return null;
		const value = exactObject(input.input, ["text", "attachments"]);
		if (!Array.isArray(value.attachments)) return unavailable();
		return {
			text: text(value.text, 65_536),
			attachments: value.attachments.map((entry) => text(entry)),
		};
	})();
	let generationIsolation: ConversationGenerationIsolationV1 | undefined;
	if (input.generationIsolation !== undefined) {
		const isolation = exactObject(input.generationIsolation, [
			"operationId",
			"controlRecordId",
			"originalPrincipal",
		]);
		const principal = exactObject(isolation.originalPrincipal, ["kind", "id"]);
		if (principal.kind !== "user" || principal.id !== input.actorId)
			unavailable();
		generationIsolation = {
			operationId: text(isolation.operationId),
			controlRecordId: text(isolation.controlRecordId),
			originalPrincipal: { kind: "user", id: text(principal.id) },
		};
	}
	const isStop = parsedOperation === "conversation.turn.stop.v1";
	if (
		isStop !== (stopRequestId !== null) ||
		isStop !== (runtimeInput === null) ||
		isStop === (messageId !== null) ||
		new Set([
			modelConfigurationRevision === null,
			modelOptionId === null,
			reasoningLevel === null,
		]).size !== 1
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		itemId: text(input.itemId),
		leaseOwner: text(input.leaseOwner),
		operation: parsedOperation,
		...(generationIsolation ? { generationIsolation } : {}),
		requestId: text(input.requestId),
		traceId: text(input.traceId),
		agentId: text(input.agentId),
		actorId: text(input.actorId),
		channelId: text(input.channelId),
		conversationId: text(input.conversationId),
		executionId: text(input.executionId),
		turnId: text(input.turnId),
		messageId,
		stopRequestId,
		sessionGeneration: positiveInteger(input.sessionGeneration),
		deliveryFence: positiveInteger(input.deliveryFence),
		executionDeliveryFence: nonNegativeInteger(input.executionDeliveryFence),
		authorizationRevision: text(input.authorizationRevision),
		modelConfigurationRevision,
		modelOptionId,
		reasoningLevel,
		hostSessionRef: nullableText(input.hostSessionRef),
		runtimeCursor: nullableText(input.runtimeCursor),
		...(input.runtimeTerminalEventSeen === true
			? { runtimeTerminalEventSeen: true as const }
			: {}),
		input: runtimeInput,
		executionStatus: executionStatus(input.executionStatus),
		stopPending:
			typeof input.stopPending === "boolean"
				? input.stopPending
				: unavailable(),
	};
}

function parseAuthority(
	value: unknown,
	claim: ConversationDispatchClaimV1,
): ConversationDispatchAuthorityV1 {
	const input = exactObject(
		value,
		[
			"schemaVersion",
			"agentId",
			"actorId",
			"channelId",
			"conversationId",
			"executionId",
			"turnId",
			"sessionGeneration",
			"authorizationRevision",
			"runtimeGrant",
		],
		["controlOnly"],
	);
	if (
		input.schemaVersion !== 1 ||
		input.agentId !== claim.agentId ||
		input.actorId !== claim.actorId ||
		input.channelId !== claim.channelId ||
		input.conversationId !== claim.conversationId ||
		input.executionId !== claim.executionId ||
		input.turnId !== claim.turnId ||
		input.sessionGeneration !== claim.sessionGeneration ||
		input.authorizationRevision !== claim.authorizationRevision ||
		input.runtimeGrant === undefined ||
		(input.controlOnly !== undefined && input.controlOnly !== true)
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		agentId: claim.agentId,
		actorId: claim.actorId,
		channelId: claim.channelId,
		conversationId: claim.conversationId,
		executionId: claim.executionId,
		turnId: claim.turnId,
		sessionGeneration: claim.sessionGeneration,
		authorizationRevision: claim.authorizationRevision,
		runtimeGrant: input.runtimeGrant,
		...(input.controlOnly === true ? { controlOnly: true as const } : {}),
	};
}

function runtimeOperation(claim: ConversationDispatchClaimV1) {
	if (claim.operation === "conversation.turn.supplement.v1") {
		return "turn.supplement" as const;
	}
	if (claim.operation === "conversation.turn.stop.v1")
		return "turn.stop" as const;
	return "turn.submit" as const;
}

function isTurnOperation(operation: ConversationDispatchOperationV1) {
	return (
		operation === "conversation.turn.submit.v1" ||
		operation === "conversation.turn.regenerate.v1"
	);
}

function operationId(claim: ConversationDispatchClaimV1): string {
	if (claim.operation === "conversation.turn.supplement.v1") {
		return claim.messageId ?? unavailable();
	}
	if (claim.operation === "conversation.turn.stop.v1") {
		return claim.stopRequestId ?? unavailable();
	}
	return claim.executionId;
}

function runtimeRequest(
	claim: ConversationDispatchClaimV1,
	authority: ConversationDispatchAuthorityV1,
): ConversationRuntimeDispatchRequestV1 {
	const base = {
		schemaVersion: 1 as const,
		operation: runtimeOperation(claim),
		requestId: claim.requestId,
		traceId: claim.traceId,
		agentId: claim.agentId,
		actorId: claim.actorId,
		channelId: claim.channelId,
		conversationId: claim.conversationId,
		executionId: claim.executionId,
		turnId: claim.turnId,
		sessionGeneration: claim.sessionGeneration,
		deliveryFence: claim.deliveryFence,
		...(claim.hostSessionRef ? { hostSessionRef: claim.hostSessionRef } : {}),
		runtimeGrant: authority.runtimeGrant,
	};
	if (claim.operation === "conversation.turn.stop.v1") {
		return {
			...base,
			operation: "turn.stop",
			stopRequestId: claim.stopRequestId ?? unavailable(),
			executionDeliveryFence: claim.executionDeliveryFence,
		};
	}
	if (claim.operation === "conversation.turn.supplement.v1") {
		return {
			...base,
			operation: "turn.supplement",
			messageId: claim.messageId ?? unavailable(),
			executionDeliveryFence: claim.executionDeliveryFence,
			input: claim.input ?? unavailable(),
		};
	}
	return {
		...base,
		operation: "turn.submit",
		input: claim.input ?? unavailable(),
		...(claim.modelOptionId && claim.reasoningLevel
			? {
					selection: {
						schemaVersion: 1 as const,
						modelOptionId: claim.modelOptionId,
						reasoningLevel: claim.reasoningLevel,
					},
				}
			: {}),
	};
}

function runtimeStatus(value: unknown): ConversationRuntimeStatusV1 {
	if (
		value !== "idle" &&
		value !== "running" &&
		value !== "completed" &&
		value !== "failed" &&
		value !== "cancelled" &&
		value !== "unavailable" &&
		value !== "unknown"
	) {
		return unavailable();
	}
	return value;
}

function parseRuntimeResponse(
	value: unknown,
	claim: ConversationDispatchClaimV1,
): ConversationRuntimeOperationResponseV1 {
	const input = exactObject(value, [
		"schemaVersion",
		"hostSessionRef",
		"operationId",
		"result",
	]);
	const expectedVersion =
		isTurnOperation(claim.operation) && claim.modelOptionId !== null ? 2 : 1;
	if (
		input.schemaVersion !== expectedVersion ||
		input.operationId !== operationId(claim)
	) {
		return unavailable();
	}
	const resultInput = exactObject(
		input.result,
		["outcome"],
		["status", "code", "message", "retryable"],
	);
	let result: ConversationRuntimeOperationResultV1;
	if (resultInput.outcome === "accepted") {
		if (
			resultInput.code !== undefined ||
			resultInput.message !== undefined ||
			resultInput.retryable !== undefined
		) {
			return unavailable();
		}
		result = { outcome: "accepted", status: runtimeStatus(resultInput.status) };
	} else if (resultInput.outcome === "busy") {
		if (
			resultInput.status !== undefined ||
			resultInput.code !== undefined ||
			resultInput.message !== undefined ||
			resultInput.retryable !== undefined
		) {
			return unavailable();
		}
		result = { outcome: "busy" };
	} else if (resultInput.outcome === "rejected") {
		const turnEnded =
			resultInput.code === "RUNTIME_TURN_NOT_ACTIVE" &&
			resultInput.message === "Runtime turn is no longer active";
		const unsupportedSelection =
			expectedVersion === 2 &&
			resultInput.code === "RUNTIME_MODEL_SELECTION_UNSUPPORTED" &&
			resultInput.message === "Runtime model selection is unsupported";
		if (
			resultInput.status !== undefined ||
			(!turnEnded && !unsupportedSelection) ||
			resultInput.retryable !== false
		) {
			return unavailable();
		}
		result = {
			outcome: "rejected",
			code: resultInput.code as
				| "RUNTIME_TURN_NOT_ACTIVE"
				| "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
			message: resultInput.message as
				| "Runtime turn is no longer active"
				| "Runtime model selection is unsupported",
			retryable: false,
		};
	} else if (resultInput.outcome === "unknown") {
		if (
			resultInput.status !== undefined ||
			resultInput.code !== "RUNTIME_ACCEPTANCE_UNKNOWN" ||
			resultInput.message !==
				"Runtime command acceptance could not be confirmed" ||
			resultInput.retryable !== undefined
		) {
			return unavailable();
		}
		result = {
			outcome: "unknown",
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			message: "Runtime command acceptance could not be confirmed",
		};
	} else {
		return unavailable();
	}
	return {
		schemaVersion: expectedVersion,
		hostSessionRef: text(input.hostSessionRef),
		operationId: input.operationId,
		result,
	};
}

function parseRuntimeStatusResponse(
	value: unknown,
	claim: ConversationDispatchClaimV1,
): ConversationRuntimeStatusResponseV2 {
	const input = exactObject(
		value,
		["schemaVersion", "hostSessionRef", "executionId", "outcome"],
		["status", "code"],
	);
	if (
		input.schemaVersion !== 2 ||
		(claim.hostSessionRef !== null &&
			input.hostSessionRef !== claim.hostSessionRef) ||
		input.executionId !== claim.executionId
	) {
		return unavailable();
	}
	if (
		input.outcome === "recovery_failed" &&
		input.code === "RUNTIME_SESSION_RECOVERY_FAILED" &&
		input.status === undefined
	)
		return {
			schemaVersion: 2,
			hostSessionRef: text(input.hostSessionRef),
			executionId: claim.executionId,
			outcome: "recovery_failed",
			code: "RUNTIME_SESSION_RECOVERY_FAILED",
		};
	if (input.code !== undefined) return unavailable();
	if (input.outcome === "not_found" && input.status === undefined) {
		return {
			schemaVersion: 2,
			hostSessionRef:
				input.hostSessionRef === null ? null : text(input.hostSessionRef),
			executionId: claim.executionId,
			outcome: "not_found",
		};
	}
	if (input.outcome !== "found" || input.status === undefined) {
		return unavailable();
	}
	return {
		schemaVersion: 2,
		hostSessionRef: text(input.hostSessionRef),
		executionId: claim.executionId,
		outcome: "found",
		status: runtimeStatus(input.status),
	};
}

function parseRuntimeEvent(
	value: unknown,
	claim: ConversationDispatchClaimV1,
): ConversationRuntimeEvent {
	const input = exactObject(value, [
		"schemaVersion",
		"adapterEventKey",
		"executionId",
		"cursor",
		"occurredAt",
		"type",
		"payload",
	]);
	if (
		(input.schemaVersion !== 1 && input.schemaVersion !== 2) ||
		input.executionId !== claim.executionId
	) {
		return unavailable();
	}
	const base = {
		schemaVersion: 1 as const,
		adapterEventKey: text(input.adapterEventKey),
		executionId: claim.executionId,
		cursor: text(input.cursor),
		occurredAt: text(input.occurredAt, 128),
	};
	if (input.schemaVersion === 2) {
		if (input.type !== "operation") return unavailable();
		return {
			...base,
			schemaVersion: 2,
			type: "operation",
			payload: parseConversationOperationFactV2(input.payload),
		};
	}
	if (input.type === "text") {
		const payload = exactObject(input.payload, ["delta"]);
		return {
			...base,
			type: "text",
			payload: { delta: text(payload.delta, 65_536) },
		};
	}
	if (input.type === "status") {
		const payload = exactObject(input.payload, ["status"]);
		return {
			...base,
			type: "status",
			payload: { status: runtimeStatus(payload.status) },
		};
	}
	if (input.type === "tool") {
		const payload = exactObject(input.payload, ["toolCallId", "name", "phase"]);
		if (
			payload.phase !== "started" &&
			payload.phase !== "completed" &&
			payload.phase !== "failed"
		) {
			return unavailable();
		}
		return {
			...base,
			type: "tool",
			payload: {
				toolCallId: text(payload.toolCallId),
				name: text(payload.name),
				phase: payload.phase,
			},
		};
	}
	if (input.type === "file") {
		const payload = exactObject(input.payload, [
			"fileId",
			"name",
			"mimeType",
			"sizeBytes",
		]);
		if (
			typeof payload.sizeBytes !== "number" ||
			!Number.isSafeInteger(payload.sizeBytes) ||
			payload.sizeBytes < 0
		) {
			return unavailable();
		}
		return {
			...base,
			type: "file",
			payload: {
				fileId: text(payload.fileId),
				name: text(payload.name),
				mimeType: text(payload.mimeType, 255),
				sizeBytes: payload.sizeBytes,
			},
		};
	}
	if (input.type === "completed") {
		const payload = exactObject(input.payload, ["status"]);
		if (
			payload.status !== "completed" &&
			payload.status !== "failed" &&
			payload.status !== "cancelled"
		) {
			return unavailable();
		}
		return { ...base, type: "completed", payload: { status: payload.status } };
	}
	if (input.type === "error") {
		const payload = exactObject(input.payload, [
			"code",
			"message",
			"retryable",
		]);
		const valid =
			(payload.code === "RUNTIME_EXECUTION_FAILED" &&
				payload.message === "Runtime execution failed" &&
				payload.retryable === false) ||
			(payload.code === "RUNTIME_DEPENDENCY_UNAVAILABLE" &&
				payload.message === "Runtime dependency is unavailable" &&
				payload.retryable === true);
		if (!valid) return unavailable();
		return {
			...base,
			type: "error",
			payload: {
				code: payload.code as
					| "RUNTIME_EXECUTION_FAILED"
					| "RUNTIME_DEPENDENCY_UNAVAILABLE",
				message: payload.message as
					| "Runtime execution failed"
					| "Runtime dependency is unavailable",
				retryable: payload.retryable as boolean,
			},
		};
	}
	return unavailable();
}

function normalizedEvent(
	event: ConversationRuntimeEvent,
): ConversationNormalizedEventV1 {
	if (event.type === "operation")
		return {
			schemaVersion: 2,
			type: "execution.operation",
			fact: parseConversationOperationFactV2(event.payload),
		};
	if (event.type === "text")
		return { type: "text.delta", text: event.payload.delta };
	if (event.type === "file") {
		return {
			type: "result.file",
			fileId: event.payload.fileId,
			name: event.payload.name,
			mediaType: event.payload.mimeType,
			sizeBytes: event.payload.sizeBytes,
		};
	}
	if (event.type === "tool") {
		return {
			type: "execution.detail",
			category: "status",
			summary: `Runtime tool ${event.payload.phase}: ${event.payload.name}`,
			callId: event.payload.toolCallId,
		};
	}
	if (event.type === "error") {
		return {
			type: "conversation.error",
			code: event.payload.code,
			message: event.payload.message,
			retryable: event.payload.retryable,
		};
	}
	if (event.type === "completed") {
		return { type: "execution.status", status: event.payload.status };
	}
	if (event.payload.status === "running") {
		return { type: "execution.status", status: "processing" };
	}
	if (
		event.payload.status === "completed" ||
		event.payload.status === "failed" ||
		event.payload.status === "cancelled" ||
		event.payload.status === "unknown"
	) {
		return { type: "execution.status", status: event.payload.status };
	}
	return {
		type:
			event.payload.status === "unavailable"
				? "conversation.error"
				: "execution.detail",
		...(event.payload.status === "unavailable"
			? {
					code: "RUNTIME_DEPENDENCY_UNAVAILABLE",
					message: "Runtime dependency is unavailable",
					retryable: true,
				}
			: { category: "status", summary: "Runtime is idle" }),
	} as ConversationNormalizedEventV1;
}

function transitionForStatus(
	status: ConversationDispatchExecutionStatusV1,
): ConversationDispatchStateTransitionV1 {
	return {
		executionStatus: status,
		conversationStatus:
			status === "completed" || status === "failed" || status === "cancelled"
				? "ready"
				: "active",
	};
}

function acceptedTransition(status: ConversationRuntimeStatusV1) {
	if (status === "running") return transitionForStatus("processing");
	if (status === "unknown") return transitionForStatus("unknown");
	if (status === "completed" || status === "failed" || status === "cancelled") {
		return transitionForStatus(status);
	}
	return undefined;
}

function transitionFromEvent(
	event: ConversationNormalizedEventV1,
): ConversationEventStateTransitionV1 | undefined {
	if (event.type !== "execution.status") return undefined;
	return {
		executionStatus: event.status,
		conversationStatus:
			event.status === "completed" ||
			event.status === "failed" ||
			event.status === "cancelled"
				? "ready"
				: "active",
	};
}

function terminalStatus(event: ConversationNormalizedEventV1) {
	return event.type === "execution.status" &&
		(event.status === "completed" ||
			event.status === "failed" ||
			event.status === "cancelled")
		? event.status
		: undefined;
}

function executionTerminal(status: ConversationDispatchExecutionStatusV1) {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

function retryTransition(claim: ConversationDispatchClaimV1) {
	if (executionTerminal(claim.executionStatus)) return {};
	return claim.operation === "conversation.turn.submit.v1" ||
		claim.operation === "conversation.turn.regenerate.v1"
		? transitionForStatus("unknown")
		: {};
}

function rejectedTransition(claim: ConversationDispatchClaimV1) {
	return claim.operation === "conversation.turn.submit.v1" ||
		claim.operation === "conversation.turn.regenerate.v1"
		? transitionForStatus("failed")
		: {};
}

function runtimeFailure(error: unknown) {
	return error instanceof ConversationRuntimeHostError
		? error
		: new ConversationRuntimeHostError("RUNTIME_UNAVAILABLE", true);
}

function heartbeat(
	store: ConversationDispatchStorePortV1,
	claim: ConversationDispatchClaimV1,
	leaseDurationMs: number,
	renewAuthorization?: (signal: AbortSignal) => Promise<void>,
) {
	let current = true;
	let pending = Promise.resolve();
	const controller = new AbortController();
	const timer = setInterval(
		() => {
			pending = pending.then(async () => {
				if (!current) return;
				try {
					current = await store.renew({ claim, leaseDurationMs });
					if (current && renewAuthorization)
						await renewAuthorization(controller.signal);
				} catch {
					current = false;
				}
				if (!current) controller.abort();
			});
		},
		Math.max(1, Math.floor(leaseDurationMs / 3)),
	);
	timer.unref?.();
	return {
		signal: controller.signal,
		async stop() {
			clearInterval(timer);
			await pending;
			return current;
		},
	};
}

async function retry(
	store: ConversationDispatchStorePortV1,
	claim: ConversationDispatchClaimV1,
	retryDelayMs: number,
	errorCode: string,
	outcome: "busy" | "unknown" | "retry",
	transition = retryTransition(claim),
): Promise<ConversationDispatchDecisionV1> {
	const scheduled = await store.retry({
		claim,
		retryDelayMs,
		errorCode,
		transition,
	});
	return scheduled
		? { schemaVersion: 1, outcome, retryScheduled: true }
		: { schemaVersion: 1, outcome: "stale" };
}

async function reject(
	store: ConversationDispatchStorePortV1,
	claim: ConversationDispatchClaimV1,
	errorCode: string,
	transition = rejectedTransition(claim),
): Promise<ConversationDispatchDecisionV1> {
	const finished = await store.finish({
		claim,
		status: "failed",
		transition,
		errorCode,
	});
	return finished
		? { schemaVersion: 1, outcome: "rejected" }
		: { schemaVersion: 1, outcome: "stale" };
}

export function createConversationDispatchUseCaseV1(
	dependencies: {
		readonly store: ConversationDispatchStorePortV1;
		readonly authorization: ConversationDispatchAuthorizationPortV1;
		readonly runtimeHost: ConversationRuntimeHostPortV1;
		readonly events: {
			persist(
				command: ConversationEventCommandV1 & {
					readonly dispatchLease: NonNullable<
						ConversationEventCommandV1["dispatchLease"]
					>;
				},
			): ReturnType<ConversationEventUseCaseV1["persist"]>;
		};
	},
	options: {
		readonly leaseDurationMs?: number;
		readonly retryDelayMs?: number;
	} = {},
): ConversationDispatchUseCaseV1 {
	const leaseDurationMs = options.leaseDurationMs ?? 30_000;
	const retryDelayMs = options.retryDelayMs ?? 1_000;
	if (
		!Number.isSafeInteger(leaseDurationMs) ||
		leaseDurationMs < 3 ||
		leaseDurationMs > 300_000 ||
		!Number.isSafeInteger(retryDelayMs) ||
		retryDelayMs < 0 ||
		retryDelayMs > 86_400_000
	) {
		throw new ConversationDispatchError("invalid_input");
	}
	async function persistRuntimeEvents(
		claim: ConversationDispatchClaimV1,
		authority: ConversationDispatchAuthorityV1,
		hostSessionRef: string,
		responseStatus: ConversationRuntimeStatusV1,
	): Promise<ConversationDispatchDecisionV1> {
		const responseFinalStatus =
			responseStatus === "completed" ||
			responseStatus === "failed" ||
			responseStatus === "cancelled"
				? responseStatus
				: undefined;
		let finalStatus = responseFinalStatus;
		let terminalEventSeen = claim.runtimeTerminalEventSeen === true;
		// A terminal event may have committed even if persistence lost its response.
		let terminalCommitPossible =
			executionTerminal(claim.executionStatus) ||
			responseFinalStatus !== undefined;
		const eventRequest: ConversationRuntimeEventRequestV1 = {
			schemaVersion: 1,
			requestId: claim.requestId,
			traceId: claim.traceId,
			agentId: claim.agentId,
			actorId: claim.actorId,
			channelId: claim.channelId,
			conversationId: claim.conversationId,
			executionId: claim.executionId,
			turnId: claim.turnId,
			sessionGeneration: claim.sessionGeneration,
			deliveryFence: claim.executionDeliveryFence,
			hostSessionRef: hostSessionRef,
			...(claim.runtimeCursor ? { afterCursor: claim.runtimeCursor } : {}),
			runtimeGrant: authority.runtimeGrant,
		};
		const eventHeartbeat = heartbeat(
			dependencies.store,
			claim,
			leaseDurationMs,
			!authority.controlOnly && dependencies.runtimeHost.renewAuthorization
				? async (signal) => {
						if (!terminalCommitPossible)
							await dependencies.runtimeHost.renewAuthorization?.(
								eventRequest,
								signal,
							);
					}
				: undefined,
		);
		try {
			// Recover a committed event whose acknowledgement was lost, including
			// the last metadata event when the remaining stream is empty.
			if (claim.runtimeCursor)
				await dependencies.runtimeHost.acknowledge?.(
					{ ...eventRequest, confirmedCursor: claim.runtimeCursor },
					eventHeartbeat.signal,
				);
			for await (const eventInput of dependencies.runtimeHost.events(
				eventRequest,
				eventHeartbeat.signal,
			)) {
				const runtimeEvent = parseRuntimeEvent(eventInput, claim);
				const event = normalizedEvent(runtimeEvent);
				const transition = transitionFromEvent(event);
				const eventFinalStatus = terminalStatus(event);
				const connectionMetadata =
					event.type === "execution.operation" &&
					event.fact.kind === "tool" &&
					event.fact.connection !== undefined &&
					["completed", "failed", "unknown"].includes(event.fact.phase);
				if (
					(terminalEventSeen && !connectionMetadata) ||
					(finalStatus && eventFinalStatus && eventFinalStatus !== finalStatus)
				) {
					const finished = await dependencies.store.finish({
						claim,
						status: "failed",
						transition: {},
						errorCode: "RUNTIME_EVENT_CONFLICT",
					});
					return finished
						? { schemaVersion: 1, outcome: "rejected" }
						: { schemaVersion: 1, outcome: "stale" };
				}
				if (eventFinalStatus) terminalCommitPossible = true;
				let persisted: ConversationEventDecisionV1;
				try {
					persisted = await dependencies.events.persist({
						schemaVersion: 1,
						conversationId: claim.conversationId,
						executionId: claim.executionId,
						sessionGeneration: claim.sessionGeneration,
						deliveryFence: claim.executionDeliveryFence,
						adapterEventKey: runtimeEvent.adapterEventKey,
						runtimeCursor: runtimeEvent.cursor,
						occurredAt: runtimeEvent.occurredAt,
						event,
						// The transaction checks the original persisted attempt and outcome.
						...(terminalEventSeen ? { operationMetadataOnly: true } : {}),
						...(transition &&
						(!responseFinalStatus || terminalEventSeen || eventFinalStatus)
							? { transition }
							: {}),
						dispatchLease: {
							schemaVersion: 1,
							itemId: claim.itemId,
							leaseOwner: claim.leaseOwner,
							deliveryFence: claim.deliveryFence,
						},
					});
				} catch {
					throw new ConversationRuntimeHostError(
						"EVENT_PERSISTENCE_UNAVAILABLE",
						true,
					);
				}
				if (persisted.outcome === "stale") {
					return { schemaVersion: 1, outcome: "stale" };
				}
				if (eventFinalStatus) {
					terminalEventSeen = true;
					finalStatus = eventFinalStatus;
				}
				if (dependencies.runtimeHost.acknowledge)
					await dependencies.runtimeHost.acknowledge(
						{ ...eventRequest, confirmedCursor: runtimeEvent.cursor },
						eventHeartbeat.signal,
					);
			}
		} catch (error) {
			const current = await eventHeartbeat.stop();
			if (!current) return { schemaVersion: 1, outcome: "stale" };
			const failure = runtimeFailure(error);
			return failure.retryable
				? retry(
						dependencies.store,
						claim,
						retryDelayMs,
						failure.code,
						"retry",
						terminalCommitPossible ? {} : retryTransition(claim),
					)
				: reject(
						dependencies.store,
						claim,
						failure.code,
						terminalCommitPossible ? {} : rejectedTransition(claim),
					);
		} finally {
			await eventHeartbeat.stop();
		}
		if (eventHeartbeat.signal.aborted) {
			return { schemaVersion: 1, outcome: "stale" };
		}
		if (!finalStatus) {
			return retry(
				dependencies.store,
				claim,
				retryDelayMs,
				"RUNTIME_STREAM_INCOMPLETE",
				"retry",
			);
		}
		const finished = await dependencies.store.finish({
			claim,
			status: "succeeded",
			// The terminal response or event already committed the business state.
			// A later Execution may now own the Conversation's active status.
			transition: {},
		});
		return finished
			? { schemaVersion: 1, outcome: "accepted" }
			: { schemaVersion: 1, outcome: "stale" };
	}
	return {
		async dispatch(commandInput) {
			const command = parseCommand(commandInput);
			let claimDecision: ConversationDispatchClaimDecisionV1;
			try {
				claimDecision = await dependencies.store.claim({
					...command,
					leaseDurationMs,
				});
			} catch {
				return { schemaVersion: 1, outcome: "retry", retryScheduled: false };
			}
			const claimResult = exactObject(claimDecision, ["outcome"], ["claim"]);
			if (claimResult.outcome !== "claimed") {
				if (claimResult.claim !== undefined) return unavailable();
				if (claimResult.outcome === "busy") {
					return { schemaVersion: 1, outcome: "busy", retryScheduled: false };
				}
				if (claimResult.outcome === "succeeded") {
					return { schemaVersion: 1, outcome: "already_completed" };
				}
				if (claimResult.outcome === "stale") {
					return { schemaVersion: 1, outcome: "stale" };
				}
				if (claimResult.outcome === "failed") {
					return { schemaVersion: 1, outcome: "rejected" };
				}
				return unavailable();
			}
			if (claimResult.claim === undefined) return unavailable();
			const claim = parseClaim(claimResult.claim);
			if (
				claim.itemId !== command.itemId ||
				claim.leaseOwner !== command.workerId
			) {
				return unavailable();
			}

			let authorityDecision: Awaited<
				ReturnType<ConversationDispatchAuthorizationPortV1["authorize"]>
			>;
			try {
				authorityDecision = await dependencies.authorization.authorize({
					claim,
					schemaVersion: 1,
					operation: claim.operation,
					agentId: claim.agentId,
					actorId: claim.actorId,
					channelId: claim.channelId,
					conversationId: claim.conversationId,
					executionId: claim.executionId,
					turnId: claim.turnId,
					sessionGeneration: claim.sessionGeneration,
					authorizationRevision: claim.authorizationRevision,
					traceId: claim.traceId,
				});
			} catch {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"AUTHORIZATION_UNAVAILABLE",
					"retry",
					{},
				);
			}
			const authorization = exactObject(
				authorityDecision,
				["outcome"],
				["authority"],
			);
			if (authorization.outcome === "unavailable") {
				if (authorization.authority !== undefined) return unavailable();
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"AUTHORIZATION_UNAVAILABLE",
					"retry",
					{},
				);
			}
			if (authorization.outcome === "denied") {
				if (authorization.authority !== undefined) return unavailable();
				if (
					claim.executionStatus === "processing" ||
					claim.executionStatus === "unknown" ||
					executionTerminal(claim.executionStatus)
				)
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						"AUTHORIZATION_REVOKED",
						"retry",
						{},
					);
				return reject(dependencies.store, claim, "AUTHORIZATION_REVOKED");
			}
			if (
				authorization.outcome !== "allowed" ||
				authorization.authority === undefined
			) {
				return unavailable();
			}
			const authority = parseAuthority(authorization.authority, claim);
			if (claim.generationIsolation) {
				const isolation = claim.generationIsolation;
				const hostSessionRef = claim.hostSessionRef;
				if (
					!hostSessionRef ||
					!dependencies.runtimeHost.cancelGeneration ||
					!dependencies.runtimeHost.drainGenerationEvents ||
					!dependencies.store.confirmGenerationIsolation
				)
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						"GENERATION_ISOLATION_UNAVAILABLE",
						"retry",
						{},
					);
				const request: ConversationRuntimeEventRequestV1 = {
					schemaVersion: 1,
					requestId: claim.requestId,
					traceId: claim.traceId,
					agentId: claim.agentId,
					actorId: claim.actorId,
					channelId: claim.channelId,
					conversationId: claim.conversationId,
					executionId: claim.executionId,
					turnId: claim.turnId,
					sessionGeneration: claim.sessionGeneration,
					deliveryFence: claim.executionDeliveryFence,
					hostSessionRef,
					runtimeGrant: authority.runtimeGrant,
				};
				const isolationHeartbeat = heartbeat(
					dependencies.store,
					claim,
					leaseDurationMs,
				);
				try {
					const barrier = await dependencies.runtimeHost.cancelGeneration(
						request,
						isolationHeartbeat.signal,
					);
					if (
						!isConversationGenerationBarrierConfirmedV1({
							operationId: isolation.operationId,
							hostSessionRef,
							response: barrier,
						})
					)
						throw new ConversationRuntimeHostError(
							"GENERATION_BARRIER_UNCONFIRMED",
							true,
						);
					// The barrier closes all producers; archive its remaining original events before fencing the DB generation.
					for await (const raw of dependencies.runtimeHost.drainGenerationEvents(
						request,
						isolationHeartbeat.signal,
					)) {
						const runtimeEvent = parseRuntimeEvent(raw, claim);
						const event = normalizedEvent(runtimeEvent);
						const transition = transitionFromEvent(event);
						const persisted = await dependencies.events.persist({
							schemaVersion: 1,
							conversationId: claim.conversationId,
							executionId: claim.executionId,
							sessionGeneration: claim.sessionGeneration,
							deliveryFence: claim.executionDeliveryFence,
							adapterEventKey: runtimeEvent.adapterEventKey,
							runtimeCursor: runtimeEvent.cursor,
							occurredAt: runtimeEvent.occurredAt,
							event,
							...(transition ? { transition } : {}),
							dispatchLease: {
								schemaVersion: 1,
								itemId: claim.itemId,
								leaseOwner: claim.leaseOwner,
								deliveryFence: claim.deliveryFence,
							},
						});
						if (persisted.outcome === "stale")
							return { schemaVersion: 1, outcome: "stale" };
						await dependencies.runtimeHost.acknowledge?.(
							{ ...request, confirmedCursor: runtimeEvent.cursor },
							isolationHeartbeat.signal,
						);
					}
					if (!(await isolationHeartbeat.stop()))
						return { schemaVersion: 1, outcome: "stale" };
					return (await dependencies.store.confirmGenerationIsolation({
						claim,
						operationId: isolation.operationId,
						hostSessionRef,
					}))
						? { schemaVersion: 1, outcome: "accepted" }
						: { schemaVersion: 1, outcome: "stale" };
				} catch {
					if (!(await isolationHeartbeat.stop()))
						return { schemaVersion: 1, outcome: "stale" };
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						"GENERATION_BARRIER_UNCONFIRMED",
						"retry",
						{},
					);
				} finally {
					await isolationHeartbeat.stop();
				}
			}
			if (
				authority.controlOnly &&
				(claim.operation === "conversation.turn.supplement.v1" ||
					claim.executionStatus === "submitted" ||
					(!executionTerminal(claim.executionStatus) &&
						!dependencies.runtimeHost.recoverOriginalStatus))
			) {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"AUTHORIZATION_UNAVAILABLE",
					"retry",
					{},
				);
			}
			if (
				claim.stopPending &&
				claim.operation === "conversation.turn.supplement.v1"
			) {
				return reject(
					dependencies.store,
					claim,
					"ORIGINAL_RESPONSE_ALREADY_FINISHED",
				);
			}
			const recoveringOriginalTurn =
				(claim.stopPending ||
					authority.controlOnly ||
					((claim.executionStatus === "unknown" ||
						claim.executionStatus === "processing") &&
						dependencies.runtimeHost.recoverOriginalStatus !== undefined)) &&
				(claim.operation === "conversation.turn.submit.v1" ||
					claim.operation === "conversation.turn.regenerate.v1");
			if (
				recoveringOriginalTurn &&
				(claim.executionStatus === "submitted" ||
					(claim.hostSessionRef === null &&
						!dependencies.runtimeHost.recoverOriginalStatus))
			) {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"RUNTIME_ACCEPTANCE_UNKNOWN",
					"unknown",
					claim.executionStatus === "submitted" ? {} : retryTransition(claim),
				);
			}
			const executionFinished = executionTerminal(claim.executionStatus);
			if (executionFinished) {
				if (claim.operation === "conversation.turn.supplement.v1") {
					return reject(
						dependencies.store,
						claim,
						"ORIGINAL_RESPONSE_ALREADY_FINISHED",
					);
				}
				if (isTurnOperation(claim.operation) && claim.hostSessionRef) {
					return persistRuntimeEvents(
						claim,
						authority,
						claim.hostSessionRef,
						claim.executionStatus,
					);
				}
				const finished = await dependencies.store.finish({
					claim,
					status: "succeeded",
					transition: {},
				});
				return finished
					? { schemaVersion: 1, outcome: "already_completed" }
					: { schemaVersion: 1, outcome: "stale" };
			}
			if (
				(claim.operation === "conversation.turn.supplement.v1" ||
					claim.operation === "conversation.turn.stop.v1") &&
				claim.executionStatus !== "processing"
			) {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"ORIGINAL_RESPONSE_NOT_STARTED",
					"retry",
				);
			}
			try {
				const preparation = await dependencies.store.prepareRuntimeDispatch({
					claim,
					leaseDurationMs,
				});
				if (
					preparation === "capacity_wait" ||
					preparation === "capacity_unavailable"
				) {
					return retry(
						dependencies.store,
						claim,
						retryDelayMs,
						preparation === "capacity_wait"
							? "AGENT_CAPACITY_FULL"
							: "AGENT_CAPACITY_UNVERIFIED",
						"retry",
						{},
					);
				}
				if (preparation !== true) {
					return { schemaVersion: 1, outcome: "stale" };
				}
			} catch {
				return { schemaVersion: 1, outcome: "retry", retryScheduled: false };
			}
			let response: ConversationRuntimeOperationResponseV1;
			const dispatchHeartbeat = heartbeat(
				dependencies.store,
				claim,
				leaseDurationMs,
			);
			try {
				if (recoveringOriginalTurn) {
					const status = parseRuntimeStatusResponse(
						dependencies.runtimeHost.recoverOriginalStatus
							? await dependencies.runtimeHost.recoverOriginalStatus(
									{
										schemaVersion: 2,
										requestId: claim.requestId,
										traceId: claim.traceId,
										agentId: claim.agentId,
										actorId: claim.actorId,
										channelId: claim.channelId,
										conversationId: claim.conversationId,
										executionId: claim.executionId,
										turnId: claim.turnId,
										sessionGeneration: claim.sessionGeneration,
										deliveryFence: claim.executionDeliveryFence,
										hostSessionRef: claim.hostSessionRef,
										runtimeGrant: authority.runtimeGrant,
									},
									dispatchHeartbeat.signal,
								)
							: await dependencies.runtimeHost.recoverStatus(
									{
										schemaVersion: 2,
										requestId: claim.requestId,
										traceId: claim.traceId,
										agentId: claim.agentId,
										actorId: claim.actorId,
										channelId: claim.channelId,
										conversationId: claim.conversationId,
										executionId: claim.executionId,
										turnId: claim.turnId,
										sessionGeneration: claim.sessionGeneration,
										deliveryFence: claim.executionDeliveryFence,
										hostSessionRef: claim.hostSessionRef ?? unavailable(),
										recovery: {
											schemaVersion: 1,
											input: claim.input ?? unavailable(),
											...(claim.modelOptionId && claim.reasoningLevel
												? {
														selection: {
															schemaVersion: 1 as const,
															modelOptionId: claim.modelOptionId,
															reasoningLevel: claim.reasoningLevel,
														},
													}
												: {}),
										},
										runtimeGrant: authority.runtimeGrant,
									},
									dispatchHeartbeat.signal,
								),
						claim,
					);
					if (status.outcome === "recovery_failed") {
						if (!(await dispatchHeartbeat.stop()))
							return { schemaVersion: 1, outcome: "stale" };
						const started = await dependencies.store.beginGenerationIsolation?.(
							{
								claim,
								hostSessionRef: status.hostSessionRef,
								failureCode: status.code,
							},
						);
						if (!started)
							return {
								schemaVersion: 1,
								outcome: "retry",
								retryScheduled: false,
							};
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							"GENERATION_ISOLATION_PENDING",
							"retry",
							{},
						);
					}
					if (status.outcome === "not_found") {
						if (!(await dispatchHeartbeat.stop())) {
							return { schemaVersion: 1, outcome: "stale" };
						}
						if (!claim.stopPending)
							return retry(
								dependencies.store,
								claim,
								retryDelayMs,
								"RUNTIME_ACCEPTANCE_UNKNOWN",
								"unknown",
								retryTransition(claim),
							);
						const cancelled = await dependencies.store.cancelUnaccepted({
							claim,
						});
						return cancelled
							? { schemaVersion: 1, outcome: "already_completed" }
							: { schemaVersion: 1, outcome: "stale" };
					}
					if (status.status === "unavailable") {
						throw new ConversationRuntimeHostError("RUNTIME_UNAVAILABLE", true);
					}
					response = {
						schemaVersion:
							isTurnOperation(claim.operation) && claim.modelOptionId !== null
								? 2
								: 1,
						hostSessionRef: status.hostSessionRef ?? unavailable(),
						operationId: operationId(claim),
						result: { outcome: "accepted", status: status.status },
					};
				} else {
					response = parseRuntimeResponse(
						await dependencies.runtimeHost.dispatch(
							runtimeRequest(claim, authority),
							dispatchHeartbeat.signal,
						),
						claim,
					);
				}
			} catch (error) {
				const current = await dispatchHeartbeat.stop();
				if (!current) return { schemaVersion: 1, outcome: "stale" };
				if (
					recoveringOriginalTurn &&
					error instanceof ConversationRuntimeHostError &&
					error.code === "RUNTIME_SESSION_RECOVERY_FAILED"
				) {
					if (!claim.hostSessionRef)
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							"RUNTIME_ACCEPTANCE_UNKNOWN",
							"retry",
							{},
						);
					try {
						const started = await dependencies.store.beginGenerationIsolation?.(
							{
								claim,
								hostSessionRef: claim.hostSessionRef,
								failureCode: "RUNTIME_SESSION_RECOVERY_FAILED",
							},
						);
						if (!started)
							return {
								schemaVersion: 1,
								outcome: "retry",
								retryScheduled: false,
							};
						return retry(
							dependencies.store,
							claim,
							retryDelayMs,
							"GENERATION_ISOLATION_PENDING",
							"retry",
							{},
						);
					} catch {
						return {
							schemaVersion: 1,
							outcome: "retry",
							retryScheduled: false,
						};
					}
				}
				const failure = runtimeFailure(error);
				return failure.retryable
					? retry(
							dependencies.store,
							claim,
							retryDelayMs,
							failure.code,
							"retry",
						)
					: reject(dependencies.store, claim, failure.code);
			}
			if (!(await dispatchHeartbeat.stop())) {
				return { schemaVersion: 1, outcome: "stale" };
			}

			const responseTransition =
				response.result.outcome === "accepted"
					? acceptedTransition(response.result.status)
					: response.result.outcome === "unknown"
						? retryTransition(claim)
						: {};
			if (
				response.result.outcome === "accepted" &&
				responseTransition === undefined
			) {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"RUNTIME_RESPONSE_INVALID",
					"retry",
				);
			}
			if (
				!(await dependencies.store.recordRuntimeResponse({
					claim,
					hostSessionRef: response.hostSessionRef,
					transition: responseTransition ?? {},
				}))
			) {
				return { schemaVersion: 1, outcome: "stale" };
			}

			if (response.result.outcome === "busy") {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"RUNTIME_BUSY",
					"busy",
				);
			}
			if (response.result.outcome === "unknown") {
				return retry(
					dependencies.store,
					claim,
					retryDelayMs,
					"RUNTIME_ACCEPTANCE_UNKNOWN",
					"unknown",
				);
			}
			if (response.result.outcome === "rejected") {
				if (
					claim.operation === "conversation.turn.stop.v1" &&
					response.result.code === "RUNTIME_TURN_NOT_ACTIVE"
				) {
					const finished = await dependencies.store.finish({
						claim,
						status: "succeeded",
						transition: {},
					});
					return finished
						? { schemaVersion: 1, outcome: "already_completed" }
						: { schemaVersion: 1, outcome: "stale" };
				}
				return reject(
					dependencies.store,
					claim,
					claim.operation === "conversation.turn.supplement.v1" &&
						response.result.code === "RUNTIME_TURN_NOT_ACTIVE"
						? "ORIGINAL_RESPONSE_ALREADY_FINISHED"
						: response.result.code,
				);
			}
			if (
				claim.operation === "conversation.turn.supplement.v1" ||
				claim.operation === "conversation.turn.stop.v1"
			) {
				const finished = await dependencies.store.finish({
					claim,
					status: "succeeded",
					transition: responseTransition ?? {},
				});
				return finished
					? { schemaVersion: 1, outcome: "accepted" }
					: { schemaVersion: 1, outcome: "stale" };
			}

			return persistRuntimeEvents(
				claim,
				authority,
				response.hostSessionRef,
				response.result.status,
			);
		},
	};
}
