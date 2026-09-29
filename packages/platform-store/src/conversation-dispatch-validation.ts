import {
	type ConversationDispatchClaimV1,
	type ConversationDispatchExecutionStatusV1,
	type ConversationDispatchOperationV1,
	type ConversationDispatchStateTransitionV1,
	type ConversationMetadataRecoveryV1,
	parseConversationMetadataRecoveryV1,
} from "@agent-infra/platform-core";
import {
	type ConversationPayload,
	operations,
	plainObject,
	safeCounter,
	validText,
} from "./conversation-dispatch-common.js";

export function exactPayload(
	value: unknown,
	operation: ConversationDispatchOperationV1,
): ConversationPayload | undefined {
	const input = plainObject(value);
	if (!input) return undefined;
	const isStop = operation === "conversation.turn.stop.v1";
	const selectionKeys = [
		"modelConfigurationRevision",
		"modelOptionId",
		"reasoningLevel",
	] as const;
	const hasSelection = selectionKeys.every((key) => Object.hasOwn(input, key));
	if (
		!isStop &&
		selectionKeys.some((key) => Object.hasOwn(input, key)) !== hasSelection
	) {
		return undefined;
	}
	let metadataRecovery: ConversationMetadataRecoveryV1 | undefined;
	if (Object.hasOwn(input, "metadataRecovery")) {
		if (!isTurn(operation)) return undefined;
		try {
			metadataRecovery = parseConversationMetadataRecoveryV1(
				input.metadataRecovery,
			);
		} catch {
			return undefined;
		}
	}
	const expected = new Set(
		isStop
			? [
					"schemaVersion",
					"conversationId",
					"executionId",
					"sessionGeneration",
					"stopRequestId",
				]
			: [
					"schemaVersion",
					"conversationId",
					"executionId",
					"messageId",
					"turnId",
					"sessionGeneration",
					...(hasSelection ? selectionKeys : []),
					...(metadataRecovery ? ["metadataRecovery"] : []),
				],
	);
	if (
		Object.keys(input).length !== expected.size ||
		Object.keys(input).some((key) => !expected.has(key)) ||
		input.schemaVersion !== 1 ||
		!validText(input.conversationId) ||
		!validText(input.executionId) ||
		(isStop
			? !validText(input.stopRequestId)
			: !validText(input.messageId) || !validText(input.turnId))
	) {
		return undefined;
	}
	const sessionGeneration = safeCounter(input.sessionGeneration, 1);
	if (sessionGeneration === undefined) return undefined;
	const modelConfigurationRevision =
		isStop || !hasSelection
			? null
			: input.modelConfigurationRevision === null
				? null
				: safeCounter(input.modelConfigurationRevision, 1);
	const modelOptionId = isStop || !hasSelection ? null : input.modelOptionId;
	const reasoningLevel = isStop || !hasSelection ? null : input.reasoningLevel;
	if (
		modelConfigurationRevision === undefined ||
		new Set([
			modelConfigurationRevision === null,
			modelOptionId === null,
			reasoningLevel === null,
		]).size !== 1 ||
		(modelOptionId !== null && !validText(modelOptionId)) ||
		(reasoningLevel !== null && !validText(reasoningLevel))
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		conversationId: input.conversationId,
		executionId: input.executionId,
		messageId: isStop ? null : (input.messageId as string),
		turnId: isStop ? null : (input.turnId as string),
		sessionGeneration,
		stopRequestId: isStop ? (input.stopRequestId as string) : null,
		modelConfigurationRevision,
		modelOptionId: modelOptionId as string | null,
		reasoningLevel: reasoningLevel as string | null,
		...(metadataRecovery ? { metadataRecovery } : {}),
	};
}

export function operation(
	value: unknown,
): ConversationDispatchOperationV1 | undefined {
	return typeof value === "string" &&
		operations.has(value as ConversationDispatchOperationV1)
		? (value as ConversationDispatchOperationV1)
		: undefined;
}

export function terminal(status: ConversationDispatchExecutionStatusV1) {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

export function isTurn(operation: ConversationDispatchOperationV1) {
	return (
		operation === "conversation.turn.submit.v1" ||
		operation === "conversation.turn.regenerate.v1"
	);
}

export function requireCommand(input: {
	readonly schemaVersion: 1;
	readonly itemId: string;
	readonly workerId: string;
	readonly leaseDurationMs: number;
}) {
	if (
		!input ||
		typeof input !== "object" ||
		Object.keys(input).some(
			(key) =>
				!["schemaVersion", "itemId", "workerId", "leaseDurationMs"].includes(
					key,
				),
		) ||
		input.schemaVersion !== 1 ||
		!validText(input.itemId) ||
		!validText(input.workerId) ||
		!Number.isSafeInteger(input.leaseDurationMs) ||
		input.leaseDurationMs < 1 ||
		input.leaseDurationMs > 300_000
	) {
		throw new TypeError("Conversation dispatch claim is invalid");
	}
}

export function requireClaim(claim: ConversationDispatchClaimV1) {
	if (claim?.metadataRecovery !== undefined) {
		parseConversationMetadataRecoveryV1(claim.metadataRecovery);
		if (
			!isTurn(claim.operation) ||
			!terminal(claim.executionStatus) ||
			!claim.hostSessionRef ||
			!claim.runtimeCursor
		)
			throw new TypeError("Invalid metadata recovery claim");
	}
	if (
		!claim ||
		typeof claim !== "object" ||
		claim.schemaVersion !== 1 ||
		![claim.itemId, claim.leaseOwner].every((value) => validText(value)) ||
		!Number.isSafeInteger(claim.deliveryFence) ||
		claim.deliveryFence < 1
	) {
		throw new TypeError("Conversation dispatch lease is invalid");
	}
}

export function requireLeaseDuration(value: number) {
	if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
		throw new TypeError("Conversation dispatch lease duration is invalid");
	}
}

export function requireTransition(
	transition: ConversationDispatchStateTransitionV1,
) {
	if (!transition || typeof transition !== "object") {
		throw new TypeError("Conversation dispatch transition is invalid");
	}
	if (
		transition.executionStatus !== undefined &&
		![
			"submitted",
			"processing",
			"unknown",
			"completed",
			"failed",
			"cancelled",
		].includes(transition.executionStatus)
	) {
		throw new TypeError("Conversation dispatch transition is invalid");
	}
	if (
		transition.conversationStatus !== undefined &&
		!["ready", "active", "unavailable"].includes(transition.conversationStatus)
	) {
		throw new TypeError("Conversation dispatch transition is invalid");
	}
}
