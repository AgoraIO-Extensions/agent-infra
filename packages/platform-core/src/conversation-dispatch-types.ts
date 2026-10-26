import type { BrowserHandoffCommandV1 } from "./browser-handoff-admission.js";
import type { ConversationReasoningKindV1 } from "./conversation-events.js";
import type { ConversationExecutionSourceV1 } from "./conversation-execution-types.js";
import type { ConversationGenerationIsolationV1 } from "./conversation-generation-isolation.js";
import type { ConversationOperationFactV2 } from "./conversation-operation-facts.js";
import type { NativeTextInputV1 } from "./file-authority.js";
import type { SessionSandboxBindingV1 } from "./session-sandbox.js";

export type ConversationDispatchOperationV1 =
	| "conversation.turn.submit.v1"
	| "conversation.turn.regenerate.v1"
	| "conversation.turn.supplement.v1"
	| "conversation.turn.stop.v1"
	| "conversation.native-capability.invoke.v1"
	| "conversation.browser.handoff.v1";

export type ConversationNativeCapabilityBindingV1 = Readonly<{
	readonly agentId: string;
	readonly actorId: string;
	readonly channelId: string;
	readonly turnId: string;
	readonly capabilityId: string;
	readonly capabilityKind: "command" | "skill";
	readonly directoryRevision: string;
	readonly capabilitySourceVersion: string;
	readonly parameters: string;
	readonly parametersDigest: string;
	/**
	 * Ordered Invocation V2 text inputs accepted with the same Execution. Absent
	 * for Invocation V1; the Worker must deliver exactly this sequence to Native
	 * V5 and must never re-read or extend it.
	 */
	readonly attachments?: readonly NativeTextInputV1[];
}>;

export type ConversationRuntimeDispatchOperationV1 =
	| "turn.submit"
	| "turn.supplement"
	| "turn.stop"
	| "native-capability.invoke";

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

/** #2979：模型以明文提供的思考过程增量，持久化为会话正文 reasoning.delta。 */
export type ConversationRuntimeReasoningEventV2 = Omit<
	ConversationRuntimeEventBaseV1,
	"schemaVersion"
> & {
	readonly schemaVersion: 2;
	readonly type: "reasoning";
	readonly payload: {
		readonly kind: ConversationReasoningKindV1;
		readonly delta: string;
	};
};

export type ConversationRuntimeEvent =
	| ConversationRuntimeEventV1
	| ConversationRuntimeOperationEventV2
	| ConversationRuntimeReasoningEventV2
	| ConversationRuntimeFileEventV2;

/**
 * #3226：结果文件事件 V2 在 V1 字段之外携带规范化工作区路径（回答内 `sandbox:` 引用）；
 * 其他来源为 null。持久化前与结果文件记录核对。
 */
export type ConversationRuntimeFileEventV2 = Omit<
	ConversationRuntimeEventBaseV1,
	"schemaVersion"
> & {
	readonly schemaVersion: 2;
	readonly type: "file";
	readonly payload: {
		readonly fileId: string;
		readonly name: string;
		readonly mimeType: string;
		readonly sizeBytes: number;
		readonly workspaceReference: string | null;
	};
};

export interface ConversationMetadataRecoveryV1 {
	readonly id: string;
	readonly requestedAt: number;
	readonly originalStatus: "succeeded" | "failed";
}

export interface ConversationDispatchClaimV1 {
	/** Production Store always supplies this; legacy in-memory fixtures are not a production authority. */
	readonly sandbox?: SessionSandboxBindingV1;
	/** Durable Execution namespace; absence preserves only historical user claims. */
	readonly principal?: import("./task-authorization.js").TaskPrincipalV1;
	readonly metadataRecovery?: ConversationMetadataRecoveryV1;
	readonly generationIsolation?: ConversationGenerationIsolationV1;
	readonly schemaVersion: 1;
	readonly taskWaitOrder?: number;
	readonly itemId: string;
	readonly leaseOwner: string;
	readonly operation: ConversationDispatchOperationV1;
	readonly requestId: string;
	readonly traceId: string;
	readonly traceParent?: string;
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
	/** Durable outbox attempt number, used to bound metadata recovery. */
	readonly attemptCount?: number;
	/**
	 * #3373：Execution 本次进入 `unknown` 以来经过的毫秒数（Store 按数据库时钟计算），
	 * 只在 Execution 为 `unknown` 时投影，用于墙钟恢复预算。
	 */
	readonly recoveryElapsedMs?: number;
	/**
	 * #3373：本工作项已因 Runtime 报告未提交而重提的次数，以及自首次重提起经过的毫秒数
	 * （Store 按数据库时钟计算）。没有重提时不投影。
	 */
	readonly notSubmittedResubmissions?: {
		readonly count: number;
		readonly elapsedMs: number;
	};
	readonly executionDeliveryFence: number;
	readonly authorizationRevision: string;
	readonly modelConfigurationRevision: number | null;
	readonly modelOptionId: string | null;
	readonly reasoningLevel: string | null;
	readonly executionSource?: ConversationExecutionSourceV1;
	readonly relayKeyBinding?: {
		readonly purpose: "personal" | "agent-default";
		readonly subjectId: string;
		readonly keyId: string;
		readonly keyVersion: number;
	};
	readonly hostSessionRef: string | null;
	/** Store-owned original acceptance receipt, projected only for a pending stop. */
	readonly acceptedOriginalHostSessionRef?: string;
	readonly runtimeCursor: string | null;
	/** Derived by the Store from the original committed Runtime terminal event. */
	readonly runtimeTerminalEventSeen?: true;
	readonly input: {
		readonly text: string;
		readonly attachments: readonly string[];
	} | null;
	readonly nativeCapability?: ConversationNativeCapabilityBindingV1;
	/** Server-admitted Browser command carried by the same outbox lease. */
	readonly browserHandoff?: BrowserHandoffCommandV1;
	readonly executionStatus: ConversationDispatchExecutionStatusV1;
	readonly stopPending: boolean;
	/** Set only when the Store durably marked the stop confirmation timeout. */
	readonly stopConfirmationTimedOut?: true;
}

export type ConversationDispatchClaimDecisionV1 =
	| { readonly outcome: "claimed"; readonly claim: ConversationDispatchClaimV1 }
	| { readonly outcome: "busy" | "stale" | "succeeded" | "failed" };

export interface ConversationDispatchStateTransitionV1 {
	readonly executionStatus?: ConversationDispatchExecutionStatusV1;
	readonly conversationStatus?: "ready" | "active" | "unavailable";
}

export interface ConversationDispatchStorePortV1 {
	/** Read-only Browser binding projection from the current Conversation event
	 * stream while the existing outbox lease is held. */
	readBrowserHandoffBinding?(input: {
		readonly claim: ConversationDispatchClaimV1;
	}): Promise<unknown | null>;
	/** Read-only Browser side-effect confirmation projection under the current
	 * outbox lease; the Worker still owns Runtime grants and dispatch. */
	readBrowserSideEffectBinding?(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly confirmationId: string;
	}): Promise<unknown | null>;
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
	}): Promise<
		| boolean
		| "capacity_wait"
		| "capacity_unavailable"
		| "sandbox_wait"
		/**
		 * 认领之后 stop 才被受理：Store 已把条目释放为可立即重新认领，
		 * 本次认领作废，调用方不再对该条目做任何事。
		 */
		| "stop_changed"
	>;
	/**
	 * Return a just-prepared Turn to its pre-claim status when the Runtime
	 * request was provably never sent, releasing its Agent occupancy.
	 */
	releaseUnsentDispatch?(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly retryDelayMs: number;
		readonly errorCode: string;
		/**
		 * #3373：Runtime 在未提交结果中返回的 Host Session Ref；Conversation 尚未记录时一并保存，
		 * 已记录时必须一致。
		 */
		readonly hostSessionRef?: string;
	}): Promise<boolean>;
	cancelUnaccepted(input: {
		readonly claim: ConversationDispatchClaimV1;
	}): Promise<boolean>;
	/** Atomically cancel a submitted Turn when its stop wins during key delivery. */
	cancelAccepted?(input: {
		readonly claim: ConversationDispatchClaimV1;
	}): Promise<boolean>;
	recordRuntimeResponse(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly hostSessionRef: string;
		/** Canonical response/status proves this original Turn was accepted. */
		readonly originalOperationAccepted?: true;
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
	/**
	 * #3375：补充指令转入排队（工程 Spec §12.5）。在同一 Conversation 锁事务内，把本补充指令及
	 * 同一 Execution 之后仍待投递的补充指令按原顺序转为排队消息；排队已满或期限不足的部分按投递
	 * 失败终结。租约不再属于本次认领时返回 false。未装配时按原规则标记“原回复已结束”。
	 */
	queueSupplement?(input: {
		readonly claim: ConversationDispatchClaimV1;
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

export interface ConversationBrowserHandoffExecutorV1 {
	/** Execute one already claimed handoff. Runtime retries stay outside this port. */
	invoke(input: {
		readonly claim: ConversationDispatchClaimV1;
		readonly authority: ConversationDispatchAuthorityV1;
		readonly signal?: AbortSignal;
	}): Promise<
		| { readonly outcome: "accepted" | "replayed" }
		| { readonly outcome: "unknown" }
		| { readonly outcome: "unavailable" }
	>;
}

export interface ConversationRuntimeDispatchRequestV1 {
	readonly schemaVersion: 1;
	readonly operation: ConversationRuntimeDispatchOperationV1;
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
	readonly nativeCapability?: ConversationNativeCapabilityBindingV1;
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
				| "RUNTIME_MODEL_SELECTION_UNSUPPORTED"
				| "RUNTIME_SESSION_BLOCKED"
				| "RUNTIME_FILE_INPUT_REJECTED";
			readonly message:
				| "Runtime turn is no longer active"
				| "Runtime model selection is unsupported"
				| "Runtime session is blocked by an unconfirmed turn"
				| "Runtime file input was rejected";
			readonly retryable: false;
	  }
	| {
			/** #3373：Host 核实 Driver 在原生提交点之前未提交本次 Turn，可以用新 Grant 重提。 */
			readonly outcome: "rejected";
			readonly code: "RUNTIME_TURN_NOT_SUBMITTED";
			readonly message: "Runtime turn was not submitted";
			readonly reason: ConversationRuntimeTurnNotSubmittedReasonV1;
			readonly retryable: true;
	  }
	| {
			readonly outcome: "unknown";
			readonly code: "RUNTIME_ACCEPTANCE_UNKNOWN";
			readonly message: "Runtime command acceptance could not be confirmed";
	  };

/** #3373：未提交的失败阶段。 */
export type ConversationRuntimeTurnNotSubmittedReasonV1 =
	| "file_input_unavailable"
	| "session_preparation_failed";

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
			/** Durable Host result for a previously unknown operation. */
			readonly operationOutcome?: "busy";
	  }
	| { readonly outcome: "not_found" }
	| {
			readonly outcome: "binding_found";
			readonly hostSessionRef: string;
	  }
	| {
			readonly outcome: "recovery_failed";
			readonly hostSessionRef: string;
			readonly code: "RUNTIME_SESSION_RECOVERY_FAILED";
	  }
);

export interface ConversationRuntimeHostPortV1 {
	/** Runtime V3 Browser side-effect confirmation transport. */
	browserSideEffect?(request: unknown, signal?: AbortSignal): Promise<unknown>;
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
		/**
		 * #3443：Host 在每次读取（含首次）前调用 `beforeRead`，Dispatch 借此提交已缓冲的事件，读取的
		 * 起点与发送前复核的 fenced state 因此都是已提交的游标。回调失败时不发起这次读取，把错误交给
		 * 消费方。
		 */
		hooks?: { readonly beforeRead?: () => Promise<void> },
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
	/** True only when the failure happened before any Runtime request was sent. */
	readonly notSent: boolean;

	constructor(
		code: string,
		retryable: boolean,
		options: { readonly notSent?: boolean } = {},
	) {
		super("RuntimeHost request failed");
		this.name = "ConversationRuntimeHostError";
		this.code = code;
		this.retryable = retryable;
		this.notSent = options.notSent === true;
	}
}
