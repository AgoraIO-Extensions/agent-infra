import { isTurnOperation } from "./conversation-dispatch-runtime.js";
import type {
	ConversationDispatchAuthorityV1,
	ConversationDispatchClaimV1,
	ConversationDispatchExecutionStatusV1,
	ConversationDispatchOperationV1,
	ConversationMetadataRecoveryV1,
	DispatchConversationCommandV1,
} from "./conversation-dispatch-types.js";
import {
	exactObject,
	invalidInput,
	nonNegativeInteger,
	nullableText,
	positiveInteger,
	text,
	unavailable,
} from "./conversation-dispatch-values.js";
import {
	type ConversationExecutionSourceV1,
	conversationExecutionSourceV1,
} from "./conversation-execution-types.js";
import type { ConversationGenerationIsolationV1 } from "./conversation-generation-isolation.js";
import {
	parseTaskPrincipalV1,
	type TaskPrincipalV1,
} from "./task-authorization.js";

export function parseConversationMetadataRecoveryV1(
	value: unknown,
): ConversationMetadataRecoveryV1 {
	const input = exactObject(value, ["id", "requestedAt", "originalStatus"]);
	if (input.originalStatus !== "succeeded" && input.originalStatus !== "failed")
		unavailable();
	return {
		id: text(input.id),
		requestedAt: positiveInteger(input.requestedAt),
		originalStatus: input.originalStatus,
	};
}

function operation(value: unknown): ConversationDispatchOperationV1 {
	if (
		value !== "conversation.turn.submit.v1" &&
		value !== "conversation.turn.regenerate.v1" &&
		value !== "conversation.turn.supplement.v1" &&
		value !== "conversation.turn.stop.v1"
	) {
		return unavailable();
	}
	return value;
}

function executionStatus(
	value: unknown,
): ConversationDispatchExecutionStatusV1 {
	if (
		value !== "waiting" &&
		value !== "submitted" &&
		value !== "processing" &&
		value !== "unknown" &&
		value !== "completed" &&
		value !== "failed" &&
		value !== "cancelled"
	) {
		return unavailable();
	}
	return value;
}

function principal(value: unknown): TaskPrincipalV1 {
	try {
		return parseTaskPrincipalV1(value);
	} catch {
		return unavailable();
	}
}

function executionSource(value: unknown): ConversationExecutionSourceV1 {
	if (
		value !== "web" &&
		value !== "wecom" &&
		value !== "platform-api" &&
		value !== "eval"
	)
		return unavailable();
	return value;
}

export function parseCommand(value: unknown): DispatchConversationCommandV1 {
	try {
		const input = exactObject(value, ["schemaVersion", "itemId", "workerId"]);
		if (input.schemaVersion !== 1) invalidInput();
		return {
			schemaVersion: 1,
			itemId: text(input.itemId),
			workerId: text(input.workerId),
		};
	} catch {
		return invalidInput();
	}
}

export function parseClaim(value: unknown): ConversationDispatchClaimV1 {
	const input = exactObject(
		value,
		[
			"schemaVersion",
			"itemId",
			"leaseOwner",
			"operation",
			"requestId",
			"traceId",
			"agentId",
			"actorId",
			"channelId",
			"conversationId",
			"executionId",
			"turnId",
			"messageId",
			"stopRequestId",
			"sessionGeneration",
			"deliveryFence",
			"executionDeliveryFence",
			"authorizationRevision",
			"modelConfigurationRevision",
			"modelOptionId",
			"reasoningLevel",
			"hostSessionRef",
			"runtimeCursor",
			"input",
			"executionStatus",
			"stopPending",
		],
		[
			"generationIsolation",
			"runtimeTerminalEventSeen",
			"metadataRecovery",
			"principal",
			"executionSource",
			"relayKeyBinding",
			"taskWaitOrder",
		],
	);
	if (
		input.schemaVersion !== 1 ||
		(input.runtimeTerminalEventSeen !== undefined &&
			(input.runtimeTerminalEventSeen !== true ||
				!["completed", "failed", "cancelled"].includes(
					String(input.executionStatus),
				) ||
				input.runtimeCursor === null))
	)
		return unavailable();
	const parsedOperation = operation(input.operation);
	const parsedPrincipal =
		input.principal === undefined
			? ({ kind: "user", id: text(input.actorId) } as const)
			: principal(input.principal);
	if (parsedPrincipal.id !== text(input.actorId)) return unavailable();
	let parsedExecutionSource: ConversationExecutionSourceV1 | undefined;
	if (input.executionSource !== undefined) {
		parsedExecutionSource = executionSource(input.executionSource);
		try {
			if (
				parsedExecutionSource !==
				conversationExecutionSourceV1(text(input.channelId))
			)
				return unavailable();
		} catch {
			return unavailable();
		}
	}
	let parsedRelayKeyBinding:
		| ConversationDispatchClaimV1["relayKeyBinding"]
		| undefined;
	if (input.relayKeyBinding !== undefined) {
		const key = exactObject(input.relayKeyBinding, [
			"purpose",
			"subjectId",
			"keyId",
			"keyVersion",
		]);
		if (key.purpose !== "personal" && key.purpose !== "agent-default")
			return unavailable();
		parsedRelayKeyBinding = {
			purpose: key.purpose,
			subjectId: text(key.subjectId),
			keyId: text(key.keyId),
			keyVersion: positiveInteger(key.keyVersion),
		};
		const expectedSubject =
			parsedRelayKeyBinding.purpose === "personal"
				? parsedPrincipal.id
				: text(input.agentId);
		if (parsedRelayKeyBinding.subjectId !== expectedSubject)
			return unavailable();
	}
	if (
		(parsedExecutionSource === undefined) !==
		(parsedRelayKeyBinding === undefined)
	)
		return unavailable();
	if (parsedExecutionSource && parsedRelayKeyBinding) {
		const personalSource =
			parsedExecutionSource === "web" || parsedExecutionSource === "wecom";
		if (
			(parsedRelayKeyBinding.purpose === "personal") !== personalSource ||
			(parsedRelayKeyBinding.purpose === "personal" &&
				parsedPrincipal.kind !== "user")
		)
			return unavailable();
	}
	const taskWaitOrder =
		input.taskWaitOrder === undefined
			? undefined
			: positiveInteger(input.taskWaitOrder);
	if (input.executionStatus === "waiting" && taskWaitOrder === undefined)
		return unavailable();
	const metadataRecovery =
		input.metadataRecovery === undefined
			? undefined
			: parseConversationMetadataRecoveryV1(input.metadataRecovery);
	if (
		metadataRecovery &&
		(!isTurnOperation(parsedOperation) ||
			!["completed", "failed", "cancelled"].includes(
				String(input.executionStatus),
			) ||
			!input.hostSessionRef ||
			!input.runtimeCursor)
	)
		unavailable();
	const messageId = nullableText(input.messageId);
	const stopRequestId = nullableText(input.stopRequestId);
	const modelConfigurationRevision =
		input.modelConfigurationRevision === null
			? null
			: positiveInteger(input.modelConfigurationRevision);
	const modelOptionId = nullableText(input.modelOptionId);
	const reasoningLevel = nullableText(input.reasoningLevel);
	const runtimeInput = (() => {
		if (input.input === null) return null;
		const value = exactObject(input.input, ["text", "attachments"]);
		if (!Array.isArray(value.attachments)) return unavailable();
		return {
			text: text(value.text, 65_536),
			attachments: value.attachments.map((entry) => text(entry)),
		};
	})();
	let generationIsolation: ConversationGenerationIsolationV1 | undefined;
	if (input.generationIsolation !== undefined) {
		const isolation = exactObject(input.generationIsolation, [
			"operationId",
			"controlRecordId",
			"originalPrincipal",
		]);
		const principal = exactObject(isolation.originalPrincipal, ["kind", "id"]);
		if (
			principal.kind !== parsedPrincipal.kind ||
			principal.id !== parsedPrincipal.id
		)
			unavailable();
		generationIsolation = {
			operationId: text(isolation.operationId),
			controlRecordId: text(isolation.controlRecordId),
			originalPrincipal: { ...parsedPrincipal },
		};
	}
	const isStop = parsedOperation === "conversation.turn.stop.v1";
	if (
		isStop !== (stopRequestId !== null) ||
		isStop !== (runtimeInput === null) ||
		isStop === (messageId !== null) ||
		new Set([
			modelConfigurationRevision === null,
			modelOptionId === null,
			reasoningLevel === null,
		]).size !== 1
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		...(input.principal !== undefined ? { principal: parsedPrincipal } : {}),
		...(parsedExecutionSource
			? { executionSource: parsedExecutionSource }
			: {}),
		...(parsedRelayKeyBinding
			? { relayKeyBinding: parsedRelayKeyBinding }
			: {}),
		...(taskWaitOrder !== undefined ? { taskWaitOrder } : {}),
		itemId: text(input.itemId),
		leaseOwner: text(input.leaseOwner),
		operation: parsedOperation,
		...(generationIsolation ? { generationIsolation } : {}),
		requestId: text(input.requestId),
		traceId: text(input.traceId),
		agentId: text(input.agentId),
		actorId: text(input.actorId),
		channelId: text(input.channelId),
		conversationId: text(input.conversationId),
		executionId: text(input.executionId),
		turnId: text(input.turnId),
		messageId,
		stopRequestId,
		sessionGeneration: positiveInteger(input.sessionGeneration),
		deliveryFence: positiveInteger(input.deliveryFence),
		executionDeliveryFence: nonNegativeInteger(input.executionDeliveryFence),
		authorizationRevision: text(input.authorizationRevision),
		modelConfigurationRevision,
		modelOptionId,
		reasoningLevel,
		hostSessionRef: nullableText(input.hostSessionRef),
		runtimeCursor: nullableText(input.runtimeCursor),
		...(input.runtimeTerminalEventSeen === true
			? { runtimeTerminalEventSeen: true as const }
			: {}),
		...(metadataRecovery ? { metadataRecovery } : {}),
		input: runtimeInput,
		executionStatus: executionStatus(input.executionStatus),
		stopPending:
			typeof input.stopPending === "boolean"
				? input.stopPending
				: unavailable(),
	};
}

export function parseAuthority(
	value: unknown,
	claim: ConversationDispatchClaimV1,
): ConversationDispatchAuthorityV1 {
	const input = exactObject(
		value,
		[
			"schemaVersion",
			"agentId",
			"actorId",
			"channelId",
			"conversationId",
			"executionId",
			"turnId",
			"sessionGeneration",
			"authorizationRevision",
			"runtimeGrant",
		],
		["controlOnly"],
	);
	if (
		input.schemaVersion !== 1 ||
		input.agentId !== claim.agentId ||
		input.actorId !== claim.actorId ||
		input.channelId !== claim.channelId ||
		input.conversationId !== claim.conversationId ||
		input.executionId !== claim.executionId ||
		input.turnId !== claim.turnId ||
		input.sessionGeneration !== claim.sessionGeneration ||
		input.authorizationRevision !== claim.authorizationRevision ||
		input.runtimeGrant === undefined ||
		(input.controlOnly !== undefined && input.controlOnly !== true)
	) {
		return unavailable();
	}
	return {
		schemaVersion: 1,
		agentId: claim.agentId,
		actorId: claim.actorId,
		channelId: claim.channelId,
		conversationId: claim.conversationId,
		executionId: claim.executionId,
		turnId: claim.turnId,
		sessionGeneration: claim.sessionGeneration,
		authorizationRevision: claim.authorizationRevision,
		runtimeGrant: input.runtimeGrant,
		...(input.controlOnly === true ? { controlOnly: true as const } : {}),
	};
}
