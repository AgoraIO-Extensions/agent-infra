import type {
	BrowserActionExecutionBindingV1,
	BrowserActionRecordV1,
	BrowserActionRequestV1,
} from "@agent-infra/agent-runtime";
import {
	type ConversationBrowserActionAttemptV1,
	ConversationBrowserActionExecutionError,
	type ConversationEventUseCaseV1,
	type ConversationOperationFailureV2,
	executeConversationBrowserActionV1,
} from "@agent-infra/platform-core";

export type BrowserActionOperationControllerRequestV1 =
	BrowserActionRequestV1 & {
		readonly actionId: string;
		readonly operationRef: string;
		readonly attemptRef: string;
		readonly executionBinding: BrowserActionExecutionBindingV1;
	};

export type BrowserActionOperationControllerRecordV1 = BrowserActionRecordV1;

export type BrowserActionOperationInputV1 = Readonly<{
	conversationId: string;
	executionId: string;
	sessionGeneration: number;
	deliveryFence: number;
	controllerBinding: BrowserActionExecutionBindingV1;
	agentId: string;
	capabilityVersion: number;
	page: Readonly<{ pageId: string; pageRevision: number }>;
	actionId: string;
	attempt: ConversationBrowserActionAttemptV1;
	toolId: string;
	action: Omit<
		BrowserActionOperationControllerRequestV1,
		| "actionId"
		| "operationRef"
		| "attemptRef"
		| "executionBinding"
		| "idempotencyKey"
	>;
	idempotencyKey?: string;
	occurredAt: string;
	adapterEventKeyPrefix: string;
	runtimeCursorPrefix: string;
	now: () => string;
	signal: AbortSignal;
}>;

export type BrowserActionOperationResultV1 = Readonly<{
	resultRef?: string;
	record?: BrowserActionOperationControllerRecordV1;
}>;

function assertBinding(input: BrowserActionOperationInputV1): void {
	if (
		!Number.isSafeInteger(input.sessionGeneration) ||
		input.sessionGeneration < 1 ||
		!Number.isSafeInteger(input.deliveryFence) ||
		input.deliveryFence < 1 ||
		input.controllerBinding.agentId !== input.agentId ||
		input.controllerBinding.conversationId !== input.conversationId ||
		input.controllerBinding.executionId !== input.executionId ||
		input.controllerBinding.capabilityVersion !== input.capabilityVersion ||
		input.controllerBinding.pageRevision !== input.page.pageRevision ||
		input.controllerBinding.sessionGeneration !== input.sessionGeneration ||
		input.controllerBinding.resourceFence !== input.deliveryFence
	) {
		throw new Error("BROWSER_ACTION_CONTROLLER_BINDING_MISMATCH");
	}
}

function failureCode(
	status: BrowserActionOperationControllerRecordV1["status"],
): ConversationOperationFailureV2 {
	return status === "rejected" ? "request_rejected" : "operation_failed";
}

function sameBinding(
	left: BrowserActionExecutionBindingV1,
	right: BrowserActionExecutionBindingV1,
): boolean {
	return (
		left.agentId === right.agentId &&
		left.conversationId === right.conversationId &&
		left.executionId === right.executionId &&
		left.capabilityVersion === right.capabilityVersion &&
		left.pageRevision === right.pageRevision &&
		left.sessionGeneration === right.sessionGeneration &&
		left.resourceFence === right.resourceFence
	);
}

function assertReturnedIdentity(
	record: BrowserActionOperationControllerRecordV1,
	request: BrowserActionOperationInputV1,
): void {
	if (
		record.actionId !== request.actionId ||
		record.operationRef !== request.attempt.operationRef ||
		record.attemptRef !== request.attempt.attemptRef ||
		record.executionBinding === undefined ||
		!sameBinding(record.executionBinding, request.controllerBinding)
	)
		throw new ConversationBrowserActionExecutionError(
			"unknown",
			"Browser controller returned a different action identity",
			"recovery_unconfirmed",
		);
}

/**
 * Worker consumer seam: durable operation events gate one Browser controller
 * call. The controller and Conversation Event Core remain injected authorities.
 */
export function createBrowserActionOperationAdapterV1(input: {
	readonly events: ConversationEventUseCaseV1;
	readonly controller: {
		executeAction(
			request: BrowserActionOperationControllerRequestV1,
		): Promise<BrowserActionOperationControllerRecordV1>;
	};
}) {
	return {
		async execute(
			request: BrowserActionOperationInputV1,
		): Promise<BrowserActionOperationResultV1> {
			assertBinding(request);
			let actionRecord: BrowserActionOperationControllerRecordV1 | undefined;
			const result = await executeConversationBrowserActionV1(input.events, {
				conversationId: request.conversationId,
				executionId: request.executionId,
				sessionGeneration: request.sessionGeneration,
				deliveryFence: request.deliveryFence,
				occurredAt: request.occurredAt,
				attempt: request.attempt,
				toolId: request.toolId,
				browser: {
					actionId: request.actionId,
					capabilityVersion: request.capabilityVersion,
					pageRevision: request.page.pageRevision,
					sessionGeneration: request.sessionGeneration,
					resourceFence: request.deliveryFence,
					sideEffect: request.action.sideEffect === true,
				},
				adapterEventKeyPrefix: request.adapterEventKeyPrefix,
				runtimeCursorPrefix: request.runtimeCursorPrefix,
				now: request.now,
				signal: request.signal,
				run: async (markStarted, signal) => {
					await markStarted();
					if (signal.aborted)
						throw new ConversationBrowserActionExecutionError(
							"unknown",
							"Browser action was cancelled before controller I/O",
							"interrupted",
						);
					actionRecord = await input.controller.executeAction({
						...request.action,
						actionId: request.actionId,
						operationRef: request.attempt.operationRef,
						attemptRef: request.attempt.attemptRef,
						idempotencyKey: request.idempotencyKey ?? request.actionId,
						executionBinding: request.controllerBinding,
						sideEffect: request.action.sideEffect === true,
					});
					assertReturnedIdentity(actionRecord, request);
					if (actionRecord.status === "completed") return {};
					if (actionRecord.status === "unknown")
						throw new ConversationBrowserActionExecutionError(
							"unknown",
							actionRecord.reasonCode ?? "Browser action outcome is unknown",
							"recovery_unconfirmed",
						);
					throw new ConversationBrowserActionExecutionError(
						"failed",
						actionRecord.reasonCode ?? "Browser action was rejected",
						failureCode(actionRecord.status),
					);
				},
			});
			return { ...result, record: actionRecord };
		},
	};
}
