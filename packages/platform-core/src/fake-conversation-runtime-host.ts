import { createHash } from "node:crypto";

import {
	type ConversationRuntimeDispatchRequestV1,
	type ConversationRuntimeEventRequestV1,
	type ConversationRuntimeEventV1,
	ConversationRuntimeHostError,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeOperationResponseV1,
	type ConversationRuntimeStatusRequestV2,
} from "./conversation-dispatch.js";

function digest(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function turnDigest(
	request:
		| ConversationRuntimeDispatchRequestV1
		| ConversationRuntimeStatusRequestV2,
) {
	const input =
		"recovery" in request
			? request.recovery
			: { input: request.input, selection: request.selection };
	return digest({
		kind: "submit-turn",
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		input: input.input,
		...(input.selection ? { selection: input.selection } : {}),
	});
}

function operationDigest(request: ConversationRuntimeDispatchRequestV1) {
	if (request.operation === "turn.submit") return turnDigest(request);
	return digest({
		kind: request.operation === "turn.supplement" ? "supplement" : "stop",
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		...(request.messageId ? { messageId: request.messageId } : {}),
		...(request.stopRequestId ? { stopRequestId: request.stopRequestId } : {}),
		...(request.input ? { input: request.input } : {}),
	});
}

export class FakeConversationRuntimeHostV1
	implements ConversationRuntimeHostPortV1
{
	readonly #operations = new Map<
		string,
		{
			readonly digest: string;
			readonly response: ConversationRuntimeOperationResponseV1;
		}
	>();
	readonly #highestFences = new Map<string, number>();
	#events: readonly ConversationRuntimeEventV1[] = [];
	#nextResult: ConversationRuntimeOperationResponseV1["result"] = {
		outcome: "accepted",
		status: "running",
	};
	#failNext: ConversationRuntimeHostError | undefined;
	#sideEffects = 0;
	#acknowledgedEvents = 0;

	setResult(result: ConversationRuntimeOperationResponseV1["result"]) {
		this.#nextResult = structuredClone(result);
	}

	setEvents(events: readonly ConversationRuntimeEventV1[]) {
		this.#events = structuredClone(events);
	}

	failNext(code = "RUNTIME_UNAVAILABLE", retryable = true) {
		this.#failNext = new ConversationRuntimeHostError(code, retryable);
	}

	async dispatch(request: ConversationRuntimeDispatchRequestV1) {
		if (this.#failNext) {
			const error = this.#failNext;
			this.#failNext = undefined;
			throw error;
		}
		const operationId =
			request.messageId ?? request.stopRequestId ?? request.executionId;
		const operationKey = `${request.agentId}\0${request.conversationId}\0${operationId}`;
		const requestDigest = operationDigest(request);
		const existing = this.#operations.get(operationKey);
		const highestFence = this.#highestFences.get(operationKey) ?? 0;
		if (existing) {
			if (request.deliveryFence < highestFence) {
				throw new ConversationRuntimeHostError("RUNTIME_FENCE_STALE", false);
			}
			if (existing.digest !== requestDigest) {
				throw new ConversationRuntimeHostError(
					"RUNTIME_OPERATION_CONFLICT",
					false,
				);
			}
			this.#highestFences.set(
				operationKey,
				Math.max(highestFence, request.deliveryFence),
			);
			return structuredClone(existing.response);
		}
		if (request.deliveryFence <= highestFence) {
			throw new ConversationRuntimeHostError("RUNTIME_FENCE_STALE", false);
		}
		this.#sideEffects += 1;
		const response = {
			schemaVersion: request.selection ? (2 as const) : (1 as const),
			hostSessionRef: `host-session-${request.conversationId}`,
			operationId,
			result: structuredClone(this.#nextResult),
		};
		this.#highestFences.set(operationKey, request.deliveryFence);
		this.#operations.set(operationKey, { digest: requestDigest, response });
		return structuredClone(response);
	}

	async recoverStatus(request: ConversationRuntimeStatusRequestV2) {
		const operationKey = `${request.agentId}\0${request.conversationId}\0${request.executionId}`;
		if (request.hostSessionRef !== `host-session-${request.conversationId}`) {
			throw new ConversationRuntimeHostError(
				"RUNTIME_SESSION_BINDING_MISMATCH",
				false,
			);
		}
		const highestFence = this.#highestFences.get(operationKey) ?? 0;
		if (request.deliveryFence < highestFence) {
			throw new ConversationRuntimeHostError("RUNTIME_FENCE_STALE", false);
		}
		const operation = this.#operations.get(operationKey);
		if (!operation) {
			this.#highestFences.set(operationKey, request.deliveryFence);
			return {
				schemaVersion: 2 as const,
				hostSessionRef: request.hostSessionRef,
				executionId: request.executionId,
				outcome: "not_found" as const,
			};
		}
		if (operation.digest !== turnDigest(request)) {
			throw new ConversationRuntimeHostError(
				"RUNTIME_OPERATION_CONFLICT",
				false,
			);
		}
		this.#highestFences.set(
			operationKey,
			Math.max(highestFence, request.deliveryFence),
		);
		return {
			schemaVersion: 2 as const,
			hostSessionRef: request.hostSessionRef,
			executionId: request.executionId,
			outcome: "found" as const,
			status:
				operation.response.result.outcome === "accepted"
					? operation.response.result.status
					: ("unknown" as const),
		};
	}

	async *events(request: ConversationRuntimeEventRequestV1) {
		const start = request.afterCursor
			? this.#events.findIndex(
					(event) => event.cursor === request.afterCursor,
				) + 1
			: 0;
		for (const event of this.#events.slice(Math.max(0, start))) {
			yield structuredClone(event);
			this.#acknowledgedEvents += 1;
		}
	}

	sideEffectCount() {
		return this.#sideEffects;
	}

	acknowledgedEventCount() {
		return this.#acknowledgedEvents;
	}
}
