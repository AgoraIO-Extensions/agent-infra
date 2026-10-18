import {
	BrowserCommandAcceptedProjectionV1Schema,
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
	commandBrowserHandoffOrSideEffect,
	createConversation,
	regenerateAnswer,
	stopExecution,
	submitMessage,
	updateConversationModelSelection,
} from "../../pilot/generated/sdk.gen.js";
import type {
	BrowserCommandAcceptedProjectionV1,
	BrowserCommandRequestV1,
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
export type NativeCapabilityCommandBody = Readonly<{
	capabilityId: string;
	directoryRevision: string;
	parameters: string;
}>;
export type BrowserCommandBody = BrowserCommandRequestV1;
export type ConversationCommand =
	| {
			kind: "create";
			body: CreateConversationData["body"];
	  }
	| { kind: "message"; body: SubmitMessageData["body"] }
	| { kind: "stop"; body: StopExecutionData["body"] }
	| { kind: "regenerate"; body: RegenerateAnswerData["body"] }
	| { kind: "selection"; body: UpdateConversationModelSelectionData["body"] }
	| { kind: "native-capability"; body: NativeCapabilityCommandBody }
	| { kind: "browser"; body: BrowserCommandBody };
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
	| {
			kind: "native-accepted";
			executionId: string;
			capabilityId: string;
			outcome: "accepted" | "replayed";
	  }
	| {
			kind: "native-rejected";
			outcome: string;
			/** 契约内的拒绝原因（如 authorization_lost）；只用于映射可读文案。 */
			reason?: string;
	  }
	| {
			kind: "browser-accepted";
			receipt: BrowserCommandAcceptedProjectionV1;
	  }
	| {
			kind: "denied";
			code?: PilotProtocolErrorV1["code"];
			/** 404 同时表示「没有权限/不存在」和「Agent 已停止」，服务端有意不区分；
			 * 页面要先重新读取 Agent 状态再决定是否按失去访问权限处理（#2570）。 */
			ambiguous?: true;
	  }
	| {
			kind: "rejected";
			code: PilotProtocolErrorV1["code"];
			retryable: boolean;
	  };

function failure(status?: number, error?: unknown): ConversationCommandResult {
	const parsed = PilotProtocolErrorV1Schema.safeParse(error);
	const code = parsed.success ? parsed.data.code : undefined;
	if (
		(status !== undefined && [401, 403].includes(status)) ||
		code === "AUTHENTICATION_REQUIRED" ||
		code === "AUTHORIZATION_REVOKED"
	)
		return { kind: "denied", ...(code ? { code } : {}) };
	if (status === 404)
		return { kind: "denied", ...(code ? { code } : {}), ambiguous: true };
	// A runtime-unavailable response is a deliberate pre-acceptance refusal
	// (the API uses 503 for this protocol code), so surface it as retryable
	// instead of implying that the message may have been accepted (#1607).
	if (status === undefined || !parsed.success)
		return { kind: "unknown", ...(code ? { code } : {}) };
	if (status >= 500 && code !== "RUNTIME_UNAVAILABLE")
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
			signal: AbortSignal.any([signal]),
			responseStyle: "fields" as const,
			throwOnError: false as const,
		};
		let result:
			| Awaited<ReturnType<typeof createConversation<false>>>
			| Awaited<ReturnType<typeof submitMessage<false>>>;
		if (command.kind === "native-capability") {
			if (!target.conversationId) return { kind: "unknown" };
			const response = await client.post<unknown, unknown, false>({
				...options,
				url: "/api/v2/conversations/{conversationId}/native-capability/invoke",
				path: { conversationId: target.conversationId },
				body: command.body,
			});
			const payload = (response.data ?? response.error) as
				| {
						outcome?: string;
						reason?: string;
						result?: { executionId?: string; capabilityId?: string };
				  }
				| undefined;
			if (
				response.response?.status === 202 &&
				(payload?.outcome === "accepted" || payload?.outcome === "replayed") &&
				typeof payload.result?.executionId === "string" &&
				typeof payload.result.capabilityId === "string"
			)
				return {
					kind: "native-accepted",
					executionId: payload.result.executionId,
					capabilityId: payload.result.capabilityId,
					outcome: payload.outcome,
				};
			if (payload?.outcome === "unknown") return { kind: "unknown" };
			if (typeof payload?.outcome === "string")
				return {
					kind: "native-rejected",
					outcome: payload.outcome,
					...(typeof payload.reason === "string"
						? { reason: payload.reason }
						: {}),
				};
			return { kind: "unknown" };
		}
		if (command.kind === "browser") {
			if (!target.conversationId) return { kind: "unknown" };
			const response = await commandBrowserHandoffOrSideEffect({
				...options,
				path: { conversationId: target.conversationId },
				body: command.body,
			});
			if (response.response?.status !== 202 || !response.data)
				return failure(response.response?.status, response.error);
			const parsed = BrowserCommandAcceptedProjectionV1Schema.safeParse(
				response.data,
			);
			if (
				!parsed.success ||
				parsed.data.conversationId !== target.conversationId
			)
				return { kind: "unknown" };
			const expectedId =
				"handoffId" in command.body
					? command.body.handoffId
					: command.body.confirmationId;
			const receiptId =
				"handoffId" in parsed.data
					? parsed.data.handoffId
					: parsed.data.confirmationId;
			if (
				parsed.data.command !== command.body.command ||
				receiptId !== expectedId
			)
				return { kind: "unknown" };
			return { kind: "browser-accepted", receipt: parsed.data };
		}
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
