import { randomUUID } from "node:crypto";

export * from "./conversation-execution-task.js";

import {
	authorize,
	parseConversationStateQuery,
	parseCreateCommand,
	parseMessageCommand,
	parseModelSelectionCommand,
	parseRegenerateCommand,
	parseStopCommand,
} from "./conversation-execution-input.js";
import {
	normalizeCommandDecision,
	normalizeConversationStateDecision,
	normalizeCreateDecision,
	normalizeModelSelectionDecision,
	normalizeStopDecision,
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
	ConversationExecutionUseCaseDependenciesV1,
	ConversationExecutionUseCaseOptionsV1,
	ConversationExecutionUseCaseV1,
	ConversationModelSelectionResultV1,
	ConversationStopResultV1,
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
	type CreateConversationCommandV1,
	type CreateConversationDecisionV1,
	type CreateConversationWritePlanV1,
} from "./conversation-execution-types.js";

export function createConversationExecutionUseCaseV1(
	dependencies: ConversationExecutionUseCaseDependenciesV1,
	options: ConversationExecutionUseCaseOptionsV1 = {},
): ConversationExecutionUseCaseV1 {
	const now = options.now ?? (() => new Date());
	const newId = options.newId ?? randomUUID;
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
							const modelSelection = effectiveModelSelection(
								conversation,
								state.modelConfiguration,
							);
							const selectedConversation = {
								...conversation,
								selectedModelOptionId: modelSelection.modelOptionId,
								selectedReasoningLevel: modelSelection.reasoningLevel,
							};
							if (state.activeExecution) {
								if (
									state.activeExecution.stopPending ||
									!authority.supportsSupplementaryInstruction ||
									state.activeExecution.actorId !== authority.actorId
								) {
									return { outcome: "busy" };
								}
								const occurredAt = safeNow(now);
								const messageId = nextOpaqueId(newId);
								const modelSelectionFallback = modelSelectionFallbackWrite(
									modelSelection.fallback,
									authority,
									conversation.conversationId,
									state.activeExecution.executionId,
									state.activeExecution.lastEventSequence,
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
									executionId: state.activeExecution.executionId,
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
										executionId: state.activeExecution.executionId,
										status: "submitted",
										createdAt: occurredAt,
									},
									outboxIntent: {
										operation: "conversation.turn.supplement.v1",
										conversationId: conversation.conversationId,
										executionId: state.activeExecution.executionId,
										messageId,
										turnId: state.activeExecution.turnId,
										sessionGeneration: state.activeExecution.sessionGeneration,
										modelConfigurationRevision:
											state.activeExecution.modelConfigurationRevision,
										modelOptionId: state.activeExecution.modelOptionId,
										reasoningLevel: state.activeExecution.reasoningLevel,
										traceId: command.traceId,
										requestId: command.requestId,
										occurredAt,
									},
									auditEvent: {
										action: "conversation.message.supplemented",
										actorId: authority.actorId,
										agentId: authority.agentId,
										conversationId: conversation.conversationId,
										executionId: state.activeExecution.executionId,
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
							if (state.hasWaitingTask) return { outcome: "busy" };
							const occurredAt = safeNow(now);
							const messageId = nextOpaqueId(newId);
							const executionId = nextOpaqueId(newId);
							const turnId = nextOpaqueId(newId);
							const modelSelectionFallback = modelSelectionFallbackWrite(
								modelSelection.fallback,
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
							if (state.activeExecution || state.hasWaitingTask)
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
								outboxIntent: {
									operation: "conversation.turn.stop.v1",
									conversationId: conversation.conversationId,
									executionId: targetExecution.executionId,
									sessionGeneration: targetExecution.sessionGeneration,
									stopRequestId,
									traceId: command.traceId,
									requestId: command.requestId,
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
	};
}
