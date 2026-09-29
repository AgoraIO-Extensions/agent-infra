import type { ConversationMetadataRecoveryV1 } from "./conversation-dispatch.js";
import type { PersistedConversationEventV1 } from "./conversation-events.js";
import type { ConversationOperationFactV2 } from "./conversation-operation-facts.js";
import type { TaskAuthorizationBoundaryV1 } from "./task-authorization.js";

export interface ConversationExecutionAuthorityV1 {
	readonly schemaVersion: 1;
	readonly actorId: string;
	readonly agentId: string;
	readonly channelId: string;
	readonly authorizationRevision: string;
	readonly supportsSupplementaryInstruction: boolean;
	readonly taskBoundary?: TaskAuthorizationBoundaryV1;
}

export interface ConversationExecutionAuthorizationPortV1 {
	authorize(input: {
		readonly schemaVersion: 1;
		readonly operation:
			| "conversation.read"
			| "conversation.create"
			| "message"
			| "model.select"
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
	readonly attachments?: readonly string[];
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

export interface ConversationModelSelectionCommandV1 {
	readonly schemaVersion: 1;
	readonly command: "model.select";
	readonly conversationId: string;
	readonly modelOptionId: string;
	readonly reasoningLevel: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export interface ConversationStateQueryV1 {
	readonly schemaVersion: 1;
	readonly conversationId: string;
}

export interface ConversationMetadataRecoveryQueryV1
	extends ConversationStateQueryV1 {
	readonly executionId?: string;
}

export interface ConversationMetadataRecoveryResultV1 {
	readonly outcome: "scheduled" | "coalesced" | "not_applicable" | "denied";
}

export interface ConversationMetadataRecoveryStateV1 {
	readonly conversation: ConversationExecutionConversationStateV1 | undefined;
	readonly candidates: readonly {
		readonly execution: {
			readonly executionId: string;
			readonly conversationId: string;
			readonly agentId: string;
			readonly actorId: string;
			readonly channelId: string;
			readonly turnId: string;
			readonly sessionGeneration: number;
			readonly deliveryFence: number;
			readonly runtimeCursor: string | null;
			readonly authorizationRevision: string;
			readonly status: string;
		};
		readonly originalOutboxes: readonly {
			readonly itemId: string;
			readonly operation: string;
			readonly status: string;
			readonly payload: unknown;
		}[];
		readonly boundary: unknown;
		readonly latestToolFacts: readonly ConversationOperationFactV2[];
	}[];
}

export interface ConversationMetadataRecoveryWritePlanV1 {
	readonly result: ConversationMetadataRecoveryResultV1;
	readonly updates: readonly {
		readonly itemId: string;
		readonly metadataRecovery: ConversationMetadataRecoveryV1;
	}[];
}

export interface ConversationModelConfigurationV1 {
	readonly configurationRevision: number;
	readonly options: readonly {
		readonly optionId: string;
		readonly reasoningLevels: readonly string[];
	}[];
	readonly defaultOptionId: string;
	readonly defaultReasoningLevel: string;
}

export interface ConversationExecutionConversationStateV1 {
	readonly isolationPending?: true;
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
	readonly selectedModelOptionId: string | null;
	readonly selectedReasoningLevel: string | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

export interface ConversationModelSelectionFallbackV1 {
	readonly previousModelOptionId: string;
	readonly previousReasoningLevel: string;
	readonly modelConfigurationRevision: number;
	readonly modelOptionId: string;
	readonly reasoningLevel: string;
}

export interface ConversationExecutionStateV1 {
	readonly conversation: ConversationExecutionConversationStateV1 | undefined;
	readonly modelConfiguration: ConversationModelConfigurationV1 | undefined;
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
				readonly sessionGeneration: number;
				readonly modelConfigurationRevision: number | null;
				readonly modelOptionId: string | null;
				readonly reasoningLevel: string | null;
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
				readonly sessionGeneration: number;
				readonly modelConfigurationRevision: number | null;
				readonly modelOptionId: string | null;
				readonly reasoningLevel: string | null;
				readonly lastEventSequence: number;
				readonly stopPending: boolean;
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

export interface ConversationModelSelectionResultV1 {
	readonly schemaVersion: 1;
	readonly conversationId: string;
}

export interface ConversationStateResultV1 {
	readonly schemaVersion: 1;
	readonly conversation: ConversationExecutionConversationStateV1;
	readonly modelSelectionFallback: ConversationModelSelectionFallbackV1 | null;
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

export type ConversationModelSelectionDecisionV1 =
	| {
			readonly outcome: "accepted" | "replayed";
			readonly result: ConversationModelSelectionResultV1;
	  }
	| { readonly outcome: "denied" }
	| { readonly outcome: "conflict"; readonly reason: "idempotency_conflict" };

export type ConversationStateDecisionV1 =
	| { readonly outcome: "found"; readonly result: ConversationStateResultV1 }
	| { readonly outcome: "denied" };

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
		readonly modelConfigurationRevision: number | null;
		readonly modelOptionId: string | null;
		readonly reasoningLevel: string | null;
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
		readonly modelConfigurationRevision: number | null;
		readonly modelOptionId: string | null;
		readonly reasoningLevel: string | null;
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
	readonly modelSelectionFallback: ConversationModelSelectionFallbackWriteV1 | null;
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
		readonly modelConfigurationRevision: number | null;
		readonly modelOptionId: string | null;
		readonly reasoningLevel: string | null;
		readonly createdAt: Date;
	};
	readonly outboxIntent: {
		readonly operation: "conversation.turn.regenerate.v1";
		readonly conversationId: string;
		readonly executionId: string;
		readonly messageId: string;
		readonly turnId: string;
		readonly sessionGeneration: number;
		readonly modelConfigurationRevision: number | null;
		readonly modelOptionId: string | null;
		readonly reasoningLevel: string | null;
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
	readonly modelSelectionFallback: ConversationModelSelectionFallbackWriteV1 | null;
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

export interface ConversationModelSelectionWritePlanV1 {
	readonly schemaVersion: 1;
	readonly conversation: ConversationExecutionConversationStateV1;
	readonly auditEvent: {
		readonly action: "conversation.model_selection.updated";
		readonly actorId: string;
		readonly agentId: string;
		readonly conversationId: string;
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
		readonly modelConfigurationRevision: number;
		readonly modelOptionId: string;
		readonly reasoningLevel: string;
	};
	readonly result: ConversationModelSelectionResultV1;
	readonly idempotency: {
		readonly scopeType: "conversation";
		readonly scopeId: string;
		readonly actorId: string;
		readonly commandType: "model.select";
		readonly key: string;
		readonly requestDigest: string;
	};
}

export interface ConversationModelSelectionFallbackWriteV1
	extends ConversationModelSelectionFallbackV1 {
	readonly timelineEvent: PersistedConversationEventV1 & {
		readonly event: {
			readonly type: "model.selection.fell_back";
			readonly modelOptionId: string;
			readonly reasoningLevel: string;
			readonly reason: "selection_unavailable";
		};
	};
	readonly auditEvent: {
		readonly action: "conversation.model_selection.fell_back";
		readonly executionId: string;
		readonly actorId: string;
		readonly agentId: string;
		readonly conversationId: string;
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
}

export interface ConversationExecutionTransactionPortV1 {
	requestMetadataRecovery(
		request: {
			readonly query: ConversationMetadataRecoveryQueryV1;
			readonly authority: ConversationExecutionAuthorityV1;
		},
		decide: (
			state: ConversationMetadataRecoveryStateV1,
		) => ConversationMetadataRecoveryWritePlanV1,
	): Promise<ConversationMetadataRecoveryResultV1>;
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
	readConversation(
		request: {
			readonly query: ConversationStateQueryV1;
			readonly authority: ConversationExecutionAuthorityV1;
		},
		project: (
			state: ConversationExecutionStateV1,
		) => ConversationStateDecisionV1,
	): Promise<ConversationStateDecisionV1>;
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
	executeModelSelection(
		request: {
			readonly command: ConversationModelSelectionCommandV1;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
		decide: (
			state: ConversationExecutionStateV1,
		) => ConversationModelSelectionWritePlanV1 | { readonly outcome: "denied" },
	): Promise<ConversationModelSelectionDecisionV1>;
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
	requestMetadataRecovery(
		query: ConversationMetadataRecoveryQueryV1,
	): Promise<ConversationMetadataRecoveryResultV1>;
	readConversation(
		query: ConversationStateQueryV1,
	): Promise<ConversationStateDecisionV1>;
	createConversation(
		command: CreateConversationCommandV1,
	): Promise<CreateConversationDecisionV1>;
	accept(
		command: ConversationMessageCommandV1,
	): Promise<ConversationCommandDecisionV1>;
	selectModel(
		command: ConversationModelSelectionCommandV1,
	): Promise<ConversationModelSelectionDecisionV1>;
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
