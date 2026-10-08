import {
	type ConversationBrowserActionAttemptV1,
	type ConversationEventDecisionV1,
	type ConversationEventUseCaseV1,
	persistConversationBrowserActionV1,
} from "@agent-infra/platform-core";
import {
	type BrowserRecoveryBindingV1,
	type BrowserRecoveryResultV1,
	createBrowserRecoveryConsumerV1,
} from "./browser-recovery-consumer.js";

export type BrowserRecoveryEventInputV1 = Readonly<{
	actionId: string;
	idempotencyKey?: string;
	binding: BrowserRecoveryBindingV1;
	attempt: ConversationBrowserActionAttemptV1;
	toolId: string;
	occurredAt: string;
	adapterEventKeyPrefix: string;
	runtimeCursorPrefix: string;
	now: () => string;
}>;

function phaseForRecovery(
	result: BrowserRecoveryResultV1,
): "completed" | "failed" | "unknown" {
	if (result.status === "completed") return "completed";
	if (result.status === "failed" || result.status === "rejected")
		return "failed";
	return "unknown";
}

function failureForRecovery(
	result: BrowserRecoveryResultV1,
):
	| "request_rejected"
	| "operation_failed"
	| "recovery_unconfirmed"
	| undefined {
	if (result.status === "rejected") return "request_rejected";
	if (result.status === "failed") return "operation_failed";
	if (result.status === "unknown" || result.status === "missing")
		return "recovery_unconfirmed";
	return undefined;
}

export function createBrowserRecoveryEventAdapterV1(input: {
	readonly controller: Parameters<
		typeof createBrowserRecoveryConsumerV1
	>[0]["controller"];
	readonly events: ConversationEventUseCaseV1;
}) {
	const recovery = createBrowserRecoveryConsumerV1({
		controller: input.controller,
	});
	return {
		async reconcile(request: BrowserRecoveryEventInputV1) {
			const result = recovery.read({
				actionId: request.actionId,
				idempotencyKey: request.idempotencyKey,
				binding: request.binding,
			});
			const record = result.status === "missing" ? undefined : result.record;
			let recoveredAttempt = request.attempt;
			if (record) {
				if (!record.operationRef || !record.attemptRef)
					throw new Error("BROWSER_ACTION_RECOVERY_OPERATION_MISSING");
				recoveredAttempt = {
					operationRef: record.operationRef,
					attemptRef: record.attemptRef,
				};
			}
			const phase = phaseForRecovery(result);
			const decision: ConversationEventDecisionV1 =
				await persistConversationBrowserActionV1(input.events, {
					conversationId: request.binding.conversationId,
					executionId: request.binding.executionId,
					sessionGeneration: request.binding.sessionGeneration,
					deliveryFence: request.binding.resourceFence,
					runtimeCursor: `${request.runtimeCursorPrefix}:${phase}`,
					occurredAt: request.occurredAt,
					adapterEventKey: `${request.adapterEventKeyPrefix}:${phase}`,
					attempt: recoveredAttempt,
					phase,
					toolId: request.toolId,
					browser: {
						actionId: request.actionId,
						capabilityVersion: request.binding.capabilityVersion,
						pageRevision: request.binding.pageRevision,
						sessionGeneration: request.binding.sessionGeneration,
						resourceFence: request.binding.resourceFence,
						sideEffect: record?.sideEffect === true,
					},
					...(failureForRecovery(result)
						? {
								finishedAt: request.now(),
								failureCode: failureForRecovery(result),
							}
						: { finishedAt: request.now() }),
				});
			if (decision.outcome === "stale")
				throw new Error("BROWSER_RECOVERY_EVENT_PERSISTENCE_STALE");
			return { status: phase, record, decision };
		},
	};
}
