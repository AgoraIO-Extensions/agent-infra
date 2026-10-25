import { randomUUID } from "node:crypto";
import {
	authorize,
	parseConversationStateQuery,
	parseCreateCommand,
	parseMessageCommand,
	parseModelSelectionCommand,
	parseRegenerateCommand,
	parseStopCommand,
	parseWithdrawCommand,
} from "./conversation-execution-input.js";
import {
	normalizeCommandDecision,
	normalizeConversationStateDecision,
	normalizeCreateDecision,
	normalizeModelSelectionDecision,
	normalizeStopDecision,
	normalizeWithdrawDecision,
	parseMessageCommandResult,
	parseRegenerationCommandResult,
} from "./conversation-execution-result.js";
import {
	effectiveModelSelection,
	modelSelectionFallbackWrite,
	parseState,
	planMetadataRecovery,
} from "./conversation-execution-state.js";
import type {
	ConversationCommandResultV1,
	ConversationCreatedResultV1,
	ConversationExecutionAuthorityV1,
	ConversationExecutionConversationStateV1,
	ConversationExecutionStateV1,
	ConversationExecutionUseCaseDependenciesV1,
	ConversationExecutionUseCaseOptionsV1,
	ConversationExecutionUseCaseV1,
	ConversationMessageCommandV1,
	ConversationMessageWritePlanV1,
	ConversationModelSelectionResultV1,
	ConversationStopResultV1,
	ConversationWithdrawCommandV1,
	ConversationWithdrawPlanV1,
	ConversationWithdrawResultV1,
	ConversationWithdrawStateV1,
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
import {
	conversationQueueCapacityV1,
	conversationQueueDeadlineV1,
} from "./conversation-queue.js";
import { createSessionSandboxBindingV1 } from "./session-sandbox.js";

export {
	modelOptionDisplayNameV1,
	requestedModelDisplayNameV1,
} from "./conversation-execution-state.js";
export {
	type ConversationCommandDecisionV1,
	type ConversationCommandResultV1,
	type ConversationCreatedResultV1,
	type ConversationExecutionAuthorityV1,
	type ConversationExecutionAuthorizationPortV1,
	type ConversationExecutionConversationStateV1,
	ConversationExecutionError,
	type ConversationExecutionStateV1,
	type ConversationExecutionTransactionPortV1,
	type ConversationExecutionUseCaseDependenciesV1,
	type ConversationExecutionUseCaseOptionsV1,
	type ConversationExecutionUseCaseV1,
	type ConversationMessageCommandV1,
	type ConversationMessageWritePlanV1,
	type ConversationMetadataRecoveryQueryV1,
	type ConversationMetadataRecoveryResultV1,
	type ConversationMetadataRecoveryStateV1,
	type ConversationMetadataRecoveryWritePlanV1,
	type ConversationModelConfigurationV1,
	type ConversationModelSelectionCommandV1,
	type ConversationModelSelectionDecisionV1,
	type ConversationModelSelectionFallbackV1,
	type ConversationModelSelectionFallbackWriteV1,
	type ConversationModelSelectionResultV1,
	type ConversationModelSelectionWritePlanV1,
	type ConversationRegenerateCommandV1,
	type ConversationRegenerationWritePlanV1,
	type ConversationStateDecisionV1,
	type ConversationStateQueryV1,
	type ConversationStateResultV1,
	type ConversationStopCommandV1,
	type ConversationStopDecisionV1,
	type ConversationStopResultV1,
	type ConversationStopWritePlanV1,
	type ConversationTaskExecutionStatusV1,
	type ConversationWithdrawCommandV1,
	type ConversationWithdrawDecisionV1,
	type ConversationWithdrawPlanV1,
	type ConversationWithdrawResultV1,
	type ConversationWithdrawStateV1,
	type CreateConversationCommandV1,
	type CreateConversationDecisionV1,
	type CreateConversationWritePlanV1,
} from "./conversation-execution-types.js";
export * from "./conversation-queue.js";

/** Platform stop acknowledgement budget; callers cannot configure task runtime limits. */
export const conversationStopConfirmationTimeoutMsV1 = 60_000;

export function createConversationExecutionUseCaseV1(
	dependencies: ConversationExecutionUseCaseDependenciesV1,
	options: ConversationExecutionUseCaseOptionsV1 = {},
): ConversationExecutionUseCaseV1 {
	const now = options.now ?? (() => new Date());
	const newId = options.newId ?? randomUUID;
	const maximumWaitingTasksPerAgent = options.maximumWaitingTasksPerAgent;
	if (
		maximumWaitingTasksPerAgent !== undefined &&
		(!Number.isSafeInteger(maximumWaitingTasksPerAgent) ||
			maximumWaitingTasksPerAgent < 1)
	)
		invalidInput();
	const busy = (queuedCount: number) =>
		({ outcome: "busy", queuedCount }) as const;
	/**
	 * 排队消息（工程 Spec §12.5）：Message、`waiting` Execution、只能由认领准入的 Turn outbox，
	 * 以及平台来源的 `task.status: waiting` 事件在同一事务写入。
	 */
	const queuedPlan = (
		state: ConversationExecutionStateV1,
		conversation: ConversationExecutionConversationStateV1,
		modelSelection: ReturnType<typeof effectiveModelSelection>,
		command: ConversationMessageCommandV1,
		authority: ConversationExecutionAuthorityV1,
		requestDigest: string,
	):
		| ConversationMessageWritePlanV1
		| { readonly outcome: "busy"; readonly queuedCount: number } => {
		const waitingCount = state.queue?.waitingCount ?? 0;
		const agentQueue = state.queue?.agent;
		if (!agentQueue) return unavailable();
		if (
			waitingCount >= conversationQueueCapacityV1 ||
			(maximumWaitingTasksPerAgent !== undefined &&
				agentQueue.waitingCount >= maximumWaitingTasksPerAgent)
		)
			return busy(waitingCount);
		const occurredAt = safeNow(now);
		const waitDeadline = conversationQueueDeadlineV1(
			occurredAt,
			command.queueDeadlineLimit,
		);
		if (!waitDeadline) return busy(waitingCount);
		const messageId = nextOpaqueId(newId);
		const executionId = nextOpaqueId(newId);
		const turnId = nextOpaqueId(newId);
		const statusEvent = {
			eventId: nextOpaqueId(newId),
			sequence: 1 as const,
			conversationCursor: conversation.lastConversationCursor + 1,
			event: { type: "task.status" as const, status: "waiting" as const },
		};
		if (!Number.isSafeInteger(statusEvent.conversationCursor))
			return unavailable();
		const modelSelectionFallback = modelSelectionFallbackWrite(
			modelSelection.fallback,
			state.modelConfiguration,
			authority,
			conversation.conversationId,
			executionId,
			statusEvent.sequence,
			statusEvent.conversationCursor,
			command.requestId,
			command.traceId,
			occurredAt,
			newId,
		);
		const result: ConversationCommandResultV1 = {
			schemaVersion: 1,
			status: "submitted",
			messageId,
			executionId,
			queuePosition: waitingCount + 1,
		};
		return {
			schemaVersion: 1,
			kind: "queued",
			conversation: {
				...conversation,
				lastConversationCursor:
					modelSelectionFallback?.timelineEvent.conversationCursor ??
					statusEvent.conversationCursor,
				authorizationRevision: authority.authorizationRevision,
				updatedAt: occurredAt,
			},
			message: {
				messageId,
				conversationId: conversation.conversationId,
				actorId: authority.actorId,
				text: command.text,
				executionId,
				status: "submitted",
				createdAt: occurredAt,
			},
			execution: {
				executionId,
				conversationId: conversation.conversationId,
				agentId: authority.agentId,
				actorId: authority.actorId,
				channelId: authority.channelId,
				turnId,
				status: "waiting",
				sessionGeneration: conversation.sessionGeneration,
				deliveryFence: 0,
				authorizationRevision: authority.authorizationRevision,
				modelConfigurationRevision: modelSelection.modelConfigurationRevision,
				modelOptionId: modelSelection.modelOptionId,
				reasoningLevel: modelSelection.reasoningLevel,
				createdAt: occurredAt,
				taskWaitOrder: nextCounter(agentQueue.lastWaitOrder),
				taskWaitDeadline: waitDeadline,
			},
			statusEvent,
			outboxIntent: {
				operation: "conversation.turn.submit.v1",
				conversationId: conversation.conversationId,
				executionId,
				messageId,
				turnId,
				sessionGeneration: conversation.sessionGeneration,
				modelConfigurationRevision: modelSelection.modelConfigurationRevision,
				modelOptionId: modelSelection.modelOptionId,
				reasoningLevel: modelSelection.reasoningLevel,
				traceId: command.traceId,
				requestId: command.requestId,
				...(command.traceParent === undefined
					? {}
					: { traceParent: command.traceParent }),
				occurredAt,
			},
			auditEvent: {
				action: "conversation.message.queued",
				actorId: authority.actorId,
				agentId: authority.agentId,
				conversationId: conversation.conversationId,
				executionId,
				traceId: command.traceId,
				requestId: command.requestId,
				occurredAt,
			},
			modelSelectionFallback,
			result,
			idempotency: {
				scopeType: "conversation",
				scopeId: conversation.conversationId,
				actorId: authority.actorId,
				commandType: "message",
				key: command.idempotencyKey,
				requestDigest,
			},
		};
	};
	return {
		async requestMetadataRecovery(queryInput) {
			const input = snapshotObject(
				queryInput,
				["schemaVersion", "conversationId"],
				["executionId"],
			);
			const query = {
				...parseConversationStateQuery({
					schemaVersion: input.schemaVersion,
					conversationId: input.conversationId,
				}),
				...(input.executionId !== undefined
					? {
							executionId: isText(input.executionId, 1024)
								? input.executionId
								: invalidInput(),
						}
					: {}),
			};
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "conversation.read",
				conversationId: query.conversationId,
			});
			if (!authority) return { outcome: "denied" };
			try {
				return await dependencies.transaction.requestMetadataRecovery(
					{ query, authority },
					(state) =>
						planMetadataRecovery(query, authority, state, now(), newId),
				);
			} catch {
				return unavailable();
			}
		},
		async readConversation(queryInput) {
			const query = parseConversationStateQuery(queryInput);
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "conversation.read",
				conversationId: query.conversationId,
			});
			if (!authority) return { outcome: "denied" };
			try {
				return normalizeConversationStateDecision(
					await dependencies.transaction.readConversation(
						{ query, authority },
						(stateInput) => {
							const state = parseState(stateInput);
							const conversation = state.conversation;
							if (
								!conversation ||
								conversation.conversationId !== query.conversationId ||
								conversation.actorId !== authority.actorId ||
								(conversation.principal?.kind ?? "user") !==
									(authority.taskBoundary?.principal.kind ?? "user") ||
								conversation.agentId !== authority.agentId ||
								conversation.channelId !== authority.channelId
							) {
								return { outcome: "denied" };
							}
							const selection = effectiveModelSelection(
								conversation,
								state.modelConfiguration,
							);
							return {
								outcome: "found",
								result: {
									schemaVersion: 1,
									conversation: {
										...conversation,
										selectedModelOptionId: selection.modelOptionId,
										selectedReasoningLevel: selection.reasoningLevel,
									},
									modelSelectionFallback: selection.fallback,
								},
							};
						},
					),
					query.conversationId,
					authority,
				);
			} catch {
				return unavailable();
			}
		},
		async createConversation(commandInput) {
			const command = parseCreateCommand(commandInput);
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "conversation.create",
				agentId: command.agentId,
			});
			if (!authority || authority.agentId !== command.agentId)
				return { outcome: "denied" };
			const requestDigest = digest({
				schemaVersion: command.schemaVersion,
				command: "conversation.create",
				agentId: command.agentId,
			});
			try {
				return normalizeCreateDecision(
					await dependencies.transaction.createConversation(
						{ command, authority, requestDigest },
						() => {
							const occurredAt = safeNow(now);
							const conversationId = nextOpaqueId(newId);
							const result: ConversationCreatedResultV1 = {
								schemaVersion: 1,
								conversationId,
								agentId: authority.agentId,
								status: "ready",
							};
							return {
								schemaVersion: 1,
								sandbox: createSessionSandboxBindingV1(
									authority,
									conversationId,
								),
								conversation: {
									schemaVersion: 1,
									conversationId,
									agentId: authority.agentId,
									actorId: authority.actorId,
									channelId: authority.channelId,
									status: "ready",
									sessionGeneration: 1,
									hostSessionRef: null,
									authorizationRevision: authority.authorizationRevision,
									lastConversationCursor: 0,
									selectedModelOptionId: null,
									selectedReasoningLevel: null,
									createdAt: occurredAt,
									updatedAt: occurredAt,
								},
								result,
								idempotency: {
									scopeType: "agent",
									scopeId: authority.agentId,
									actorId: authority.actorId,
									channelId: authority.channelId,
									commandType: "conversation.create",
									key: command.idempotencyKey,
									requestDigest,
								},
							};
						},
					),
					authority.agentId,
				);
			} catch {
				return unavailable();
			}
		},
		async accept(commandInput) {
			const command = parseMessageCommand(commandInput);
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "message",
				conversationId: command.conversationId,
			});
			if (!authority) return { outcome: "denied" };
			const requestDigest = digest({
				schemaVersion: command.schemaVersion,
				command: command.command,
				conversationId: command.conversationId,
				text: command.text,
				...(command.attachments?.length
					? { attachments: command.attachments }
					: {}),
			});
			try {
				return normalizeCommandDecision(
					await dependencies.transaction.executeMessage(
						{ command, authority, requestDigest },
						(stateInput) => {
							const state = parseState(stateInput);
							const conversation = state.conversation;
							if (
								!conversation ||
								conversation.conversationId !== command.conversationId ||
								conversation.actorId !== authority.actorId ||
								(conversation.principal?.kind ?? "user") !==
									(authority.taskBoundary?.principal.kind ?? "user") ||
								conversation.agentId !== authority.agentId ||
								conversation.channelId !== authority.channelId
							) {
								return { outcome: "denied" };
							}
							if (
								conversation.status === "unavailable" ||
								conversation.isolationPending
							)
								return { outcome: "denied" };
							// A Web Conversation stays read-only until its own Sandbox is
							// ready (Spec §10.1.1); report that as starting, not as a denial.
							// 空闲回收后的 Sandbox 由下一条消息恢复，必须受理（#2239）。
							if (
								authority.channelId === "web" &&
								conversation.sandbox !== undefined &&
								conversation.sandboxReady !== true &&
								conversation.sandboxResumable !== true
							)
								return { outcome: "starting" };
							const modelSelection = effectiveModelSelection(
								conversation,
								state.modelConfiguration,
							);
							const selectedConversation = {
								...conversation,
								selectedModelOptionId: modelSelection.modelOptionId,
								selectedReasoningLevel: modelSelection.reasoningLevel,
							};
							const queue = state.queue ?? { waitingCount: 0 };
							const active = state.activeExecution;
							// 判定顺序见工程 Spec §12.5：补充指令 → 排队 → 繁忙；不默认打断当前回复。
							if (active || queue.waitingCount > 0) {
								if (active && active.actorId !== authority.actorId)
									return busy(queue.waitingCount);
								// 补充指令只给已被 Runtime 接受、仍在运行的回复；有排队时不越过先到的消息。
								const canSupplement =
									active !== undefined &&
									active.status === "processing" &&
									!active.stopPending &&
									authority.supportsSupplementaryInstruction &&
									queue.waitingCount === 0;
								if (!canSupplement)
									return queuedPlan(
										state,
										selectedConversation,
										modelSelection,
										command,
										authority,
										requestDigest,
									);
							}
							if (active) {
								const occurredAt = safeNow(now);
								const messageId = nextOpaqueId(newId);
								const modelSelectionFallback = modelSelectionFallbackWrite(
									modelSelection.fallback,
									state.modelConfiguration,
									authority,
									conversation.conversationId,
									active.executionId,
									active.lastEventSequence,
									conversation.lastConversationCursor,
									command.requestId,
									command.traceId,
									occurredAt,
									newId,
								);
								const result: ConversationCommandResultV1 = {
									schemaVersion: 1,
									status: "submitted",
									messageId,
									executionId: active.executionId,
								};
								return {
									schemaVersion: 1,
									kind: "supplement",
									conversation: {
										...selectedConversation,
										lastConversationCursor:
											modelSelectionFallback?.timelineEvent
												.conversationCursor ??
											conversation.lastConversationCursor,
										authorizationRevision: authority.authorizationRevision,
										updatedAt: occurredAt,
									},
									message: {
										messageId,
										conversationId: conversation.conversationId,
										actorId: authority.actorId,
										text: command.text,
										executionId: active.executionId,
										status: "submitted",
										createdAt: occurredAt,
									},
									outboxIntent: {
										operation: "conversation.turn.supplement.v1",
										conversationId: conversation.conversationId,
										executionId: active.executionId,
										messageId,
										turnId: active.turnId,
										sessionGeneration: active.sessionGeneration,
										modelConfigurationRevision:
											active.modelConfigurationRevision,
										modelOptionId: active.modelOptionId,
										reasoningLevel: active.reasoningLevel,
										traceId: command.traceId,
										requestId: command.requestId,
										...(command.traceParent === undefined
											? {}
											: { traceParent: command.traceParent }),
										occurredAt,
									},
									auditEvent: {
										action: "conversation.message.supplemented",
										actorId: authority.actorId,
										agentId: authority.agentId,
										conversationId: conversation.conversationId,
										executionId: active.executionId,
										traceId: command.traceId,
										requestId: command.requestId,
										occurredAt,
									},
									modelSelectionFallback,
									result,
									idempotency: {
										scopeType: "conversation",
										scopeId: conversation.conversationId,
										actorId: authority.actorId,
										commandType: "message",
										key: command.idempotencyKey,
										requestDigest,
									},
								};
							}
							const occurredAt = safeNow(now);
							const messageId = nextOpaqueId(newId);
							const executionId = nextOpaqueId(newId);
							const turnId = nextOpaqueId(newId);
							const modelSelectionFallback = modelSelectionFallbackWrite(
								modelSelection.fallback,
								state.modelConfiguration,
								authority,
								conversation.conversationId,
								executionId,
								0,
								conversation.lastConversationCursor,
								command.requestId,
								command.traceId,
								occurredAt,
								newId,
							);
							const result: ConversationCommandResultV1 = {
								schemaVersion: 1,
								status: "submitted",
								messageId,
								executionId,
							};
							return {
								schemaVersion: 1,
								kind: "initial",
								conversation: {
									...selectedConversation,
									status: "active",
									lastConversationCursor:
										modelSelectionFallback?.timelineEvent.conversationCursor ??
										conversation.lastConversationCursor,
									authorizationRevision: authority.authorizationRevision,
									updatedAt: occurredAt,
								},
								message: {
									messageId,
									conversationId: conversation.conversationId,
									actorId: authority.actorId,
									text: command.text,
									executionId,
									status: "submitted",
									createdAt: occurredAt,
								},
								execution: {
									executionId,
									conversationId: conversation.conversationId,
									agentId: authority.agentId,
									actorId: authority.actorId,
									channelId: authority.channelId,
									turnId,
									status: "submitted",
									sessionGeneration: conversation.sessionGeneration,
									deliveryFence: 0,
									authorizationRevision: authority.authorizationRevision,
									modelConfigurationRevision:
										modelSelection.modelConfigurationRevision,
									modelOptionId: modelSelection.modelOptionId,
									reasoningLevel: modelSelection.reasoningLevel,
									createdAt: occurredAt,
								},
								outboxIntent: {
									operation: "conversation.turn.submit.v1",
									conversationId: conversation.conversationId,
									executionId,
									messageId,
									turnId,
									sessionGeneration: conversation.sessionGeneration,
									modelConfigurationRevision:
										modelSelection.modelConfigurationRevision,
									modelOptionId: modelSelection.modelOptionId,
									reasoningLevel: modelSelection.reasoningLevel,
									traceId: command.traceId,
									requestId: command.requestId,
									...(command.traceParent === undefined
										? {}
										: { traceParent: command.traceParent }),
									occurredAt,
								},
								auditEvent: {
									action: "conversation.message.accepted",
									actorId: authority.actorId,
									agentId: authority.agentId,
									conversationId: conversation.conversationId,
									executionId,
									traceId: command.traceId,
									requestId: command.requestId,
									occurredAt,
								},
								modelSelectionFallback,
								result,
								idempotency: {
									scopeType: "conversation",
									scopeId: conversation.conversationId,
									actorId: authority.actorId,
									commandType: "message",
									key: command.idempotencyKey,
									requestDigest,
								},
							};
						},
					),
					parseMessageCommandResult,
				);
			} catch {
				return unavailable();
			}
		},
		async selectModel(commandInput) {
			const command = parseModelSelectionCommand(commandInput);
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "model.select",
				conversationId: command.conversationId,
			});
			if (!authority) return { outcome: "denied" };
			const requestDigest = digest({
				schemaVersion: command.schemaVersion,
				command: command.command,
				conversationId: command.conversationId,
				modelOptionId: command.modelOptionId,
				reasoningLevel: command.reasoningLevel,
			});
			try {
				return normalizeModelSelectionDecision(
					await dependencies.transaction.executeModelSelection(
						{ command, authority, requestDigest },
						(stateInput) => {
							const state = parseState(stateInput);
							const conversation = state.conversation;
							const configuration = state.modelConfiguration;
							const selected = configuration?.options.find(
								({ optionId }) => optionId === command.modelOptionId,
							);
							if (
								!conversation ||
								!configuration ||
								conversation.conversationId !== command.conversationId ||
								conversation.actorId !== authority.actorId ||
								(conversation.principal?.kind ?? "user") !==
									(authority.taskBoundary?.principal.kind ?? "user") ||
								conversation.agentId !== authority.agentId ||
								conversation.channelId !== authority.channelId ||
								conversation.status === "unavailable" ||
								conversation.isolationPending ||
								!selected?.reasoningLevels.includes(command.reasoningLevel)
							) {
								return { outcome: "denied" };
							}
							const occurredAt = safeNow(now);
							const result: ConversationModelSelectionResultV1 = {
								schemaVersion: 1,
								conversationId: conversation.conversationId,
							};
							return {
								schemaVersion: 1,
								conversation: {
									...conversation,
									authorizationRevision: authority.authorizationRevision,
									selectedModelOptionId: selected.optionId,
									selectedReasoningLevel: command.reasoningLevel,
									updatedAt: occurredAt,
								},
								auditEvent: {
									action: "conversation.model_selection.updated",
									actorId: authority.actorId,
									agentId: authority.agentId,
									conversationId: conversation.conversationId,
									traceId: command.traceId,
									requestId: command.requestId,
									occurredAt,
									modelConfigurationRevision:
										configuration.configurationRevision,
									modelOptionId: selected.optionId,
									reasoningLevel: command.reasoningLevel,
								},
								result,
								idempotency: {
									scopeType: "conversation",
									scopeId: conversation.conversationId,
									actorId: authority.actorId,
									commandType: "model.select",
									key: command.idempotencyKey,
									requestDigest,
								},
							};
						},
					),
					command.conversationId,
				);
			} catch {
				return unavailable();
			}
		},
		async regenerate(commandInput) {
			const command = parseRegenerateCommand(commandInput);
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "regenerate",
				conversationId: command.conversationId,
			});
			if (!authority) return { outcome: "denied" };
			const requestDigest = digest({
				schemaVersion: command.schemaVersion,
				command: command.command,
				conversationId: command.conversationId,
				sourceMessageId: command.sourceMessageId,
			});
			try {
				return normalizeCommandDecision(
					await dependencies.transaction.executeRegeneration(
						{ command, authority, requestDigest },
						(stateInput) => {
							const state = parseState(stateInput);
							const conversation = state.conversation;
							const sourceMessage = state.sourceMessage;
							if (
								!conversation ||
								conversation.conversationId !== command.conversationId ||
								conversation.actorId !== authority.actorId ||
								(conversation.principal?.kind ?? "user") !==
									(authority.taskBoundary?.principal.kind ?? "user") ||
								conversation.agentId !== authority.agentId ||
								conversation.channelId !== authority.channelId ||
								!sourceMessage ||
								sourceMessage.messageId !== command.sourceMessageId ||
								sourceMessage.actorId !== authority.actorId
							) {
								return { outcome: "denied" };
							}
							if (
								conversation.status === "unavailable" ||
								conversation.isolationPending
							)
								return { outcome: "denied" };
							// A Web Conversation stays read-only until its own Sandbox is
							// ready (Spec §10.1.1); report that as starting, not as a denial.
							// 空闲回收后的 Sandbox 由下一条消息恢复，必须受理（#2239）。
							if (
								authority.channelId === "web" &&
								conversation.sandbox !== undefined &&
								conversation.sandboxReady !== true &&
								conversation.sandboxResumable !== true
							)
								return { outcome: "starting" };
							// 重新生成不进入排队：有活跃回复或更早的排队消息时繁忙（§12.5）。
							if (state.activeExecution || (state.queue?.waitingCount ?? 0) > 0)
								return { outcome: "busy" };
							const modelSelection = effectiveModelSelection(
								conversation,
								state.modelConfiguration,
							);
							const occurredAt = safeNow(now);
							const executionId = nextOpaqueId(newId);
							const turnId = nextOpaqueId(newId);
							const modelSelectionFallback = modelSelectionFallbackWrite(
								modelSelection.fallback,
								state.modelConfiguration,
								authority,
								conversation.conversationId,
								executionId,
								0,
								conversation.lastConversationCursor,
								command.requestId,
								command.traceId,
								occurredAt,
								newId,
							);
							const result: ConversationCommandResultV1 = {
								schemaVersion: 1,
								status: "submitted",
								messageId: null,
								executionId,
							};
							return {
								schemaVersion: 1,
								kind: "regenerate",
								conversation: {
									...conversation,
									status: "active",
									lastConversationCursor:
										modelSelectionFallback?.timelineEvent.conversationCursor ??
										conversation.lastConversationCursor,
									authorizationRevision: authority.authorizationRevision,
									selectedModelOptionId: modelSelection.modelOptionId,
									selectedReasoningLevel: modelSelection.reasoningLevel,
									updatedAt: occurredAt,
								},
								execution: {
									executionId,
									conversationId: conversation.conversationId,
									agentId: authority.agentId,
									actorId: authority.actorId,
									channelId: authority.channelId,
									turnId,
									status: "submitted",
									sessionGeneration: conversation.sessionGeneration,
									deliveryFence: 0,
									authorizationRevision: authority.authorizationRevision,
									modelConfigurationRevision:
										modelSelection.modelConfigurationRevision,
									modelOptionId: modelSelection.modelOptionId,
									reasoningLevel: modelSelection.reasoningLevel,
									createdAt: occurredAt,
								},
								outboxIntent: {
									operation: "conversation.turn.regenerate.v1",
									conversationId: conversation.conversationId,
									executionId,
									messageId: sourceMessage.messageId,
									turnId,
									sessionGeneration: conversation.sessionGeneration,
									modelConfigurationRevision:
										modelSelection.modelConfigurationRevision,
									modelOptionId: modelSelection.modelOptionId,
									reasoningLevel: modelSelection.reasoningLevel,
									traceId: command.traceId,
									requestId: command.requestId,
									...(command.traceParent === undefined
										? {}
										: { traceParent: command.traceParent }),
									occurredAt,
								},
								auditEvent: {
									action: "conversation.regeneration.accepted",
									actorId: authority.actorId,
									agentId: authority.agentId,
									conversationId: conversation.conversationId,
									executionId,
									traceId: command.traceId,
									requestId: command.requestId,
									occurredAt,
								},
								modelSelectionFallback,
								result,
								idempotency: {
									scopeType: "conversation",
									scopeId: conversation.conversationId,
									actorId: authority.actorId,
									commandType: "regenerate",
									key: command.idempotencyKey,
									requestDigest,
								},
							};
						},
					),
					parseRegenerationCommandResult,
				);
			} catch {
				return unavailable();
			}
		},
		async stop(commandInput) {
			const command = parseStopCommand(commandInput);
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "stop",
				conversationId: command.conversationId,
			});
			if (!authority) return { outcome: "denied" };
			const requestDigest = digest({
				schemaVersion: command.schemaVersion,
				command: command.command,
				conversationId: command.conversationId,
				targetExecutionId: command.targetExecutionId,
			});
			try {
				return normalizeStopDecision(
					await dependencies.transaction.executeStop(
						{ command, authority, requestDigest },
						(stateInput) => {
							const state = parseState(stateInput);
							const conversation = state.conversation;
							const targetExecution = state.targetExecution;
							if (
								!conversation ||
								conversation.conversationId !== command.conversationId ||
								conversation.actorId !== authority.actorId ||
								(conversation.principal?.kind ?? "user") !==
									(authority.taskBoundary?.principal.kind ?? "user") ||
								conversation.agentId !== authority.agentId ||
								conversation.channelId !== authority.channelId ||
								!targetExecution ||
								targetExecution.executionId !== command.targetExecutionId ||
								targetExecution.actorId !== authority.actorId
							) {
								return { outcome: "denied" };
							}
							if (state.existingStop) {
								return {
									outcome: "replayed",
									result: {
										schemaVersion: 1,
										status:
											state.existingStop.status === "completed"
												? "already_finished"
												: "submitted",
										executionId: targetExecution.executionId,
									},
								};
							}
							if (
								targetExecution.status === "completed" ||
								targetExecution.status === "failed" ||
								targetExecution.status === "cancelled"
							) {
								return {
									outcome: "accepted",
									result: {
										schemaVersion: 1,
										status: "already_finished",
										executionId: targetExecution.executionId,
									},
								};
							}
							const occurredAt = safeNow(now);
							const stopRequestId = nextOpaqueId(newId);
							const result: ConversationStopResultV1 = {
								schemaVersion: 1,
								status: "submitted",
								executionId: targetExecution.executionId,
							};
							return {
								schemaVersion: 1,
								targetExecution: {
									executionId: targetExecution.executionId,
									conversationId: conversation.conversationId,
									actorId: authority.actorId,
								},
								stopRequestId,
								confirmationDeadline: new Date(
									occurredAt.getTime() +
										conversationStopConfirmationTimeoutMsV1,
								),
								outboxIntent: {
									operation: "conversation.turn.stop.v1",
									conversationId: conversation.conversationId,
									executionId: targetExecution.executionId,
									sessionGeneration: targetExecution.sessionGeneration,
									stopRequestId,
									traceId: command.traceId,
									requestId: command.requestId,
									...(command.traceParent === undefined
										? {}
										: { traceParent: command.traceParent }),
									occurredAt,
								},
								auditEvent: {
									action: "conversation.stop.accepted",
									actorId: authority.actorId,
									agentId: authority.agentId,
									conversationId: conversation.conversationId,
									executionId: targetExecution.executionId,
									traceId: command.traceId,
									requestId: command.requestId,
									occurredAt,
								},
								result,
								idempotency: {
									scopeType: "conversation",
									scopeId: conversation.conversationId,
									actorId: authority.actorId,
									commandType: "stop",
									key: command.idempotencyKey,
									requestDigest,
								},
							};
						},
					),
					command.targetExecutionId,
				);
			} catch {
				return unavailable();
			}
		},
		async withdraw(commandInput) {
			const command = parseWithdrawCommand(commandInput);
			const authority = await authorize(dependencies.authorization, {
				schemaVersion: 1,
				operation: "withdraw",
				conversationId: command.conversationId,
			});
			if (!authority) return { outcome: "denied" };
			const execute = dependencies.transaction.executeWithdrawal;
			if (!execute) return unavailable();
			const requestDigest = digest({
				schemaVersion: command.schemaVersion,
				command: command.command,
				conversationId: command.conversationId,
				targetExecutionId: command.targetExecutionId,
			});
			try {
				return normalizeWithdrawDecision(
					await execute.call(
						dependencies.transaction,
						{ command, authority, requestDigest },
						(state) =>
							decideConversationWithdrawalV1(
								state,
								command,
								authority,
								requestDigest,
							),
					),
					command.targetExecutionId,
				);
			} catch {
				return unavailable();
			}
		},
	};
}

/**
 * 撤回排队消息（工程 Spec §12.5）：只有 Web 发送者能撤回自己经排队受理、仍为 `waiting`
 * 的消息；已离开 `waiting` 的返回已开始或已结束，不影响执行。
 */
export function decideConversationWithdrawalV1(
	state: ConversationWithdrawStateV1,
	command: ConversationWithdrawCommandV1,
	authority: ConversationExecutionAuthorityV1,
	requestDigest: string,
): ConversationWithdrawPlanV1 | { readonly outcome: "denied" } {
	const conversation = state.conversation;
	const target = state.target;
	if (
		authority.channelId !== "web" ||
		!conversation ||
		conversation.conversationId !== command.conversationId ||
		conversation.actorId !== authority.actorId ||
		conversation.agentId !== authority.agentId ||
		conversation.channelId !== authority.channelId ||
		!target ||
		target.executionId !== command.targetExecutionId ||
		target.conversationId !== conversation.conversationId ||
		target.actorId !== authority.actorId ||
		!target.queued
	)
		return { outcome: "denied" };
	const status: ConversationWithdrawResultV1["status"] =
		target.status === "waiting"
			? "withdrawn"
			: target.status === "completed" ||
					target.status === "failed" ||
					target.status === "cancelled"
				? "already_finished"
				: "already_started";
	return {
		schemaVersion: 1,
		result: { schemaVersion: 1, status, executionId: target.executionId },
		idempotency: {
			scopeType: "conversation",
			scopeId: conversation.conversationId,
			actorId: authority.actorId,
			commandType: "withdraw",
			key: command.idempotencyKey,
			requestDigest,
		},
	};
}
