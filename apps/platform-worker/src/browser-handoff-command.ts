import type { BrowserCommandRequestV1 } from "@agent-infra/contracts/pilot";
import {
	type RuntimeBrowserHandoffRuntimeSnapshotV1,
	RuntimeBrowserHandoffRuntimeSnapshotV1Schema,
} from "@agent-infra/contracts/runtime";
import type {
	ConversationDispatchAuthorityV1,
	ConversationDispatchClaimV1,
} from "@agent-infra/platform-core";
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
	/** Trusted Worker-only binding facts for a request-local resolver. */
	readonly agentId?: string;
	readonly channelId?: string;
	readonly executionId?: string;
	readonly turnId?: string;
	readonly sessionGeneration?: number;
	readonly deliveryFence?: number;
	readonly hostSessionRef?: string | null;
	readonly runtimeGrant?: ConversationDispatchAuthorityV1["runtimeGrant"];
	readonly claim?: ConversationDispatchClaimV1;
	readonly signal: AbortSignal;
}>;

export type BrowserHandoffOperationCommandV1 = Readonly<{
	readonly schemaVersion: 1;
	readonly command: "pause" | "take_over" | "return_to_agent" | "revoke";
	readonly handoffId: string;
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

export function browserHandoffFromRuntimeSnapshotV1(input: {
	readonly command: BrowserHandoffOperationCommandV1;
	readonly operatorId: string;
	readonly snapshot: unknown;
}): ConversationRuntimeBrowserHandoffRequestV1["handoff"] | null {
	const parsed = RuntimeBrowserHandoffRuntimeSnapshotV1Schema.safeParse(
		input.snapshot,
	);
	if (!parsed.success) return null;
	const runtime: RuntimeBrowserHandoffRuntimeSnapshotV1 = parsed.data;
	if (!runtime.browserAlive || !runtime.authorized) return null;
	if (input.command.command === "pause")
		return { kind: "request", reason: "human_judgment", runtime };
	if (input.command.command === "take_over")
		return {
			kind: "take-over",
			handoffId: input.command.handoffId,
			subjectId: input.operatorId,
			operatorId: input.operatorId,
			runtime,
		};
	if (input.command.command === "return_to_agent")
		return {
			kind: "return-to-agent",
			handoffId: input.command.handoffId,
			operatorId: input.operatorId,
			runtime,
		};
	return { kind: "revoke", runtime };
}

function bindingMatchesInvocation(
	request: ConversationRuntimeBrowserHandoffRequestV1,
	invocation: BrowserHandoffCommandInvocationV1,
) {
	const runtime = request.handoff?.runtime;
	if (!runtime) return false;
	return (
		runtime.browserAlive &&
		runtime.authorized &&
		request.requestId === invocation.requestId &&
		request.traceId === invocation.traceId &&
		request.conversationId === invocation.conversationId &&
		(invocation.agentId === undefined ||
			request.agentId === invocation.agentId) &&
		(invocation.channelId === undefined ||
			request.channelId === invocation.channelId) &&
		(invocation.executionId === undefined ||
			request.executionId === invocation.executionId) &&
		(invocation.turnId === undefined || request.turnId === invocation.turnId) &&
		(invocation.sessionGeneration === undefined ||
			request.sessionGeneration === invocation.sessionGeneration) &&
		(invocation.deliveryFence === undefined ||
			request.deliveryFence === invocation.deliveryFence) &&
		(invocation.hostSessionRef === undefined ||
			request.hostSessionRef === invocation.hostSessionRef) &&
		runtime.subjectId === request.actorId &&
		runtime.agentId === request.agentId &&
		runtime.conversationId === request.conversationId &&
		runtime.executionId === request.executionId &&
		runtime.sessionGeneration === request.sessionGeneration &&
		runtime.resourceFence === request.deliveryFence &&
		((request.handoff.kind === "take-over" &&
			request.handoff.operatorId === request.actorId &&
			request.handoff.subjectId === request.actorId) ||
			(request.handoff.kind === "return-to-agent" &&
				request.handoff.operatorId === request.actorId) ||
			(request.handoff.kind !== "take-over" &&
				request.handoff.kind !== "return-to-agent"))
	);
}

export function createBrowserHandoffCommandExecutorV1(input: {
	readonly resolver: BrowserHandoffCommandResolverV1;
	readonly worker: BrowserHandoffCommandWorkerV1;
	readonly now?: () => string;
}) {
	const now = input.now ?? (() => new Date().toISOString());
	return {
		async invoke(request: BrowserHandoffCommandInvocationV1) {
			if (
				request.command.command === "confirm_side_effect" ||
				request.command.command === "reject_side_effect" ||
				request.command.command === "cancel_side_effect"
			)
				return {
					outcome: "unavailable" as const,
					conversationId: request.conversationId,
				};
			const resolved = await input.resolver.resolve(request);
			let bindingMatches = false;
			try {
				bindingMatches =
					resolved !== null &&
					bindingMatchesInvocation(resolved, request) &&
					resolved.handoff.kind ===
						(request.command.command === "pause"
							? "request"
							: request.command.command === "take_over"
								? "take-over"
								: request.command.command === "return_to_agent"
									? "return-to-agent"
									: "revoke") &&
					(request.command.command === "pause" ||
						request.command.command === "revoke" ||
						("handoffId" in resolved.handoff &&
							"handoffId" in request.command &&
							resolved.handoff.handoffId === request.command.handoffId));
			} catch {
				bindingMatches = false;
			}
			if (!bindingMatches || !resolved)
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
