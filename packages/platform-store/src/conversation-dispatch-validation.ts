import {
	type BrowserHandoffCommandV1,
	type ConversationDispatchClaimV1,
	type ConversationDispatchExecutionStatusV1,
	type ConversationDispatchOperationV1,
	type ConversationDispatchStateTransitionV1,
	type ConversationMetadataRecoveryV1,
	type NativeCapabilityInvocationBindingV6,
	type NativeTextInputV1,
	nativeCapabilityParametersDigestV1,
	parseConversationMetadataRecoveryV1,
	parseNativeCapabilityAttachmentsV1,
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
	const isNativeCapability =
		operation === "conversation.native-capability.invoke.v1" ||
		operation === "conversation.native-capability.invoke.v2";
	const isBrowserHandoff = operation === "conversation.browser.handoff.v1";
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
		isBrowserHandoff
			? [
					"schemaVersion",
					"conversationId",
					"agentId",
					"actorId",
					"channelId",
					"executionId",
					"turnId",
					"sessionGeneration",
					"deliveryFence",
					"command",
				]
			: isStop
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
	if (isBrowserHandoff) {
		const command = input.command;
		if (
			Object.keys(input).length !== expected.size ||
			Object.keys(input).some((key) => !expected.has(key)) ||
			input.schemaVersion !== 1 ||
			!validText(input.conversationId) ||
			!validText(input.agentId) ||
			!validText(input.actorId) ||
			!validText(input.channelId) ||
			!validText(input.executionId) ||
			!validText(input.turnId) ||
			safeCounter(input.sessionGeneration, 1) === undefined ||
			safeCounter(input.deliveryFence, 0) === undefined ||
			!command ||
			typeof command !== "object" ||
			Array.isArray(command)
		)
			return undefined;
		const commandRecord = command as Record<string, unknown>;
		const commandName = commandRecord.command;
		const isHandoff =
			commandName === "take_over" ||
			commandName === "return_to_agent" ||
			commandName === "revoke";
		const isPause = commandName === "pause";
		const isSideEffect =
			commandName === "confirm_side_effect" ||
			commandName === "reject_side_effect" ||
			commandName === "cancel_side_effect";
		const validCommand =
			commandRecord.schemaVersion === 1 &&
			(isHandoff
				? Object.keys(commandRecord).length === 3 &&
					validText(commandRecord.handoffId) &&
					!Object.hasOwn(commandRecord, "confirmationId")
				: isPause
					? Object.keys(commandRecord).length === 3 &&
						validText(commandRecord.handoffId) &&
						!Object.hasOwn(commandRecord, "confirmationId")
					: isSideEffect &&
						Object.keys(commandRecord).length === 3 &&
						validText(commandRecord.confirmationId) &&
						!Object.hasOwn(commandRecord, "handoffId"));
		if (!validCommand) return undefined;
		const browserCommand = commandRecord as BrowserHandoffCommandV1;
		return {
			schemaVersion: 1,
			conversationId: input.conversationId as string,
			agentId: input.agentId as string,
			actorId: input.actorId as string,
			channelId: input.channelId as string,
			executionId: input.executionId as string,
			messageId: null,
			turnId: input.turnId as string,
			sessionGeneration: safeCounter(input.sessionGeneration, 1) as number,
			deliveryFence: safeCounter(input.deliveryFence, 0) as number,
			stopRequestId: null,
			modelConfigurationRevision: null,
			modelOptionId: null,
			reasoningLevel: null,
			browserHandoff: browserCommand,
		};
	}
	if (isNativeCapability) {
		if (operation === "conversation.native-capability.invoke.v2") {
			const binding =
				input as unknown as NativeCapabilityInvocationBindingV6 & {
					readonly requestId?: unknown;
					readonly traceId?: unknown;
					readonly idempotencyKey?: unknown;
				};
			if (
				binding.schemaVersion !== 2 ||
				!binding ||
				!binding.operation ||
				binding.operation.kind !== "execution" ||
				!validText(binding.operation.id) ||
				binding.operation.id !== binding.executionId ||
				!validText(binding.executionId) ||
				binding.executionId !== input.executionId ||
				!validText(binding.conversationId) ||
				binding.conversationId !== input.conversationId ||
				!validText(binding.capabilityId) ||
				!validText(binding.parametersDigest) ||
				!validText(binding.directoryRevision) ||
				!validText(binding.capabilitySourceVersion) ||
				!validText(binding.requestDigest) ||
				!validText(binding.operationDigest) ||
				binding.executionStatus !== "submitted" ||
				!validText(binding.requestId) ||
				!validText(binding.traceId) ||
				!validText(binding.idempotencyKey) ||
				!validText(binding.hostSessionRef)
			)
				return undefined;
			return {
				schemaVersion: 1,
				conversationId: input.conversationId as string,
				executionId: input.executionId as string,
				messageId: null,
				turnId: input.turnId as string,
				sessionGeneration: safeCounter(input.sessionGeneration, 1) as number,
				stopRequestId: null,
				modelConfigurationRevision: null,
				modelOptionId: null,
				reasoningLevel: null,
				nativeCapabilityV6:
					binding as ConversationPayload["nativeCapabilityV6"],
			};
		}
		const capabilityId = input.capabilityId;
		const capabilityKind = input.capabilityKind;
		const directoryRevision = input.directoryRevision;
		const capabilitySourceVersion = input.capabilitySourceVersion;
		const parameters = input.parameters;
		const parametersDigest = input.parametersDigest;
		const hasAttachments = Object.hasOwn(input, "attachments");
		let attachments: readonly NativeTextInputV1[] | undefined;
		if (hasAttachments) {
			// Attachments are Invocation V2-only and Skill-only. The accepted facts
			// are replayed from the persisted payload, never re-read from files.
			if (capabilityKind !== "skill") return undefined;
			try {
				attachments = parseNativeCapabilityAttachmentsV1(input.attachments);
			} catch {
				return undefined;
			}
		}
		if (
			Object.keys(input).length !== (hasAttachments ? 15 : 14) ||
			input.schemaVersion !== 1 ||
			!validText(input.conversationId) ||
			!validText(input.executionId) ||
			!validText(input.agentId) ||
			!validText(input.actorId) ||
			!validText(input.channelId) ||
			!validText(input.turnId) ||
			!validText(capabilityId) ||
			(capabilityKind !== "command" && capabilityKind !== "skill") ||
			!validText(directoryRevision) ||
			!validText(capabilitySourceVersion) ||
			!(parameters === "" || validText(parameters, 16 * 1024)) ||
			!validText(parametersDigest) ||
			!/^[a-f0-9]{64}$/.test(String(directoryRevision)) ||
			!/^[a-f0-9]{64}$/.test(String(parametersDigest)) ||
			parametersDigest !==
				nativeCapabilityParametersDigestV1(String(parameters))
		)
			return undefined;
		const sessionGeneration = safeCounter(input.sessionGeneration, 1);
		if (sessionGeneration === undefined) return undefined;
		return {
			schemaVersion: 1,
			conversationId: input.conversationId as string,
			executionId: input.executionId as string,
			messageId: null,
			turnId: input.turnId as string,
			sessionGeneration,
			stopRequestId: null,
			modelConfigurationRevision: null,
			modelOptionId: null,
			reasoningLevel: null,
			nativeCapability: {
				agentId: input.agentId as string,
				actorId: input.actorId as string,
				channelId: input.channelId as string,
				turnId: input.turnId as string,
				capabilityId: capabilityId as string,
				capabilityKind,
				directoryRevision: directoryRevision as string,
				capabilitySourceVersion: capabilitySourceVersion as string,
				parameters: parameters as string,
				parametersDigest: parametersDigest as string,
				...(attachments ? { attachments } : {}),
			},
		};
	}
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

/** A submit or native invocation owns the Execution and its durable event stream. */
export function isExecutionOperation(
	operation: ConversationDispatchOperationV1,
) {
	return (
		isTurn(operation) ||
		operation === "conversation.native-capability.invoke.v1" ||
		operation === "conversation.native-capability.invoke.v2"
	);
}

export function isBrowserHandoff(operation: ConversationDispatchOperationV1) {
	return operation === "conversation.browser.handoff.v1";
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
	if (
		claim.operation === "conversation.browser.handoff.v1" &&
		claim.browserHandoff === undefined
	)
		throw new TypeError("Conversation Browser handoff claim is invalid");
	if (
		(claim.executionSource === undefined) !==
		(claim.relayKeyBinding === undefined)
	) {
		throw new TypeError("Conversation dispatch key binding is invalid");
	}
	if (claim.relayKeyBinding) {
		const { purpose, subjectId, keyId, keyVersion } = claim.relayKeyBinding;
		if (
			(claim.executionSource !== "web" &&
				claim.executionSource !== "wecom" &&
				claim.executionSource !== "platform-api" &&
				claim.executionSource !== "eval") ||
			!validText(subjectId) ||
			!validText(keyId) ||
			!Number.isSafeInteger(keyVersion) ||
			keyVersion < 1 ||
			(claim.executionSource === "web" || claim.executionSource === "wecom"
				? purpose !== "personal" || subjectId !== claim.actorId
				: purpose !== "agent-default" || subjectId !== claim.agentId)
		) {
			throw new TypeError("Conversation dispatch key binding is invalid");
		}
	}
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
