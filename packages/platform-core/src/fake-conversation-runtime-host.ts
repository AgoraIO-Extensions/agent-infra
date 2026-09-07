import { createHash } from "node:crypto";

import {
	type ConversationRuntimeDispatchRequestV1,
	type ConversationRuntimeEventRequestV1,
	type ConversationRuntimeEventV1,
	ConversationRuntimeHostError,
	type ConversationRuntimeHostPortV1,
	type ConversationRuntimeOperationResponseV1,
} from "./conversation-dispatch.js";

function digest(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
		const requestDigest = digest({
			operation: request.operation,
			agentId: request.agentId,
			actorId: request.actorId,
			channelId: request.channelId,
			conversationId: request.conversationId,
			executionId: request.executionId,
			turnId: request.turnId,
			messageId: request.messageId,
			stopRequestId: request.stopRequestId,
			sessionGeneration: request.sessionGeneration,
			selection: request.selection,
			input: request.input,
		});
		const existing = this.#operations.get(operationKey);
		if (existing) {
			if (existing.digest !== requestDigest) {
				throw new ConversationRuntimeHostError(
					"RUNTIME_OPERATION_CONFLICT",
					false,
				);
			}
			return structuredClone(existing.response);
		}
		this.#sideEffects += 1;
		const response = {
			schemaVersion: request.selection ? (2 as const) : (1 as const),
			hostSessionRef: `host-session-${request.conversationId}`,
			operationId,
			result: structuredClone(this.#nextResult),
		};
		this.#operations.set(operationKey, { digest: requestDigest, response });
		return structuredClone(response);
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
