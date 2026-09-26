import type { ConversationGenerationIsolationV1 } from "./conversation-generation-isolation.js";
import type { ConversationOperationFactV2 } from "./conversation-operation-facts.js";

export type ConversationDispatchOperationV1 =
	| "conversation.turn.submit.v1"
	| "conversation.turn.regenerate.v1"
	| "conversation.turn.supplement.v1"
	| "conversation.turn.stop.v1";

export type ConversationDispatchExecutionStatusV1 =
	| "waiting"
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

export interface ConversationMetadataRecoveryV1 {
	readonly id: string;
	readonly requestedAt: number;
	readonly originalStatus: "succeeded" | "failed";
}

export interface ConversationDispatchClaimV1 {
	/** Original API acceptance order, retained through recovery. */
	readonly taskWaitOrder?: number;
	readonly metadataRecovery?: ConversationMetadataRecoveryV1;
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
