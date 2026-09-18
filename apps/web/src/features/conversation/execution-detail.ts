import {
	ExecutionDetailProjectionV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import type { Client } from "../../pilot/generated-v2/client/index.js";
import { getExecutionDetailV2 } from "../../pilot/generated-v2/sdk.gen.js";

export type ConversationReadFailure = {
	kind: "authorization" | "network" | "service" | "http" | "invalid";
	status?: number;
};

export class ConversationReadError extends Error {
	constructor(readonly failure: ConversationReadFailure) {
		super("Conversation data is unavailable");
	}
}

export function httpFailure(status?: number): ConversationReadFailure {
	if (status === undefined) return { kind: "network" };
	if ([401, 403, 404].includes(status))
		return { kind: "authorization", status };
	if (status >= 500) return { kind: "service", status };
	return { kind: status >= 400 ? "http" : "invalid", status };
}

export function responseFailure(
	error: unknown,
	status?: number,
): ConversationReadFailure {
	const parsed = PilotProtocolErrorV1Schema.safeParse(error);
	if (
		parsed.success &&
		["AUTHENTICATION_REQUIRED", "AUTHORIZATION_REVOKED"].includes(
			parsed.data.code,
		)
	)
		return {
			kind: "authorization",
			...(status === undefined ? {} : { status }),
		};
	return httpFailure(status);
}

export async function loadExecutionDetail({
	conversationId,
	executionId,
	signal,
	client,
}: {
	conversationId: string;
	executionId: string;
	signal: AbortSignal;
	client?: Client;
}) {
	const result = await getExecutionDetailV2({
		client,
		path: { conversationId, executionId },
		signal,
		responseStyle: "fields",
		throwOnError: false,
	});
	// Query owns cancellation. A transport that ignores its signal must not
	// publish data or trigger a permission callback after a selection changes.
	signal.throwIfAborted();
	if (!result.data || result.response?.status !== 200)
		throw new ConversationReadError(
			responseFailure(result.error, result.response?.status),
		);
	const parsed = ExecutionDetailProjectionV2Schema.safeParse(result.data);
	if (
		!parsed.success ||
		parsed.data.conversationId !== conversationId ||
		parsed.data.executionId !== executionId ||
		parsed.data.events.some(
			(event) =>
				event.conversationId !== conversationId ||
				event.executionId !== executionId,
		)
	)
		throw new ConversationReadError({ kind: "invalid" });
	return parsed.data;
}
