import {
	CommandAcceptedProjectionV1Schema,
	ConversationProjectionV1Schema,
	CreateConversationRequestV1Schema,
	MessageCommandRequestV1Schema,
	ModelSelectionUpdateRequestV1Schema,
	PilotProtocolErrorV1Schema,
	RegenerateCommandRequestV1Schema,
	StopCommandRequestV1Schema,
} from "@agent-infra/contracts/pilot";
import type { Client } from "../../pilot/generated/client/index.js";
import {
	createConversation,
	regenerateAnswer,
	stopExecution,
	submitMessage,
	updateConversationModelSelection,
} from "../../pilot/generated/sdk.gen.js";
import type {
	CommandAcceptedProjectionV1,
	CreateConversationData,
	PilotProtocolErrorV1,
	RegenerateAnswerData,
	StopExecutionData,
	SubmitMessageData,
	UpdateConversationModelSelectionData,
} from "../../pilot/generated/types.gen.js";

export type ConversationCommandTarget = {
	agentId: string;
	conversationId?: string;
	executionId?: string;
};
export type ConversationCommand =
	| {
			kind: "create";
			body: CreateConversationData["body"];
	  }
	| { kind: "message"; body: SubmitMessageData["body"] }
	| { kind: "stop"; body: StopExecutionData["body"] }
	| { kind: "regenerate"; body: RegenerateAnswerData["body"] }
	| { kind: "selection"; body: UpdateConversationModelSelectionData["body"] };
export type ConversationCommandResult =
	| { kind: "created"; agentId: string; conversationId: string }
	| { kind: "accepted"; receipt: CommandAcceptedProjectionV1 }
	| {
			kind: "selection-updated";
			agentId: string;
			conversationId: string;
			modelOptionId: string | null;
			reasoningLevel: string | null;
	  }
	| { kind: "unknown"; code?: PilotProtocolErrorV1["code"] }
	| { kind: "denied"; code?: PilotProtocolErrorV1["code"] }
	| {
			kind: "rejected";
			code: PilotProtocolErrorV1["code"];
			retryable: boolean;
	  };

function failure(status?: number, error?: unknown): ConversationCommandResult {
	const parsed = PilotProtocolErrorV1Schema.safeParse(error);
	const code = parsed.success ? parsed.data.code : undefined;
	if (
		(status !== undefined && [401, 403, 404].includes(status)) ||
		code === "AUTHENTICATION_REQUIRED" ||
		code === "AUTHORIZATION_REVOKED"
	)
		return { kind: "denied", ...(code ? { code } : {}) };
	if (status === undefined || status >= 500 || !parsed.success)
		return { kind: "unknown", ...(code ? { code } : {}) };
	return {
		kind: "rejected",
		code: parsed.data.code,
		retryable: parsed.data.retryable,
	};
}

/** Only sanitized receipts leave this transport; request text and server error
 * messages must never become mutation variables, errors or cached results. */
export async function performConversationCommand(
	command: ConversationCommand,
	target: ConversationCommandTarget,
	idempotencyKey: string,
	client: Client,
	signal: AbortSignal,
): Promise<ConversationCommandResult> {
	try {
		const options = {
			client,
			headers: { "Idempotency-Key": idempotencyKey },
			signal,
			responseStyle: "fields" as const,
			throwOnError: false as const,
		};
		let result:
			| Awaited<ReturnType<typeof createConversation<false>>>
			| Awaited<ReturnType<typeof submitMessage<false>>>;
		if (command.kind === "create") {
			const body = CreateConversationRequestV1Schema.safeParse(command.body);
			if (!body.success)
				return { kind: "rejected", code: "INVALID_REQUEST", retryable: false };
			result = await createConversation({
				...options,
				path: { agentId: target.agentId },
				body: body.data,
			});
		} else if (command.kind === "stop") {
			const body = StopCommandRequestV1Schema.safeParse(command.body);
			if (
				!body.success ||
				!target.conversationId ||
				body.data.targetExecutionId !== target.executionId
			)
				return { kind: "rejected", code: "INVALID_REQUEST", retryable: false };
			result = await stopExecution({
				...options,
				path: { conversationId: target.conversationId },
				body: body.data,
			});
		} else if (command.kind === "regenerate") {
			const body = RegenerateCommandRequestV1Schema.safeParse(command.body);
			if (!body.success || !target.conversationId)
				return { kind: "rejected", code: "INVALID_REQUEST", retryable: false };
			result = await regenerateAnswer({
				...options,
				path: { conversationId: target.conversationId },
				body: body.data,
			});
		} else if (command.kind === "selection") {
			const body = ModelSelectionUpdateRequestV1Schema.safeParse(command.body);
			if (!body.success || !target.conversationId)
				return { kind: "rejected", code: "INVALID_REQUEST", retryable: false };
			result = await updateConversationModelSelection({
				...options,
				path: { conversationId: target.conversationId },
				body: body.data,
			});
		} else {
			const body = MessageCommandRequestV1Schema.safeParse(command.body);
			if (!body.success || !target.conversationId)
				return { kind: "rejected", code: "INVALID_REQUEST", retryable: false };
			result = await submitMessage({
				...options,
				path: { conversationId: target.conversationId },
				body: body.data,
			});
		}
		if (!result.data) return failure(result.response?.status, result.error);
		const expectedStatus =
			command.kind === "create"
				? 201
				: command.kind === "selection"
					? 200
					: 202;
		if (result.response?.status !== expectedStatus) return { kind: "unknown" };
		if (command.kind !== "create" && command.kind !== "selection") {
			const parsed = CommandAcceptedProjectionV1Schema.safeParse(result.data);
			if (
				parsed.success &&
				command.kind === "stop" &&
				parsed.data.executionId !== target.executionId
			)
				return { kind: "unknown" };
			return parsed.success
				? { kind: "accepted", receipt: parsed.data }
				: { kind: "unknown" };
		}
		const parsed = ConversationProjectionV1Schema.safeParse(result.data);
		if (!parsed.success || parsed.data.agentId !== target.agentId)
			return { kind: "unknown" };
		if (command.kind === "selection") {
			if (parsed.data.conversationId !== target.conversationId)
				return { kind: "unknown" };
			return {
				kind: "selection-updated",
				agentId: parsed.data.agentId,
				conversationId: parsed.data.conversationId,
				modelOptionId: parsed.data.selectedModelOptionId,
				reasoningLevel: parsed.data.selectedReasoningLevel,
			};
		}
		return {
			kind: "created",
			agentId: parsed.data.agentId,
			conversationId: parsed.data.conversationId,
		};
	} catch {
		return { kind: "unknown" };
	}
}
