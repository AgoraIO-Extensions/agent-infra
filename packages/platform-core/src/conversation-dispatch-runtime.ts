import type {
	ConversationDispatchAuthorityV1,
	ConversationDispatchClaimV1,
	ConversationDispatchOperationV1,
	ConversationRuntimeDispatchOperationV1,
	ConversationRuntimeDispatchRequestV1,
	ConversationRuntimeEvent,
	ConversationRuntimeOperationResponseV1,
	ConversationRuntimeOperationResultV1,
	ConversationRuntimeStatusResponseV2,
	ConversationRuntimeStatusV1,
} from "./conversation-dispatch-types.js";
import {
	exactObject,
	text,
	unavailable,
} from "./conversation-dispatch-values.js";
import { parseConversationOperationFactV2 } from "./conversation-operation-facts.js";
import { isWorkspaceReferenceV1 } from "./file-authority.js";

function runtimeOperation(
	claim: ConversationDispatchClaimV1,
): ConversationRuntimeDispatchOperationV1 {
	if (claim.operation === "conversation.native-capability.invoke.v1")
		return "native-capability.invoke";
	if (claim.operation === "conversation.turn.supplement.v1") {
		return "turn.supplement" as const;
	}
	if (claim.operation === "conversation.turn.stop.v1")
		return "turn.stop" as const;
	return "turn.submit" as const;
}

export function isTurnOperation(operation: ConversationDispatchOperationV1) {
	return (
		operation === "conversation.turn.submit.v1" ||
		operation === "conversation.turn.regenerate.v1"
	);
}

export function isNativeCapabilityOperation(
	operation: ConversationDispatchOperationV1,
) {
	return operation === "conversation.native-capability.invoke.v1";
}

/** Runtime operations that produce durable event/status streams. */
export function isRuntimeEventOperation(
	operation: ConversationDispatchOperationV1,
) {
	return isTurnOperation(operation) || isNativeCapabilityOperation(operation);
}

export function operationId(claim: ConversationDispatchClaimV1): string {
	if (claim.operation === "conversation.native-capability.invoke.v1")
		return claim.executionId;
	if (claim.operation === "conversation.turn.supplement.v1") {
		return claim.messageId ?? unavailable();
	}
	if (claim.operation === "conversation.turn.stop.v1") {
		return claim.stopRequestId ?? unavailable();
	}
	return claim.executionId;
}

export function runtimeRequest(
	claim: ConversationDispatchClaimV1,
	authority: ConversationDispatchAuthorityV1,
): ConversationRuntimeDispatchRequestV1 {
	const base = {
		schemaVersion: 1 as const,
		operation: runtimeOperation(claim),
		requestId: claim.requestId,
		traceId: claim.traceId,
		agentId: claim.agentId,
		actorId: claim.actorId,
		channelId: claim.channelId,
		conversationId: claim.conversationId,
		executionId: claim.executionId,
		turnId: claim.turnId,
		sessionGeneration: claim.sessionGeneration,
		deliveryFence: claim.deliveryFence,
		...(claim.hostSessionRef ? { hostSessionRef: claim.hostSessionRef } : {}),
		runtimeGrant: authority.runtimeGrant,
	};
	if (claim.operation === "conversation.turn.stop.v1") {
		return {
			...base,
			operation: "turn.stop",
			stopRequestId: claim.stopRequestId ?? unavailable(),
			executionDeliveryFence: claim.executionDeliveryFence,
		};
	}
	if (claim.operation === "conversation.turn.supplement.v1") {
		return {
			...base,
			operation: "turn.supplement",
			messageId: claim.messageId ?? unavailable(),
			executionDeliveryFence: claim.executionDeliveryFence,
			input: claim.input ?? unavailable(),
		};
	}
	if (claim.operation === "conversation.native-capability.invoke.v1") {
		return {
			...base,
			operation: "native-capability.invoke",
			nativeCapability: claim.nativeCapability ?? unavailable(),
		};
	}
	return {
		...base,
		operation: "turn.submit",
		input: claim.input ?? unavailable(),
		...(claim.modelOptionId && claim.reasoningLevel
			? {
					selection: {
						schemaVersion: 1 as const,
						modelOptionId: claim.modelOptionId,
						reasoningLevel: claim.reasoningLevel,
					},
				}
			: {}),
	};
}

function runtimeStatus(value: unknown): ConversationRuntimeStatusV1 {
	if (
		value !== "idle" &&
		value !== "running" &&
		value !== "completed" &&
		value !== "failed" &&
		value !== "cancelled" &&
		value !== "unavailable" &&
		value !== "unknown"
	) {
		return unavailable();
	}
	return value;
}

export function parseRuntimeResponse(
	value: unknown,
	claim: ConversationDispatchClaimV1,
): ConversationRuntimeOperationResponseV1 {
	const input = exactObject(value, [
		"schemaVersion",
		"hostSessionRef",
		"operationId",
		"result",
	]);
	const expectedVersion =
		isTurnOperation(claim.operation) && claim.modelOptionId !== null ? 2 : 1;
	if (
		input.schemaVersion !== expectedVersion ||
		input.operationId !== operationId(claim)
	) {
		return unavailable();
	}
	const resultInput = exactObject(
		input.result,
		["outcome"],
		["status", "code", "message", "retryable"],
	);
	let result: ConversationRuntimeOperationResultV1;
	if (resultInput.outcome === "accepted") {
		if (
			resultInput.code !== undefined ||
			resultInput.message !== undefined ||
			resultInput.retryable !== undefined
		) {
			return unavailable();
		}
		result = { outcome: "accepted", status: runtimeStatus(resultInput.status) };
	} else if (resultInput.outcome === "busy") {
		if (
			resultInput.status !== undefined ||
			resultInput.code !== undefined ||
			resultInput.message !== undefined ||
			resultInput.retryable !== undefined
		) {
			return unavailable();
		}
		result = { outcome: "busy" };
	} else if (resultInput.outcome === "rejected") {
		const turnEnded =
			resultInput.code === "RUNTIME_TURN_NOT_ACTIVE" &&
			resultInput.message === "Runtime turn is no longer active";
		const unsupportedSelection =
			expectedVersion === 2 &&
			resultInput.code === "RUNTIME_MODEL_SELECTION_UNSUPPORTED" &&
			resultInput.message === "Runtime model selection is unsupported";
		// 原生会话被受理不明的 Turn 阻塞（ADR-0029）：只有 submit V2 及以上的结果枚举包含该成员，
		// V1 响应出现该码仍失败关闭。
		const sessionBlocked =
			expectedVersion === 2 &&
			resultInput.code === "RUNTIME_SESSION_BLOCKED" &&
			resultInput.message ===
				"Runtime session is blocked by an unconfirmed turn";
		if (
			resultInput.status !== undefined ||
			(!turnEnded && !unsupportedSelection && !sessionBlocked) ||
			resultInput.retryable !== false
		) {
			return unavailable();
		}
		result = {
			outcome: "rejected",
			code: resultInput.code as
				| "RUNTIME_TURN_NOT_ACTIVE"
				| "RUNTIME_MODEL_SELECTION_UNSUPPORTED"
				| "RUNTIME_SESSION_BLOCKED",
			message: resultInput.message as
				| "Runtime turn is no longer active"
				| "Runtime model selection is unsupported"
				| "Runtime session is blocked by an unconfirmed turn",
			retryable: false,
		};
	} else if (resultInput.outcome === "unknown") {
		if (
			resultInput.status !== undefined ||
			resultInput.code !== "RUNTIME_ACCEPTANCE_UNKNOWN" ||
			resultInput.message !==
				"Runtime command acceptance could not be confirmed" ||
			resultInput.retryable !== undefined
		) {
			return unavailable();
		}
		result = {
			outcome: "unknown",
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			message: "Runtime command acceptance could not be confirmed",
		};
	} else {
		return unavailable();
	}
	return {
		schemaVersion: expectedVersion,
		hostSessionRef: text(input.hostSessionRef),
		operationId: input.operationId,
		result,
	};
}

export function parseRuntimeStatusResponse(
	value: unknown,
	claim: ConversationDispatchClaimV1,
): ConversationRuntimeStatusResponseV2 {
	const input = exactObject(
		value,
		["schemaVersion", "hostSessionRef", "executionId", "outcome"],
		["status", "code", "operationOutcome"],
	);
	if (
		input.schemaVersion !== 2 ||
		(claim.hostSessionRef !== null &&
			input.hostSessionRef !== claim.hostSessionRef) ||
		(input.outcome === "found" &&
			(claim.hostSessionRef === null ||
				input.hostSessionRef !== claim.hostSessionRef)) ||
		input.executionId !== claim.executionId
	) {
		return unavailable();
	}
	if (
		input.outcome === "binding_found" &&
		claim.hostSessionRef === null &&
		Object.keys(input).length === 4 &&
		input.code === undefined &&
		input.status === undefined
	)
		return {
			schemaVersion: 2,
			hostSessionRef: text(input.hostSessionRef),
			executionId: claim.executionId,
			outcome: "binding_found",
		};
	if (
		input.outcome === "recovery_failed" &&
		input.code === "RUNTIME_SESSION_RECOVERY_FAILED" &&
		input.status === undefined
	)
		return {
			schemaVersion: 2,
			hostSessionRef: text(input.hostSessionRef),
			executionId: claim.executionId,
			outcome: "recovery_failed",
			code: "RUNTIME_SESSION_RECOVERY_FAILED",
		};
	if (input.code !== undefined) return unavailable();
	if (input.outcome === "not_found" && input.status === undefined) {
		return {
			schemaVersion: 2,
			hostSessionRef:
				input.hostSessionRef === null ? null : text(input.hostSessionRef),
			executionId: claim.executionId,
			outcome: "not_found",
		};
	}
	if (input.outcome !== "found" || input.status === undefined) {
		return unavailable();
	}
	return {
		schemaVersion: 2,
		hostSessionRef: text(input.hostSessionRef),
		executionId: claim.executionId,
		outcome: "found",
		status: runtimeStatus(input.status),
		...(input.operationOutcome === "busy"
			? { operationOutcome: "busy" as const }
			: input.operationOutcome === undefined
				? {}
				: unavailable()),
	};
}

export function parseRuntimeEvent(
	value: unknown,
	claim: ConversationDispatchClaimV1,
): ConversationRuntimeEvent {
	const input = exactObject(value, [
		"schemaVersion",
		"adapterEventKey",
		"executionId",
		"cursor",
		"occurredAt",
		"type",
		"payload",
	]);
	if (
		(input.schemaVersion !== 1 && input.schemaVersion !== 2) ||
		input.executionId !== claim.executionId
	) {
		return unavailable();
	}
	const base = {
		schemaVersion: 1 as const,
		adapterEventKey: text(input.adapterEventKey),
		executionId: claim.executionId,
		cursor: text(input.cursor),
		occurredAt: text(input.occurredAt, 128),
	};
	if (input.schemaVersion === 2) {
		if (input.type === "reasoning") {
			const payload = exactObject(input.payload, ["kind", "delta"]);
			if (payload.kind !== "raw" && payload.kind !== "summary")
				return unavailable();
			return {
				...base,
				schemaVersion: 2,
				type: "reasoning",
				payload: { kind: payload.kind, delta: text(payload.delta, 65_536) },
			};
		}
		if (input.type === "file") {
			// #3226：结果文件 V2 只比 V1 多一个规范化工作区路径，可为 null。
			const payload = exactObject(input.payload, [
				"fileId",
				"name",
				"mimeType",
				"sizeBytes",
				"workspaceReference",
			]);
			if (
				typeof payload.sizeBytes !== "number" ||
				!Number.isSafeInteger(payload.sizeBytes) ||
				payload.sizeBytes < 0 ||
				(payload.workspaceReference !== null &&
					!isWorkspaceReferenceV1(payload.workspaceReference))
			)
				return unavailable();
			return {
				...base,
				schemaVersion: 2,
				type: "file",
				payload: {
					fileId: text(payload.fileId),
					name: text(payload.name),
					mimeType: text(payload.mimeType, 255),
					sizeBytes: payload.sizeBytes,
					workspaceReference: payload.workspaceReference,
				},
			};
		}
		if (input.type !== "operation") return unavailable();
		return {
			...base,
			schemaVersion: 2,
			type: "operation",
			payload: parseConversationOperationFactV2(input.payload),
		};
	}
	if (input.type === "text") {
		const payload = exactObject(input.payload, ["delta"]);
		return {
			...base,
			type: "text",
			payload: { delta: text(payload.delta, 65_536) },
		};
	}
	if (input.type === "status") {
		const payload = exactObject(input.payload, ["status"]);
		return {
			...base,
			type: "status",
			payload: { status: runtimeStatus(payload.status) },
		};
	}
	if (input.type === "tool") {
		const payload = exactObject(input.payload, ["toolCallId", "name", "phase"]);
		if (
			payload.phase !== "started" &&
			payload.phase !== "completed" &&
			payload.phase !== "failed"
		) {
			return unavailable();
		}
		return {
			...base,
			type: "tool",
			payload: {
				toolCallId: text(payload.toolCallId),
				name: text(payload.name),
				phase: payload.phase,
			},
		};
	}
	if (input.type === "file") {
		const payload = exactObject(input.payload, [
			"fileId",
			"name",
			"mimeType",
			"sizeBytes",
		]);
		if (
			typeof payload.sizeBytes !== "number" ||
			!Number.isSafeInteger(payload.sizeBytes) ||
			payload.sizeBytes < 0
		) {
			return unavailable();
		}
		return {
			...base,
			type: "file",
			payload: {
				fileId: text(payload.fileId),
				name: text(payload.name),
				mimeType: text(payload.mimeType, 255),
				sizeBytes: payload.sizeBytes,
			},
		};
	}
	if (input.type === "completed") {
		const payload = exactObject(input.payload, ["status"]);
		if (
			payload.status !== "completed" &&
			payload.status !== "failed" &&
			payload.status !== "cancelled"
		) {
			return unavailable();
		}
		return { ...base, type: "completed", payload: { status: payload.status } };
	}
	if (input.type === "error") {
		const payload = exactObject(input.payload, [
			"code",
			"message",
			"retryable",
		]);
		const valid =
			(payload.code === "RUNTIME_EXECUTION_FAILED" &&
				payload.message === "Runtime execution failed" &&
				payload.retryable === false) ||
			(payload.code === "RUNTIME_DEPENDENCY_UNAVAILABLE" &&
				payload.message === "Runtime dependency is unavailable" &&
				payload.retryable === true);
		if (!valid) return unavailable();
		return {
			...base,
			type: "error",
			payload: {
				code: payload.code as
					| "RUNTIME_EXECUTION_FAILED"
					| "RUNTIME_DEPENDENCY_UNAVAILABLE",
				message: payload.message as
					| "Runtime execution failed"
					| "Runtime dependency is unavailable",
				retryable: payload.retryable as boolean,
			},
		};
	}
	return unavailable();
}
