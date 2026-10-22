import { isTurnOperation } from "./conversation-dispatch-runtime.js";
import {
	type ConversationDispatchClaimV1,
	type ConversationDispatchDecisionV1,
	type ConversationDispatchExecutionStatusV1,
	type ConversationDispatchOperationV1,
	type ConversationDispatchStateTransitionV1,
	type ConversationDispatchStorePortV1,
	type ConversationRuntimeEvent,
	ConversationRuntimeHostError,
	type ConversationRuntimeOperationResultV1,
	type ConversationRuntimeStatusV1,
} from "./conversation-dispatch-types.js";
import type {
	ConversationEventStateTransitionV1,
	ConversationNormalizedEventV1,
} from "./conversation-events.js";
import { parseConversationOperationFactV2 } from "./conversation-operation-facts.js";

export function normalizedEvent(
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
	if (event.type === "reasoning")
		return {
			type: "reasoning.delta",
			kind: event.payload.kind,
			text: event.payload.delta,
		};
	if (event.type === "file") {
		return {
			type: "result.file",
			fileId: event.payload.fileId,
			name: event.payload.name,
			mediaType: event.payload.mimeType,
			sizeBytes: event.payload.sizeBytes,
			// #3226：V2 文件事件保留工作区引用（可为 null），持久事件据此按 V2 投影。
			...(event.schemaVersion === 2
				? { workspaceReference: event.payload.workspaceReference }
				: {}),
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

export function acceptedTransition(status: ConversationRuntimeStatusV1) {
	if (status === "running") return transitionForStatus("processing");
	if (status === "unknown") return transitionForStatus("unknown");
	if (status === "completed" || status === "failed" || status === "cancelled") {
		return transitionForStatus(status);
	}
	return undefined;
}

export function transitionFromEvent(
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

export function terminalStatus(event: ConversationNormalizedEventV1) {
	return event.type === "execution.status" &&
		(event.status === "completed" ||
			event.status === "failed" ||
			event.status === "cancelled")
		? event.status
		: undefined;
}

export function executionTerminal(
	status: ConversationDispatchExecutionStatusV1,
) {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

export function decideConversationStopConfirmationTimeoutV1(input: {
	readonly executionStatus: ConversationDispatchExecutionStatusV1;
	readonly confirmationDeadline: number;
	readonly observedAt: number;
	readonly alreadyTimedOut: boolean;
}) {
	if (
		(input.executionStatus !== "processing" &&
			input.executionStatus !== "unknown") ||
		input.alreadyTimedOut ||
		input.observedAt < input.confirmationDeadline
	)
		return undefined;
	return {
		status: "unknown" as const,
		reason: "STOP_CONFIRMATION_TIMEOUT" as const,
	};
}

export function decideConversationStopConfirmationStatusV1(input: {
	readonly executionStatus: ConversationDispatchExecutionStatusV1;
	readonly confirmationTimedOut: boolean;
}): ConversationDispatchExecutionStatusV1 {
	return input.executionStatus === "processing" && input.confirmationTimedOut
		? "unknown"
		: input.executionStatus;
}

/** Decide against the latest state under the same lock as retry/outbox commit. */
export function decideConversationDispatchRetryTransitionV1(input: {
	readonly operation: ConversationDispatchOperationV1;
	readonly executionStatus: ConversationDispatchExecutionStatusV1;
	readonly transition: ConversationDispatchStateTransitionV1;
}): ConversationDispatchStateTransitionV1 {
	return (isTurnOperation(input.operation) ||
		input.operation === "conversation.native-capability.invoke.v1") &&
		executionTerminal(input.executionStatus) &&
		input.transition.executionStatus === "unknown"
		? {}
		: input.transition;
}

export function retryTransition(claim: ConversationDispatchClaimV1) {
	const eventOperation =
		isTurnOperation(claim.operation) ||
		claim.operation === "conversation.native-capability.invoke.v1";
	return decideConversationDispatchRetryTransitionV1({
		operation: claim.operation,
		executionStatus: claim.executionStatus,
		transition: eventOperation ? transitionForStatus("unknown") : {},
	});
}

export function rejectedTransition(
	claim: Pick<ConversationDispatchClaimV1, "operation">,
) {
	return claim.operation === "conversation.turn.submit.v1" ||
		claim.operation === "conversation.turn.regenerate.v1" ||
		claim.operation === "conversation.native-capability.invoke.v1"
		? transitionForStatus("failed")
		: {};
}

type ConversationRuntimeRejectedCodeV1 = Extract<
	ConversationRuntimeOperationResultV1,
	{ readonly outcome: "rejected" }
>["code"];

/**
 * Runtime 已持久 rejected 结果对应的状态迁移。
 *
 * `RUNTIME_SESSION_BLOCKED`（ADR-0029）表示原生会话被受理不明的 Turn 阻塞：本次 Execution
 * 收敛为 failed，同一 Dispatch 事务把 Conversation 标记为会话不可用。它不是 Session 恢复失败的
 * 证明，因此不提升 sessionGeneration、不创建 generation tombstone。只有产生 Execution 的
 * submit/regenerate/native-capability.invoke 会改变 Conversation；supplement/stop 等控制操作
 * 沿用普通 rejected 迁移，不改变会话状态。
 */
export function decideConversationDispatchRejectedTransitionV1(input: {
	readonly operation: ConversationDispatchOperationV1;
	readonly code: ConversationRuntimeRejectedCodeV1;
}): ConversationDispatchStateTransitionV1 {
	const transition = rejectedTransition(input);
	if (
		input.code !== "RUNTIME_SESSION_BLOCKED" ||
		transition.executionStatus !== "failed"
	)
		return transition;
	return { executionStatus: "failed", conversationStatus: "unavailable" };
}

export function runtimeFailure(error: unknown) {
	return error instanceof ConversationRuntimeHostError
		? error
		: new ConversationRuntimeHostError("RUNTIME_UNAVAILABLE", true);
}

export function heartbeat(
	store: ConversationDispatchStorePortV1,
	claim: ConversationDispatchClaimV1,
	leaseDurationMs: number,
	renewAuthorization?: (signal: AbortSignal) => Promise<void>,
): { signal: AbortSignal; stop(): Promise<boolean> } {
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

export async function retry(
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

export async function reject(
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
