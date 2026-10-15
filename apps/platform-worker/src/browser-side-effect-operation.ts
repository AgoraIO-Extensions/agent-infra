import type {
	RuntimeBrowserSideEffectConfirmationRequestV3,
	RuntimeBrowserSideEffectConfirmationResponseV3,
} from "@agent-infra/contracts/runtime";
import {
	type ConversationBrowserActionAttemptV1,
	ConversationBrowserActionExecutionError,
	type ConversationEventUseCaseV1,
	executeConversationBrowserActionV1,
} from "@agent-infra/platform-core";

export type BrowserSideEffectRuntimeV1 = Readonly<{
	browserSideEffect(
		request: RuntimeBrowserSideEffectConfirmationRequestV3,
		signal?: AbortSignal,
	): Promise<RuntimeBrowserSideEffectConfirmationResponseV3>;
}>;

export type BrowserSideEffectOperationInputV1 = Readonly<{
	readonly request: RuntimeBrowserSideEffectConfirmationRequestV3;
	readonly attempt: ConversationBrowserActionAttemptV1;
	readonly occurredAt: string;
	readonly adapterEventKeyPrefix: string;
	readonly runtimeCursorPrefix: string;
	readonly now: () => string;
	readonly signal: AbortSignal;
}>;

function sameRequestIdentity(
	request: RuntimeBrowserSideEffectConfirmationRequestV3,
	response: RuntimeBrowserSideEffectConfirmationResponseV3,
): boolean {
	return (
		response.schemaVersion === 3 &&
		response.hostSessionRef === request.hostSessionRef &&
		response.executionId === request.executionId &&
		response.actionId === request.binding.actionId &&
		response.operationRef === request.binding.operationRef &&
		response.attemptRef === request.binding.attemptRef
	);
}

/**
 * Consume one authenticated Runtime V3 Browser confirmation through the
 * existing Conversation operation-event barrier. The Runtime port is the
 * only external consumer; this adapter owns no queue or acknowledgement
 * authority.
 */
export function createBrowserSideEffectOperationAdapterV1(input: {
	readonly events: ConversationEventUseCaseV1;
	readonly runtime: BrowserSideEffectRuntimeV1;
}) {
	return {
		async execute(request: BrowserSideEffectOperationInputV1) {
			const { request: runtimeRequest } = request;
			const binding = runtimeRequest.binding;
			if (
				runtimeRequest.schemaVersion !== 3 ||
				runtimeRequest.operation.kind !== "execution" ||
				runtimeRequest.operation.id !== runtimeRequest.executionId ||
				runtimeRequest.operation.deliveryFence !== binding.resourceFence ||
				runtimeRequest.operation.executionDeliveryFence !==
					binding.resourceFence ||
				binding.agentId !== runtimeRequest.agentId ||
				binding.conversationId !== runtimeRequest.conversationId ||
				binding.executionId !== runtimeRequest.executionId ||
				binding.sessionGeneration !== runtimeRequest.sessionGeneration
			)
				throw new ConversationBrowserActionExecutionError(
					"failed",
					"Browser side-effect binding is invalid",
					"authorization_denied",
				);

			return executeConversationBrowserActionV1(input.events, {
				conversationId: runtimeRequest.conversationId,
				executionId: runtimeRequest.executionId,
				sessionGeneration: runtimeRequest.sessionGeneration,
				deliveryFence: binding.resourceFence,
				occurredAt: request.occurredAt,
				attempt: request.attempt,
				toolId: `browser.side_effect:${runtimeRequest.command}`,
				browser: {
					actionId: binding.actionId,
					capabilityVersion: binding.capabilityVersion,
					pageRevision: binding.pageRevision,
					sessionGeneration: binding.sessionGeneration,
					resourceFence: binding.resourceFence,
					workloadRevision: binding.workloadRevision,
					imageDigest: binding.imageDigest,
					sideEffect: true,
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
							"Browser side-effect was cancelled before Runtime I/O",
							"interrupted",
						);
					const response = await input.runtime.browserSideEffect(
						runtimeRequest,
						signal,
					);
					if (!sameRequestIdentity(runtimeRequest, response))
						throw new ConversationBrowserActionExecutionError(
							"unknown",
							"Browser side-effect response identity is invalid",
							"recovery_unconfirmed",
						);
					if (response.phase === "completed" && response.outcome === "accepted")
						return {};
					if (response.phase === "unknown")
						throw new ConversationBrowserActionExecutionError(
							"unknown",
							"Browser side-effect result is unconfirmed",
							"recovery_unconfirmed",
						);
					throw new ConversationBrowserActionExecutionError(
						"failed",
						"Browser side-effect was rejected",
						"request_rejected",
					);
				},
			});
		},
	};
}
