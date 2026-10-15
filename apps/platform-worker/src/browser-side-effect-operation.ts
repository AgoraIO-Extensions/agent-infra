import type { BrowserCommandRequestV1 } from "@agent-infra/contracts/pilot";
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
import type { ConversationRuntimeBrowserSideEffectRequestV1 } from "./conversation-runtime.js";

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

export type BrowserSideEffectCommandInvocationV1 = Readonly<{
	readonly identity: { readonly userId: string };
	readonly conversationId: string;
	readonly command: Extract<
		BrowserCommandRequestV1,
		{
			readonly command:
				| "confirm_side_effect"
				| "reject_side_effect"
				| "cancel_side_effect";
		}
	>;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
	readonly agentId?: string;
	readonly channelId?: string;
	readonly executionId?: string;
	readonly turnId?: string;
	readonly sessionGeneration?: number;
	readonly deliveryFence?: number;
	readonly hostSessionRef?: string | null;
	readonly runtimeGrant?: import("@agent-infra/platform-core").ConversationDispatchAuthorityV1["runtimeGrant"];
	readonly signal: AbortSignal;
}>;

export interface BrowserSideEffectCommandResolverV1 {
	resolve(
		input: BrowserSideEffectCommandInvocationV1,
	): Promise<ConversationRuntimeBrowserSideEffectRequestV1 | null>;
}

function sameCommand(
	command: BrowserSideEffectCommandInvocationV1["command"],
	request: ConversationRuntimeBrowserSideEffectRequestV1,
) {
	return (
		(command.command === "confirm_side_effect" &&
			request.command === "confirm") ||
		(command.command === "reject_side_effect" &&
			request.command === "reject") ||
		(command.command === "cancel_side_effect" && request.command === "cancel")
	);
}

export function createBrowserSideEffectCommandExecutorV1(input: {
	readonly resolver: BrowserSideEffectCommandResolverV1;
	readonly operation: ReturnType<
		typeof createBrowserSideEffectOperationAdapterV1
	>;
	readonly now?: () => string;
}) {
	const now = input.now ?? (() => new Date().toISOString());
	return {
		async invoke(command: BrowserSideEffectCommandInvocationV1) {
			const resolved = await input.resolver.resolve(command);
			if (
				!resolved ||
				!sameCommand(command.command, resolved) ||
				resolved.actorId !== command.identity.userId ||
				resolved.conversationId !== command.conversationId ||
				(command.agentId !== undefined &&
					resolved.agentId !== command.agentId) ||
				(command.channelId !== undefined &&
					resolved.channelId !== command.channelId) ||
				(command.executionId !== undefined &&
					resolved.executionId !== command.executionId) ||
				(command.turnId !== undefined && resolved.turnId !== command.turnId) ||
				(command.sessionGeneration !== undefined &&
					resolved.sessionGeneration !== command.sessionGeneration) ||
				(command.deliveryFence !== undefined &&
					resolved.binding.resourceFence !== command.deliveryFence) ||
				(command.hostSessionRef !== undefined &&
					resolved.hostSessionRef !== command.hostSessionRef) ||
				resolved.binding.confirmationId !== command.command.confirmationId ||
				!command.agentId ||
				!command.channelId ||
				!command.executionId ||
				!command.turnId ||
				command.sessionGeneration === undefined ||
				command.deliveryFence === undefined ||
				!command.hostSessionRef ||
				command.runtimeGrant === undefined
			)
				return {
					outcome: "unavailable" as const,
					conversationId: command.conversationId,
				};
			const request = {
				schemaVersion: 3 as const,
				requestId: command.requestId,
				traceId: command.traceId,
				principal: { kind: "user" as const, id: command.identity.userId },
				channelId: command.channelId,
				agentId: command.agentId,
				conversationId: command.conversationId,
				executionId: command.executionId,
				turnId: command.turnId,
				sessionGeneration: command.sessionGeneration,
				hostSessionRef: command.hostSessionRef,
				operation: {
					kind: "execution" as const,
					id: command.executionId,
					deliveryFence: command.deliveryFence,
					executionDeliveryFence: command.deliveryFence,
				},
				grant:
					command.runtimeGrant as RuntimeBrowserSideEffectConfirmationRequestV3["grant"],
				command: resolved.command,
				binding: resolved.binding,
			} satisfies RuntimeBrowserSideEffectConfirmationRequestV3;
			try {
				const result = await input.operation.execute({
					request,
					attempt: {
						operationRef: request.binding.operationRef,
						attemptRef: request.binding.attemptRef,
					},
					occurredAt: now(),
					adapterEventKeyPrefix: `browser-command:${command.idempotencyKey}`,
					runtimeCursorPrefix: `browser-command:${command.idempotencyKey}`,
					now,
					signal: command.signal,
				});
				return {
					outcome: result.outcome,
					conversationId: command.conversationId,
					executionId: request.executionId,
					confirmationId: command.command.confirmationId,
				};
			} catch {
				return {
					outcome: "unknown" as const,
					conversationId: command.conversationId,
					executionId: request.executionId,
					confirmationId: command.command.confirmationId,
				};
			}
		},
	};
}

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

			let intentOutcome: "accepted" | "replayed" | undefined;
			const observedEvents: ConversationEventUseCaseV1 = {
				persist: async (command) => {
					const decision = await input.events.persist(command);
					if (
						command.event.type === "execution.operation" &&
						command.event.fact.phase === "intent"
					)
						intentOutcome =
							decision.outcome === "replayed" ? "replayed" : "accepted";
					return decision;
				},
			};
			const result = await executeConversationBrowserActionV1(observedEvents, {
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
			return {
				...result,
				outcome: intentOutcome === "replayed" ? "replayed" : "accepted",
			};
		},
	};
}
