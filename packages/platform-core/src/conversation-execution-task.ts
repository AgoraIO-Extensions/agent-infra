import { randomUUID } from "node:crypto";
import { parseAuthority } from "./conversation-execution-input.js";
import {
	effectiveModelSelection,
	modelSelectionFallbackWrite,
} from "./conversation-execution-state.js";
import type {
	ConversationExecutionAuthorityV1,
	ConversationExecutionConversationStateV1,
	ConversationModelConfigurationV1,
	ConversationModelSelectionFallbackWriteV1,
} from "./conversation-execution-types.js";
import {
	digest,
	invalidInput,
	isText,
	nextCounter,
	nextOpaqueId,
	safeNow,
	snapshotObject,
	unavailable,
} from "./conversation-execution-values.js";

export interface ConversationTaskSubmitCommandV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly conversationId?: string;
	readonly text: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export interface ConversationTaskAdmissionStateV1 {
	readonly agent: {
		readonly status: string;
		readonly desiredState: string | null;
		readonly serviceAvailability: string | null;
	} | null;
	readonly waitingCount: number;
	readonly sourceKind: "standard" | "custom" | null;
	readonly conversation: ConversationExecutionConversationStateV1 | null;
	readonly modelConfiguration: ConversationModelConfigurationV1 | null;
}

export interface ConversationTaskAdmissionPlanV1 {
	readonly conversationId: string;
	readonly createConversation: boolean;
	readonly executionId: string;
	readonly turnId: string;
	readonly messageId: string;
	readonly modelConfigurationRevision: number;
	readonly modelOptionId: string;
	readonly reasoningLevel: string;
	readonly acceptedAt: Date;
	readonly waitDeadline: Date;
	readonly outboxOperation: "conversation.turn.submit.v1";
	readonly auditAction: "conversation.task.accepted";
	readonly statusEvent: {
		readonly eventId: string;
		readonly sequence: 1;
		readonly conversationCursor: number;
		readonly event: {
			readonly type: "task.status";
			readonly status: "waiting";
		};
	};
	readonly modelSelectionFallback: ConversationModelSelectionFallbackWriteV1 | null;
}

export interface ConversationTaskSubmitResultV1 {
	readonly schemaVersion: 1;
	readonly status: "accepted";
	readonly conversationId: string;
	readonly executionId: string;
	readonly messageId: string;
}

export type ConversationTaskSubmitDecisionV1 =
	| {
			readonly outcome: "accepted" | "replayed";
			readonly result: ConversationTaskSubmitResultV1;
	  }
	| {
			readonly outcome: "denied";
			readonly reason:
				| "agent_unavailable"
				| "conversation_unavailable"
				| "model_unavailable";
	  }
	| { readonly outcome: "capacity_full" }
	| { readonly outcome: "conflict"; readonly reason: "idempotency_conflict" };

export interface ConversationTaskAdmissionAuthorizationPortV1 {
	authorize(input: {
		readonly schemaVersion: 1;
		readonly operation: "task.submit";
		readonly agentId: string;
		readonly conversationId?: string;
	}): Promise<
		| {
				readonly outcome: "allowed";
				readonly authority: ConversationExecutionAuthorityV1;
		  }
		| { readonly outcome: "denied" }
	>;
}

export interface ConversationTaskAdmissionTransactionPortV1 {
	submitTask(
		request: {
			readonly command: ConversationTaskSubmitCommandV1;
			readonly authority: ConversationExecutionAuthorityV1;
			readonly requestDigest: string;
		},
		decide: (
			state: ConversationTaskAdmissionStateV1,
		) =>
			| ConversationTaskAdmissionPlanV1
			| Exclude<
					ConversationTaskSubmitDecisionV1,
					{ outcome: "accepted" | "replayed" | "conflict" }
			  >,
	): Promise<ConversationTaskSubmitDecisionV1>;
}

export interface ConversationTaskAdmissionPolicyV1 {
	readonly maximumWaitingTasksPerAgent: number;
	readonly waitingTimeoutMs: number;
}

export function createConversationTaskAdmissionUseCaseV1(
	dependencies: {
		readonly authorization: ConversationTaskAdmissionAuthorizationPortV1;
		readonly transaction: ConversationTaskAdmissionTransactionPortV1;
	},
	policy: ConversationTaskAdmissionPolicyV1,
	options: { readonly now?: () => Date; readonly newId?: () => string } = {},
): {
	submitTask(
		command: ConversationTaskSubmitCommandV1,
	): Promise<ConversationTaskSubmitDecisionV1>;
} {
	if (
		!Number.isSafeInteger(policy.maximumWaitingTasksPerAgent) ||
		policy.maximumWaitingTasksPerAgent < 1 ||
		!Number.isSafeInteger(policy.waitingTimeoutMs) ||
		policy.waitingTimeoutMs < 1
	)
		invalidInput();
	const now = options.now ?? (() => new Date());
	const newId = options.newId ?? randomUUID;
	return {
		async submitTask(commandInput) {
			const values = snapshotObject(
				commandInput,
				[
					"schemaVersion",
					"agentId",
					"text",
					"idempotencyKey",
					"requestId",
					"traceId",
				],
				["conversationId"],
			);
			if (
				values.schemaVersion !== 1 ||
				!isText(values.agentId) ||
				(values.conversationId !== undefined &&
					!isText(values.conversationId)) ||
				!isText(values.text) ||
				typeof values.idempotencyKey !== "string" ||
				!/^[A-Za-z0-9._~-]{1,128}$/.test(values.idempotencyKey) ||
				!isText(values.requestId) ||
				!isText(values.traceId)
			)
				invalidInput();
			const command: ConversationTaskSubmitCommandV1 = {
				schemaVersion: 1,
				agentId: values.agentId,
				...(values.conversationId === undefined
					? {}
					: { conversationId: values.conversationId as string }),
				text: values.text,
				idempotencyKey: values.idempotencyKey,
				requestId: values.requestId,
				traceId: values.traceId,
			};
			let authority: ConversationExecutionAuthorityV1;
			try {
				const decision = await dependencies.authorization.authorize({
					schemaVersion: 1,
					operation: "task.submit",
					agentId: command.agentId,
					...(command.conversationId
						? { conversationId: command.conversationId }
						: {}),
				});
				if (decision.outcome === "denied")
					return { outcome: "denied", reason: "conversation_unavailable" };
				if (decision.outcome !== "allowed") unavailable();
				authority = parseAuthority(decision.authority);
			} catch {
				return unavailable();
			}
			if (authority.agentId !== command.agentId || !authority.taskBoundary)
				return { outcome: "denied", reason: "conversation_unavailable" };
			const requestDigest = digest({
				schemaVersion: 1,
				command: "task.submit",
				agentId: command.agentId,
				conversationId: command.conversationId ?? null,
				text: command.text,
			});
			try {
				return await dependencies.transaction.submitTask(
					{ command, authority, requestDigest },
					(state) => {
						const conversation = state.conversation;
						if (
							command.conversationId &&
							(!conversation ||
								conversation.conversationId !== command.conversationId ||
								conversation.actorId !== authority.actorId ||
								conversation.agentId !== authority.agentId ||
								conversation.channelId !== authority.channelId ||
								conversation.status === "unavailable" ||
								conversation.isolationPending)
						)
							return { outcome: "denied", reason: "conversation_unavailable" };
						if (
							state.agent?.status !== "available" ||
							state.agent.desiredState !== "running" ||
							!["ready", "starting", "updating"].includes(
								state.agent.serviceAvailability ?? "",
							)
						)
							return { outcome: "denied", reason: "agent_unavailable" };
						if (state.waitingCount >= policy.maximumWaitingTasksPerAgent)
							return { outcome: "capacity_full" };
						const model = state.modelConfiguration;
						if (state.sourceKind !== "standard" || !model)
							return { outcome: "denied", reason: "model_unavailable" };
						const selection = conversation
							? effectiveModelSelection(conversation, model)
							: {
									modelOptionId: model.defaultOptionId,
									reasoningLevel: model.defaultReasoningLevel,
									fallback: null,
								};
						const modelOptionId = selection.modelOptionId;
						const reasoningLevel = selection.reasoningLevel;
						if (
							modelOptionId === null ||
							reasoningLevel === null ||
							!model.options.some(
								(option) =>
									option.optionId === modelOptionId &&
									option.reasoningLevels.includes(reasoningLevel),
							)
						)
							return { outcome: "denied", reason: "model_unavailable" };
						const acceptedAt = safeNow(now);
						const deadlineMs = acceptedAt.getTime() + policy.waitingTimeoutMs;
						if (
							!Number.isFinite(deadlineMs) ||
							deadlineMs > 8_640_000_000_000_000
						)
							unavailable();
						const conversationId =
							conversation?.conversationId ?? nextOpaqueId(newId);
						const executionId = nextOpaqueId(newId);
						const statusEvent = {
							eventId: nextOpaqueId(newId),
							sequence: 1 as const,
							conversationCursor: nextCounter(
								conversation?.lastConversationCursor ?? 0,
							),
							event: {
								type: "task.status" as const,
								status: "waiting" as const,
							},
						};
						const modelSelectionFallback = conversation
							? modelSelectionFallbackWrite(
									selection.fallback,
									authority,
									conversationId,
									executionId,
									statusEvent.sequence,
									statusEvent.conversationCursor,
									command.requestId,
									command.traceId,
									acceptedAt,
									newId,
								)
							: null;
						return {
							conversationId,
							createConversation: !conversation,
							executionId,
							turnId: nextOpaqueId(newId),
							messageId: nextOpaqueId(newId),
							modelConfigurationRevision: model.configurationRevision,
							modelOptionId,
							reasoningLevel,
							acceptedAt,
							waitDeadline: new Date(deadlineMs),
							outboxOperation: "conversation.turn.submit.v1",
							auditAction: "conversation.task.accepted",
							statusEvent,
							modelSelectionFallback,
						};
					},
				);
			} catch {
				return unavailable();
			}
		},
	};
}
