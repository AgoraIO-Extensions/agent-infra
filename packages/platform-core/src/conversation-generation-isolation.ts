import type { ConversationDispatchClaimV1 } from "./conversation-dispatch.js";
import type { TaskPrincipalV1 } from "./task-authorization.js";

export interface ConversationGenerationIsolationV1 {
	readonly operationId: string;
	readonly controlRecordId: string;
	readonly originalPrincipal: TaskPrincipalV1;
}

/** A confirmed recovery failure authorizes isolation of only the original task generation. */
export function planConversationGenerationIsolationV1(input: {
	readonly claim: ConversationDispatchClaimV1;
	readonly originalPrincipal: TaskPrincipalV1;
	readonly controlSourceId: string;
	readonly failureCode: "RUNTIME_SESSION_RECOVERY_FAILED";
}) {
	const { claim, originalPrincipal } = input;
	if (
		input.failureCode !== "RUNTIME_SESSION_RECOVERY_FAILED" ||
		!input.controlSourceId ||
		originalPrincipal.kind !== "user" ||
		originalPrincipal.id !== claim.actorId ||
		![
			"conversation.turn.submit.v1",
			"conversation.turn.regenerate.v1",
		].includes(claim.operation) ||
		!["processing", "unknown"].includes(claim.executionStatus) ||
		!claim.hostSessionRef ||
		!Number.isSafeInteger(claim.sessionGeneration) ||
		claim.sessionGeneration < 1 ||
		claim.sessionGeneration >= Number.MAX_SAFE_INTEGER
	)
		throw new TypeError("Generation isolation provenance is invalid");
	return {
		operationId: `generation:${claim.conversationId}:${claim.sessionGeneration}`,
		originalPrincipal: { ...originalPrincipal },
		controlSourceId: input.controlSourceId,
		reason: "generation_isolation" as const,
		failureCode: input.failureCode,
		auditAction: "conversation.generation.isolation.started" as const,
	};
}

/** The Host's accepted control receipt denotes a completed cancellation barrier. */
export function isConversationGenerationBarrierConfirmedV1(input: {
	readonly operationId: string;
	readonly hostSessionRef: string;
	readonly response: {
		readonly operationId: string;
		readonly hostSessionRef: string;
		readonly result: { readonly outcome: string; readonly status?: string };
	};
}) {
	return (
		input.response.operationId === input.operationId &&
		input.response.hostSessionRef === input.hostSessionRef &&
		input.response.result.outcome === "accepted" &&
		["completed", "failed", "cancelled"].includes(
			input.response.result.status ?? "",
		)
	);
}

/** Confirmation applies to the old generation only; persisted native terminal outcomes survive. */
export function planConversationGenerationConfirmationV1(
	claim: ConversationDispatchClaimV1,
) {
	if (
		!claim.generationIsolation ||
		!claim.hostSessionRef ||
		claim.generationIsolation.operationId !==
			`generation:${claim.conversationId}:${claim.sessionGeneration}` ||
		claim.generationIsolation.originalPrincipal.kind !== "user" ||
		claim.generationIsolation.originalPrincipal.id !== claim.actorId ||
		!Number.isSafeInteger(claim.sessionGeneration) ||
		claim.sessionGeneration < 1 ||
		claim.sessionGeneration >= Number.MAX_SAFE_INTEGER
	)
		throw new TypeError("Generation confirmation binding is invalid");
	return {
		nextGeneration: claim.sessionGeneration + 1,
		conversationStatus: "unavailable" as const,
		executionStatusesToFail: ["submitted", "processing", "unknown"],
		businessOperations: [
			"conversation.turn.submit.v1",
			"conversation.turn.regenerate.v1",
			"conversation.turn.supplement.v1",
			"conversation.turn.stop.v1",
		],
		originalOutboxStatus: ["completed", "failed", "cancelled"].includes(
			claim.executionStatus,
		)
			? ("succeeded" as const)
			: ("failed" as const),
		failureCode: "RUNTIME_SESSION_RECOVERY_FAILED",
		executionAuditAction: "conversation.generation.execution.failed",
		confirmationAuditAction: "conversation.generation.isolation.confirmed",
	};
}
