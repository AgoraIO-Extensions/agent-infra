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
	workloadRevision: number;
	imageDigest: string;
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
		input.controllerBinding.resourceFence !== input.deliveryFence ||
		input.controllerBinding.workloadRevision !== input.workloadRevision ||
		input.controllerBinding.imageDigest !== input.imageDigest ||
		!Number.isSafeInteger(input.workloadRevision) ||
		input.workloadRevision < 1 ||
		!/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/u.test(input.imageDigest)
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
		left.resourceFence === right.resourceFence &&
		left.workloadRevision === right.workloadRevision &&
		left.imageDigest === right.imageDigest
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
		readonly readAction?: (request: {
			readonly actionId: string;
			readonly idempotencyKey?: string;
			readonly executionBinding: BrowserActionExecutionBindingV1;
		}) => BrowserActionOperationControllerRecordV1 | null;
	};
}) {
	return {
		async execute(
			request: BrowserActionOperationInputV1,
		): Promise<BrowserActionOperationResultV1> {
			assertBinding(request);
			let actionRecord: BrowserActionOperationControllerRecordV1 | undefined;
			const persistPendingConfirmation = async () => {
				if (
					!actionRecord?.confirmation ||
					actionRecord.reasonCode !==
						"BROWSER_SIDE_EFFECT_CONFIRMATION_REQUIRED"
				)
					return;
				const confirmation = actionRecord.confirmation;
				const expiresAt = new Date(
					Date.parse(actionRecord.createdAt) + 5 * 60_000,
				).toISOString();
				const decision = await input.events.persist({
					schemaVersion: 1,
					conversationId: request.conversationId,
					executionId: request.executionId,
					sessionGeneration: request.sessionGeneration,
					deliveryFence: request.deliveryFence,
					adapterEventKey: `${request.adapterEventKeyPrefix}:side-effect:pending`,
					runtimeCursor: `${request.runtimeCursorPrefix}:side-effect:pending`,
					occurredAt: request.occurredAt,
					event: {
						type: "browser.side_effect",
						confirmationId: confirmation.confirmationId,
						status: "pending",
						requestedAt: actionRecord.createdAt,
						expiresAt,
						operation: confirmation.preview.name || confirmation.preview.kind,
						targetOrigin: confirmation.origin,
						redactedTargetSummary:
							confirmation.preview.name || confirmation.preview.kind,
						binding: {
							subjectId: confirmation.subjectId,
							agentId: request.agentId,
							conversationId: request.conversationId,
							executionId: request.executionId,
							sessionGeneration: request.sessionGeneration,
							resourceFence: request.deliveryFence,
							workloadRevision: request.controllerBinding.workloadRevision,
							imageDigest: request.controllerBinding.imageDigest,
							capabilityVersion: request.capabilityVersion,
							capabilityRevision: request.capabilityVersion,
							pageRevision: request.page.pageRevision,
							actionId: confirmation.actionId,
							confirmationId: confirmation.confirmationId,
							operationRef: request.attempt.operationRef,
							attemptRef: request.attempt.attemptRef,
						},
					},
				});
				if (decision.outcome === "stale")
					throw new Error("BROWSER_SIDE_EFFECT_EVENT_STALE");
			};
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
					workloadRevision: request.controllerBinding.workloadRevision,
					imageDigest: request.controllerBinding.imageDigest,
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
					await persistPendingConfirmation();
					assertReturnedIdentity(actionRecord, request);
					if (actionRecord.status === "unknown") {
						const recovered = input.controller.readAction?.({
							actionId: request.actionId,
							idempotencyKey: request.idempotencyKey ?? request.actionId,
							executionBinding: request.controllerBinding,
						});
						if (
							recovered &&
							["completed", "failed", "rejected"].includes(recovered.status)
						) {
							assertReturnedIdentity(recovered, request);
							actionRecord = recovered;
						}
					}
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
			await persistPendingConfirmation();
			return { ...result, record: actionRecord };
		},
	};
}
