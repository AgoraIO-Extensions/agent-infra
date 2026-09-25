import { randomUUID } from "node:crypto";
import { parseAuthority } from "./conversation-execution-input.js";
import type {
	ConversationExecutionAuthorityV1,
	ConversationExecutionConversationStateV1,
	ConversationModelConfigurationV1,
} from "./conversation-execution-types.js";
import {
	digest,
	invalidInput,
	isText,
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
						if (!model)
							return { outcome: "denied", reason: "model_unavailable" };
						const modelOptionId =
							conversation?.selectedModelOptionId ?? model.defaultOptionId;
						const reasoningLevel =
							conversation?.selectedReasoningLevel ??
							model.defaultReasoningLevel;
						if (
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
						return {
							conversationId:
								conversation?.conversationId ?? nextOpaqueId(newId),
							createConversation: !conversation,
							executionId: nextOpaqueId(newId),
							turnId: nextOpaqueId(newId),
							messageId: nextOpaqueId(newId),
							modelConfigurationRevision: model.configurationRevision,
							modelOptionId,
							reasoningLevel,
							acceptedAt,
							waitDeadline: new Date(deadlineMs),
						};
					},
				);
			} catch {
				return unavailable();
			}
		},
	};
}
