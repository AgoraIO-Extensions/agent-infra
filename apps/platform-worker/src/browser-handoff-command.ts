import type { BrowserCommandRequestV1 } from "@agent-infra/contracts/pilot";
import type { ConversationRuntimeBrowserHandoffRequestV1 } from "./conversation-runtime.js";
import type { PlatformConversationBrowserHandoffInputV1 } from "./conversation-worker.js";

export type BrowserHandoffCommandInvocationV1 = Readonly<{
	readonly identity: { readonly userId: string };
	readonly conversationId: string;
	readonly command: BrowserCommandRequestV1;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
	readonly traceParent?: string;
	readonly signal: AbortSignal;
}>;

export interface BrowserHandoffCommandResolverV1 {
	/** Resolve the current persisted Execution binding and Runtime V3 request. */
	resolve(
		input: BrowserHandoffCommandInvocationV1,
	): Promise<ConversationRuntimeBrowserHandoffRequestV1 | null>;
}

export interface BrowserHandoffCommandWorkerV1 {
	browserHandoff(input: PlatformConversationBrowserHandoffInputV1): Promise<{
		readonly outcome: "accepted" | "replayed";
		readonly event?: unknown;
	}>;
}

export function createBrowserHandoffCommandExecutorV1(input: {
	readonly resolver: BrowserHandoffCommandResolverV1;
	readonly worker: BrowserHandoffCommandWorkerV1;
	readonly now?: () => string;
}) {
	const now = input.now ?? (() => new Date().toISOString());
	return {
		async invoke(request: BrowserHandoffCommandInvocationV1) {
			const resolved = await input.resolver.resolve(request);
			if (!resolved || resolved.conversationId !== request.conversationId)
				return {
					outcome: "unavailable" as const,
					conversationId: request.conversationId,
				};
			try {
				const result = await input.worker.browserHandoff({
					request: resolved,
					occurredAt: now(),
					adapterEventKeyPrefix: `browser-command:${request.idempotencyKey}`,
					runtimeCursorPrefix: `browser-command:${request.idempotencyKey}`,
					signal: request.signal,
				});
				return {
					outcome: result.outcome,
					conversationId: request.conversationId,
					executionId: resolved.executionId,
					...("handoffId" in request.command
						? { handoffId: request.command.handoffId }
						: { confirmationId: request.command.confirmationId }),
				};
			} catch {
				return {
					outcome: "unknown" as const,
					conversationId: request.conversationId,
					executionId: resolved.executionId,
				};
			}
		},
	};
}
