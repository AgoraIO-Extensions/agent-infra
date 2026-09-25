import {
	type ConversationMetadataRecoveryV1,
	parseConversationMetadataRecoveryV1,
} from "./conversation-dispatch.js";
import type {
	ConversationExecutionAuthorityV1,
	ConversationExecutionConversationStateV1,
	ConversationExecutionStateV1,
	ConversationMetadataRecoveryQueryV1,
	ConversationMetadataRecoveryStateV1,
	ConversationMetadataRecoveryWritePlanV1,
	ConversationModelConfigurationV1,
	ConversationModelSelectionFallbackV1,
	ConversationModelSelectionFallbackWriteV1,
} from "./conversation-execution-types.js";
import {
	isNonNegativeSafeInteger,
	isPositiveSafeInteger,
	isText,
	nextCounter,
	nextOpaqueId,
	snapshotDate,
	snapshotObject,
	unavailable,
} from "./conversation-execution-values.js";
import { parseTaskAuthorizationBoundaryV1 } from "./task-authorization.js";

export function parseState(
	input: ConversationExecutionStateV1,
): ConversationExecutionStateV1 {
	try {
		const values = snapshotObject(
			input,
			[
				"conversation",
				"modelConfiguration",
				"sourceMessage",
				"targetExecution",
				"existingStop",
				"activeExecution",
			],
			["hasWaitingTask"],
		);
		if (
			values.hasWaitingTask !== undefined &&
			typeof values.hasWaitingTask !== "boolean"
		)
			unavailable();
		if (values.conversation === undefined) {
			if (
				values.modelConfiguration !== undefined ||
				values.sourceMessage !== undefined ||
				values.targetExecution !== undefined ||
				values.existingStop !== undefined ||
				values.activeExecution !== undefined ||
				values.hasWaitingTask === true
			) {
				unavailable();
			}
			return {
				hasWaitingTask: false,
				conversation: undefined,
				modelConfiguration: undefined,
				sourceMessage: undefined,
				targetExecution: undefined,
				existingStop: undefined,
				activeExecution: undefined,
			};
		}
		const conversation = snapshotObject(
			values.conversation,
			[
				"schemaVersion",
				"conversationId",
				"agentId",
				"actorId",
				"channelId",
				"status",
				"sessionGeneration",
				"hostSessionRef",
				"authorizationRevision",
				"lastConversationCursor",
				"selectedModelOptionId",
				"selectedReasoningLevel",
				"createdAt",
				"updatedAt",
			],
			["isolationPending"],
		);
		const sessionGenerationInput = conversation.sessionGeneration;
		const lastConversationCursorInput = conversation.lastConversationCursor;
		if (
			conversation.schemaVersion !== 1 ||
			(conversation.isolationPending !== undefined &&
				conversation.isolationPending !== true) ||
			!isText(conversation.conversationId) ||
			!isText(conversation.agentId) ||
			!isText(conversation.actorId) ||
			!isText(conversation.channelId) ||
			(conversation.status !== "ready" &&
				conversation.status !== "active" &&
				conversation.status !== "unavailable") ||
			!isPositiveSafeInteger(sessionGenerationInput) ||
			(conversation.hostSessionRef !== null &&
				!isText(conversation.hostSessionRef)) ||
			!isText(conversation.authorizationRevision) ||
			!isNonNegativeSafeInteger(lastConversationCursorInput) ||
			(conversation.selectedModelOptionId !== null &&
				!isText(conversation.selectedModelOptionId)) ||
			(conversation.selectedReasoningLevel !== null &&
				!isText(conversation.selectedReasoningLevel)) ||
			(conversation.selectedModelOptionId === null) !==
				(conversation.selectedReasoningLevel === null)
		) {
			unavailable();
		}
		const createdAt = snapshotDate(conversation.createdAt);
		const updatedAt = snapshotDate(conversation.updatedAt);
		if (updatedAt.getTime() < createdAt.getTime()) unavailable();
		const modelConfiguration = (() => {
			if (values.modelConfiguration === undefined) return undefined;
			const configuration = snapshotObject(values.modelConfiguration, [
				"configurationRevision",
				"options",
				"defaultOptionId",
				"defaultReasoningLevel",
			]);
			if (
				!isPositiveSafeInteger(configuration.configurationRevision) ||
				!Array.isArray(configuration.options) ||
				configuration.options.length === 0 ||
				!isText(configuration.defaultOptionId) ||
				!isText(configuration.defaultReasoningLevel)
			) {
				unavailable();
			}
			const seen = new Set<string>();
			const options = configuration.options.map((input) => {
				const option = snapshotObject(input, ["optionId", "reasoningLevels"]);
				if (
					!isText(option.optionId) ||
					seen.has(option.optionId) ||
					!Array.isArray(option.reasoningLevels) ||
					option.reasoningLevels.length === 0 ||
					!option.reasoningLevels.every((level) => isText(level)) ||
					new Set(option.reasoningLevels).size !== option.reasoningLevels.length
				) {
					unavailable();
				}
				seen.add(option.optionId);
				return {
					optionId: option.optionId,
					reasoningLevels: [...option.reasoningLevels] as string[],
				};
			});
			if (
				!options
					.find(({ optionId }) => optionId === configuration.defaultOptionId)
					?.reasoningLevels.includes(configuration.defaultReasoningLevel)
			) {
				unavailable();
			}
			return {
				configurationRevision: configuration.configurationRevision,
				options,
				defaultOptionId: configuration.defaultOptionId,
				defaultReasoningLevel: configuration.defaultReasoningLevel,
			};
		})();
		const sourceMessage = (() => {
			if (values.sourceMessage === undefined) return undefined;
			const message = snapshotObject(values.sourceMessage, [
				"messageId",
				"conversationId",
				"actorId",
				"role",
			]);
			if (
				!isText(message.messageId) ||
				!isText(message.conversationId) ||
				!isText(message.actorId) ||
				message.role !== "user"
			) {
				unavailable();
			}
			return {
				messageId: message.messageId,
				conversationId: message.conversationId,
				actorId: message.actorId,
				role: "user" as const,
			};
		})();
		const targetExecution = (() => {
			if (values.targetExecution === undefined) return undefined;
			const execution = snapshotObject(values.targetExecution, [
				"executionId",
				"conversationId",
				"actorId",
				"sessionGeneration",
				"modelConfigurationRevision",
				"modelOptionId",
				"reasoningLevel",
				"status",
			]);
			const status = execution.status;
			if (
				!isText(execution.executionId) ||
				!isText(execution.conversationId) ||
				!isText(execution.actorId) ||
				!isPositiveSafeInteger(execution.sessionGeneration) ||
				(execution.modelConfigurationRevision !== null &&
					!isPositiveSafeInteger(execution.modelConfigurationRevision)) ||
				(execution.modelOptionId !== null &&
					!isText(execution.modelOptionId)) ||
				(execution.reasoningLevel !== null &&
					!isText(execution.reasoningLevel)) ||
				new Set([
					execution.modelConfigurationRevision === null,
					execution.modelOptionId === null,
					execution.reasoningLevel === null,
				]).size !== 1 ||
				(status !== "submitted" &&
					status !== "processing" &&
					status !== "unknown" &&
					status !== "completed" &&
					status !== "failed" &&
					status !== "cancelled")
			) {
				unavailable();
			}
			return {
				executionId: execution.executionId,
				conversationId: execution.conversationId,
				actorId: execution.actorId,
				sessionGeneration: execution.sessionGeneration,
				modelConfigurationRevision: execution.modelConfigurationRevision,
				modelOptionId: execution.modelOptionId,
				reasoningLevel: execution.reasoningLevel,
				status: status as NonNullable<
					ConversationExecutionStateV1["targetExecution"]
				>["status"],
			};
		})();
		const existingStop = (() => {
			if (values.existingStop === undefined) return undefined;
			const stop = snapshotObject(values.existingStop, [
				"executionId",
				"stopRequestId",
				"status",
			]);
			if (
				!isText(stop.executionId) ||
				!isText(stop.stopRequestId) ||
				(stop.status !== "submitted" && stop.status !== "completed")
			) {
				unavailable();
			}
			return {
				executionId: stop.executionId,
				stopRequestId: stop.stopRequestId,
				status: stop.status as "submitted" | "completed",
			};
		})();
		const activeExecution = (() => {
			if (values.activeExecution === undefined) return undefined;
			const execution = snapshotObject(values.activeExecution, [
				"executionId",
				"conversationId",
				"actorId",
				"turnId",
				"sessionGeneration",
				"modelConfigurationRevision",
				"modelOptionId",
				"reasoningLevel",
				"lastEventSequence",
				"stopPending",
				"status",
			]);
			const executionStatus = execution.status;
			if (
				!isText(execution.executionId) ||
				!isText(execution.conversationId) ||
				!isText(execution.actorId) ||
				!isText(execution.turnId) ||
				!isPositiveSafeInteger(execution.sessionGeneration) ||
				(execution.modelConfigurationRevision !== null &&
					!isPositiveSafeInteger(execution.modelConfigurationRevision)) ||
				(execution.modelOptionId !== null &&
					!isText(execution.modelOptionId)) ||
				(execution.reasoningLevel !== null &&
					!isText(execution.reasoningLevel)) ||
				!isNonNegativeSafeInteger(execution.lastEventSequence) ||
				new Set([
					execution.modelConfigurationRevision === null,
					execution.modelOptionId === null,
					execution.reasoningLevel === null,
				]).size !== 1 ||
				typeof execution.stopPending !== "boolean" ||
				(executionStatus !== "submitted" &&
					executionStatus !== "processing" &&
					executionStatus !== "unknown")
			) {
				unavailable();
			}
			return {
				executionId: execution.executionId,
				conversationId: execution.conversationId,
				actorId: execution.actorId,
				turnId: execution.turnId,
				sessionGeneration: execution.sessionGeneration,
				modelConfigurationRevision: execution.modelConfigurationRevision,
				modelOptionId: execution.modelOptionId,
				reasoningLevel: execution.reasoningLevel,
				lastEventSequence: execution.lastEventSequence,
				stopPending: execution.stopPending,
				status: executionStatus as "submitted" | "processing" | "unknown",
			};
		})();
		if (
			activeExecution &&
			activeExecution.conversationId !== conversation.conversationId
		) {
			unavailable();
		}
		if (
			sourceMessage &&
			sourceMessage.conversationId !== conversation.conversationId
		) {
			unavailable();
		}
		if (
			targetExecution &&
			targetExecution.conversationId !== conversation.conversationId
		) {
			unavailable();
		}
		if (
			existingStop &&
			(!targetExecution ||
				existingStop.executionId !== targetExecution.executionId)
		) {
			unavailable();
		}
		const sessionGeneration = conversation.sessionGeneration as number;
		const lastConversationCursor =
			conversation.lastConversationCursor as number;
		const status =
			conversation.status as ConversationExecutionConversationStateV1["status"];
		return {
			hasWaitingTask: values.hasWaitingTask === true,
			conversation: {
				schemaVersion: 1,
				conversationId: conversation.conversationId,
				agentId: conversation.agentId,
				actorId: conversation.actorId,
				channelId: conversation.channelId,
				status,
				...(conversation.isolationPending === true
					? { isolationPending: true as const }
					: {}),
				sessionGeneration,
				hostSessionRef: conversation.hostSessionRef,
				authorizationRevision: conversation.authorizationRevision,
				lastConversationCursor,
				selectedModelOptionId: conversation.selectedModelOptionId,
				selectedReasoningLevel: conversation.selectedReasoningLevel,
				createdAt,
				updatedAt,
			},
			modelConfiguration,
			sourceMessage,
			targetExecution,
			existingStop,
			activeExecution,
		};
	} catch {
		return unavailable();
	}
}

export function effectiveModelSelection(
	conversation: ConversationExecutionConversationStateV1,
	configuration: ConversationModelConfigurationV1 | undefined,
): {
	readonly modelConfigurationRevision: number | null;
	readonly modelOptionId: string | null;
	readonly reasoningLevel: string | null;
	readonly fallback: ConversationModelSelectionFallbackV1 | null;
} {
	if (!configuration) {
		return {
			modelConfigurationRevision: null,
			modelOptionId: null,
			reasoningLevel: null,
			fallback: null,
		};
	}
	// Managed WeCom has no user model selection; each new Turn uses current Owner defaults.
	if (/^wecom_(bot|app):/.test(conversation.channelId)) {
		return {
			modelConfigurationRevision: configuration.configurationRevision,
			modelOptionId: configuration.defaultOptionId,
			reasoningLevel: configuration.defaultReasoningLevel,
			fallback: null,
		};
	}
	const selected = configuration.options.find(
		({ optionId, reasoningLevels }) =>
			optionId === conversation.selectedModelOptionId &&
			conversation.selectedReasoningLevel !== null &&
			reasoningLevels.includes(conversation.selectedReasoningLevel),
	);
	return {
		modelConfigurationRevision: configuration.configurationRevision,
		modelOptionId: selected?.optionId ?? configuration.defaultOptionId,
		reasoningLevel: selected
			? conversation.selectedReasoningLevel
			: configuration.defaultReasoningLevel,
		fallback:
			!selected &&
			conversation.selectedModelOptionId !== null &&
			conversation.selectedReasoningLevel !== null
				? {
						previousModelOptionId: conversation.selectedModelOptionId,
						previousReasoningLevel: conversation.selectedReasoningLevel,
						modelConfigurationRevision: configuration.configurationRevision,
						modelOptionId: configuration.defaultOptionId,
						reasoningLevel: configuration.defaultReasoningLevel,
					}
				: null,
	};
}

export function modelSelectionFallbackWrite(
	fallback: ConversationModelSelectionFallbackV1 | null,
	authority: ConversationExecutionAuthorityV1,
	conversationId: string,
	executionId: string,
	lastEventSequence: number,
	lastConversationCursor: number,
	requestId: string,
	traceId: string,
	occurredAt: Date,
	newId: () => string,
): ConversationModelSelectionFallbackWriteV1 | null {
	if (!fallback) return null;
	const eventId = nextOpaqueId(newId);
	return {
		...fallback,
		timelineEvent: {
			schemaVersion: 1,
			eventId,
			conversationId,
			executionId,
			sequence: nextCounter(lastEventSequence),
			conversationCursor: nextCounter(lastConversationCursor),
			occurredAt: occurredAt.toISOString(),
			event: {
				type: "model.selection.fell_back",
				modelOptionId: fallback.modelOptionId,
				reasoningLevel: fallback.reasoningLevel,
				reason: "selection_unavailable",
			},
		},
		auditEvent: {
			action: "conversation.model_selection.fell_back",
			executionId,
			actorId: authority.actorId,
			agentId: authority.agentId,
			conversationId,
			traceId,
			requestId,
			occurredAt,
		},
	};
}

/** Original-history recovery is a domain decision shared by persistent and Fake adapters. */
export function planMetadataRecovery(
	query: ConversationMetadataRecoveryQueryV1,
	authority: ConversationExecutionAuthorityV1,
	state: ConversationMetadataRecoveryStateV1,
	requestedAt: Date,
	newId: () => string,
): ConversationMetadataRecoveryWritePlanV1 {
	const conversation = state.conversation;
	if (
		!conversation ||
		conversation.conversationId !== query.conversationId ||
		conversation.agentId !== authority.agentId ||
		conversation.actorId !== authority.actorId ||
		conversation.channelId !== authority.channelId
	)
		return { result: { outcome: "denied" }, updates: [] };
	if (!conversation.hostSessionRef || conversation.isolationPending)
		return { result: { outcome: "not_applicable" }, updates: [] };
	const eligible: {
		itemId: string;
		status: string;
		metadataRecovery?: ConversationMetadataRecoveryV1;
	}[] = [];
	for (const candidate of state.candidates) {
		const execution = candidate.execution;
		const [outbox] = candidate.originalOutboxes;
		if (
			candidate.originalOutboxes.length !== 1 ||
			!outbox ||
			execution.conversationId !== conversation.conversationId ||
			execution.agentId !== conversation.agentId ||
			execution.actorId !== conversation.actorId ||
			execution.channelId !== conversation.channelId ||
			execution.sessionGeneration !== conversation.sessionGeneration ||
			(query.executionId !== undefined &&
				execution.executionId !== query.executionId) ||
			!["completed", "failed", "cancelled"].includes(execution.status) ||
			!Number.isSafeInteger(execution.deliveryFence) ||
			execution.deliveryFence < 1 ||
			!execution.runtimeCursor ||
			!candidate.latestToolFacts.some(
				(fact) =>
					fact.kind === "tool" &&
					fact.connection?.verification === "unverified",
			) ||
			candidate.boundary === null ||
			candidate.boundary === undefined
		)
			continue;
		const originalId =
			outbox.operation === "conversation.turn.submit.v1"
				? `conversation:turn:${execution.executionId}`
				: outbox.operation === "conversation.turn.regenerate.v1"
					? `conversation:regenerate:${execution.executionId}`
					: undefined;
		if (outbox.itemId !== originalId) continue;
		const payload = snapshotObject(
			outbox.payload,
			[
				"schemaVersion",
				"conversationId",
				"executionId",
				"messageId",
				"turnId",
				"sessionGeneration",
			],
			[
				"modelConfigurationRevision",
				"modelOptionId",
				"reasoningLevel",
				"metadataRecovery",
			],
		);
		if (
			payload.schemaVersion !== 1 ||
			payload.conversationId !== execution.conversationId ||
			payload.executionId !== execution.executionId ||
			payload.turnId !== execution.turnId ||
			payload.sessionGeneration !== execution.sessionGeneration ||
			!isText(payload.messageId, 1024)
		)
			continue;
		let boundary: ReturnType<typeof parseTaskAuthorizationBoundaryV1>;
		try {
			boundary = parseTaskAuthorizationBoundaryV1(candidate.boundary);
		} catch {
			continue;
		}
		if (
			boundary.principal.kind !== "user" ||
			boundary.principal.id !== execution.actorId ||
			boundary.agentId !== execution.agentId ||
			boundary.channelId !== execution.channelId ||
			boundary.agentAuthorizationRevision !== execution.authorizationRevision
		)
			continue;
		const metadataRecovery =
			payload.metadataRecovery === undefined
				? undefined
				: parseConversationMetadataRecoveryV1(payload.metadataRecovery);
		if (
			!["succeeded", "failed"].includes(outbox.status) &&
			(!metadataRecovery ||
				!["pending", "processing", "retry_scheduled"].includes(outbox.status))
		)
			continue;
		eligible.push({
			itemId: outbox.itemId,
			status: outbox.status,
			...(metadataRecovery ? { metadataRecovery } : {}),
		});
	}
	eligible.sort(
		(a, b) =>
			(a.metadataRecovery?.requestedAt ?? 0) -
				(b.metadataRecovery?.requestedAt ?? 0) ||
			a.itemId.localeCompare(b.itemId),
	);
	const updates: {
		itemId: string;
		metadataRecovery: ConversationMetadataRecoveryV1;
	}[] = [];
	let coalesced = false;
	for (const candidate of eligible.slice(0, 16)) {
		if (candidate.status !== "succeeded" && candidate.status !== "failed") {
			coalesced = true;
			continue;
		}
		updates.push({
			itemId: candidate.itemId,
			metadataRecovery: parseConversationMetadataRecoveryV1({
				id: newId(),
				requestedAt: requestedAt.getTime(),
				originalStatus: candidate.status,
			}),
		});
	}
	return {
		result: {
			outcome:
				updates.length > 0
					? "scheduled"
					: coalesced
						? "coalesced"
						: "not_applicable",
		},
		updates,
	};
}
