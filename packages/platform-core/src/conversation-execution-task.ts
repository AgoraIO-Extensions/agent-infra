import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentConfigurationRecordV2 } from "./agent-configuration.js";
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
import type { WorkloadVersionV1 } from "./workload-reconciliation.js";

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
	readonly lastWaitOrder: number;
	readonly sourceKind: "standard" | "custom" | null;
	readonly conversation: ConversationExecutionConversationStateV1 | null;
	readonly modelConfiguration: ConversationModelConfigurationV1 | null;
	readonly customCapability?: {
		readonly configuration: AgentConfigurationRecordV2;
		readonly verified: WorkloadVersionV1;
		readonly deployment: {
			readonly agentId: string;
			readonly configurationRevision: number;
			readonly interactionMode: string;
			readonly imageDigest: string;
			readonly resourceProfileRef: string;
		};
	} | null;
}

export interface ConversationTaskAdmissionPlanV1 {
	readonly conversationId: string;
	readonly createConversation: boolean;
	readonly executionId: string;
	readonly turnId: string;
	readonly messageId: string;
	readonly modelConfigurationRevision: number | null;
	readonly modelOptionId: string | null;
	readonly reasoningLevel: string | null;
	readonly acceptedAt: Date;
	readonly waitDeadline: Date;
	readonly waitOrder: number;
	readonly conversationStatus: "ready";
	readonly executionStatus: "waiting";
	readonly messageStatus: "submitted";
	readonly outbox: {
		readonly id: string;
		readonly operation: "conversation.turn.submit.v1";
		readonly availability: "after_dispatch";
		readonly payload: {
			readonly schemaVersion: 1;
			readonly conversationId: string;
			readonly executionId: string;
			readonly messageId: string;
			readonly turnId: string;
			readonly sessionGeneration: number;
			readonly modelConfigurationRevision: number | null;
			readonly modelOptionId: string | null;
			readonly reasoningLevel: string | null;
		};
	};
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

/** Only never-sent waiting tasks use this decision; capacity is checked separately. */
export function decideConversationTaskWaitingV1(state: {
	readonly nowMs: number;
	readonly deadlineMs: number;
	readonly agent: {
		readonly status: string | null;
		readonly desiredState: string | null;
		readonly serviceAvailability: string | null;
	} | null;
	readonly conversationAvailable: boolean;
	readonly isolationPending: boolean;
	readonly occupied: boolean;
	readonly earlierWaiting: boolean;
}):
	| { readonly outcome: "dispatch" | "wait" }
	| {
			readonly outcome: "fail";
			readonly reason:
				| "TASK_WAIT_TIMEOUT"
				| "AGENT_UNAVAILABLE"
				| "CONVERSATION_UNAVAILABLE";
	  } {
	if (
		!Number.isSafeInteger(state.nowMs) ||
		!Number.isSafeInteger(state.deadlineMs)
	)
		throw new TypeError("Task waiting clock is invalid");
	if (state.nowMs >= state.deadlineMs)
		return { outcome: "fail", reason: "TASK_WAIT_TIMEOUT" };
	if (state.isolationPending) return { outcome: "wait" };
	if (!state.conversationAvailable)
		return { outcome: "fail", reason: "CONVERSATION_UNAVAILABLE" };
	if (
		state.agent?.status !== "available" ||
		state.agent.desiredState !== "running" ||
		!["ready", "starting", "updating"].includes(
			state.agent.serviceAvailability ?? "",
		)
	)
		return { outcome: "fail", reason: "AGENT_UNAVAILABLE" };
	return {
		outcome:
			state.agent.serviceAvailability !== "ready" ||
			state.occupied ||
			state.earlierWaiting
				? "wait"
				: "dispatch",
	};
}

function customTaskCompatible(
	state: ConversationTaskAdmissionStateV1,
	agentId: string,
): boolean {
	const proof = state.customCapability;
	if (!proof) return false;
	const { configuration, verified, deployment } = proof;
	const capacity = verified.executionCapacity;
	return (
		configuration.agentId === agentId &&
		configuration.source.kind === "custom" &&
		configuration.source.interactionMode === "platform-adapter" &&
		configuration.modelConfiguration === null &&
		isDeepStrictEqual(configuration, verified.configuration) &&
		deployment.agentId === agentId &&
		deployment.configurationRevision === configuration.revision &&
		deployment.interactionMode === "platform-adapter" &&
		deployment.imageDigest === configuration.source.imageDigest &&
		capacity?.imageDigest === deployment.imageDigest &&
		capacity.resourceProfileRef === deployment.resourceProfileRef &&
		Number.isSafeInteger(capacity.maximumConcurrentExecutions) &&
		capacity.maximumConcurrentExecutions > 0
	);
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
						if (
							state.sourceKind === "custom"
								? model !== null ||
									!customTaskCompatible(state, authority.agentId)
								: state.sourceKind !== "standard" || !model
						)
							return { outcome: "denied", reason: "model_unavailable" };
						const selection = conversation
							? effectiveModelSelection(conversation, model ?? undefined)
							: {
									modelOptionId: model?.defaultOptionId ?? null,
									reasoningLevel: model?.defaultReasoningLevel ?? null,
									fallback: null,
								};
						const modelOptionId = selection.modelOptionId;
						const reasoningLevel = selection.reasoningLevel;
						if (
							model &&
							(modelOptionId === null ||
								reasoningLevel === null ||
								!model.options.some(
									(option) =>
										option.optionId === modelOptionId &&
										option.reasoningLevels.includes(reasoningLevel),
								))
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
						const turnId = nextOpaqueId(newId);
						const messageId = nextOpaqueId(newId);
						const waitOrder = nextCounter(state.lastWaitOrder);
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
							turnId,
							messageId,
							modelConfigurationRevision: model?.configurationRevision ?? null,
							modelOptionId,
							reasoningLevel,
							acceptedAt,
							waitDeadline: new Date(deadlineMs),
							waitOrder,
							conversationStatus: "ready",
							executionStatus: "waiting",
							messageStatus: "submitted",
							outbox: {
								id: `conversation:turn:${executionId}`,
								operation: "conversation.turn.submit.v1",
								availability: "after_dispatch",
								payload: {
									schemaVersion: 1,
									conversationId,
									executionId,
									messageId,
									turnId,
									sessionGeneration: conversation?.sessionGeneration ?? 1,
									modelConfigurationRevision:
										model?.configurationRevision ?? null,
									modelOptionId,
									reasoningLevel,
								},
							},
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
