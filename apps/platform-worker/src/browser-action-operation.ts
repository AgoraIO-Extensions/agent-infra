import {
	type ConversationBrowserActionAttemptV1,
	ConversationBrowserActionExecutionError,
	type ConversationEventUseCaseV1,
	type ConversationOperationFailureV2,
	executeConversationBrowserActionV1,
} from "@agent-infra/platform-core";

export type BrowserActionOperationControllerRequestV1 = Readonly<{
	actionId?: string;
	operationRef?: string;
	attemptRef?: string;
	kind: string;
	page: Readonly<{ pageId: string; pageRevision: number }>;
	target?: Readonly<{
		elementId: string;
		pageId?: string;
		pageRevision?: number;
		role?: string;
		name?: string;
	}>;
	targetPage?: Readonly<{ pageId: string; pageRevision: number }>;
	value?: string;
	key?: string;
	durationMs?: number;
	sideEffect?: boolean;
}>;

export type BrowserActionOperationControllerRecordV1 = Readonly<{
	actionId: string;
	status:
		| "accepted"
		| "processing"
		| "completed"
		| "failed"
		| "rejected"
		| "unknown";
	page: Readonly<{ pageId: string; pageRevision: number }>;
	sideEffect: boolean;
	reasonCode?: string;
}>;

export type BrowserActionOperationInputV1 = Readonly<{
	conversationId: string;
	executionId: string;
	sessionGeneration: number;
	deliveryFence: number;
	controllerBinding: Readonly<{
		sessionGeneration: number;
		resourceFence: number;
	}>;
	capabilityVersion: number;
	page: Readonly<{ pageId: string; pageRevision: number }>;
	actionId: string;
	attempt: ConversationBrowserActionAttemptV1;
	toolId: string;
	action: Omit<
		BrowserActionOperationControllerRequestV1,
		"actionId" | "operationRef" | "attemptRef"
	>;
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

function assertBinding(input: {
	readonly sessionGeneration: number;
	readonly deliveryFence: number;
	readonly controllerBinding: Readonly<{
		sessionGeneration: number;
		resourceFence: number;
	}>;
}): void {
	if (
		!Number.isSafeInteger(input.sessionGeneration) ||
		input.sessionGeneration < 1 ||
		!Number.isSafeInteger(input.deliveryFence) ||
		input.deliveryFence < 1 ||
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
					} as BrowserActionOperationControllerRequestV1);
					if (actionRecord.actionId !== request.actionId)
						throw new ConversationBrowserActionExecutionError(
							"unknown",
							"Browser controller returned a different action identity",
							"recovery_unconfirmed",
						);
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
