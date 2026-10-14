import {
	type RuntimeBrowserHandoffRequestV3,
	RuntimeBrowserHandoffRequestV3Schema,
	type RuntimeBrowserHandoffResponseV3,
	RuntimeBrowserHandoffResponseV3Schema,
} from "@agent-infra/contracts/runtime";
import type {
	ConversationBrowserHandoffBindingV1,
	ConversationBrowserHandoffEventV1,
	ConversationEventDecisionV1,
	ConversationEventUseCaseV1,
} from "@agent-infra/platform-core";

export type BrowserHandoffRuntimeClientV1 = Readonly<{
	browserHandoff: (
		request: RuntimeBrowserHandoffRequestV3,
		signal?: AbortSignal,
	) => Promise<RuntimeBrowserHandoffResponseV3>;
}>;

export type BrowserHandoffEventInputV1 = Readonly<{
	request: RuntimeBrowserHandoffRequestV3;
	response: RuntimeBrowserHandoffResponseV3;
	occurredAt: string;
	adapterEventKeyPrefix: string;
	runtimeCursorPrefix: string;
}>;

export type BrowserHandoffDispatchInputV1 = Readonly<{
	request: RuntimeBrowserHandoffRequestV3;
	occurredAt: string;
	adapterEventKeyPrefix: string;
	runtimeCursorPrefix: string;
	signal?: AbortSignal;
}>;

function unavailable(): never {
	throw new Error("BROWSER_HANDOFF_EVENT_UNAVAILABLE");
}

function bindingFromRequest(
	request: RuntimeBrowserHandoffRequestV3,
): ConversationBrowserHandoffBindingV1 {
	const runtime = request.handoff.runtime;
	if (
		runtime.subjectId !== request.principal.id ||
		runtime.agentId !== request.agentId ||
		runtime.conversationId !== request.conversationId ||
		runtime.executionId !== request.executionId ||
		runtime.sessionGeneration !== request.sessionGeneration ||
		request.operation.kind !== "execution" ||
		request.operation.id !== request.executionId ||
		request.operation.deliveryFence !== runtime.resourceFence ||
		request.operation.executionDeliveryFence !== runtime.resourceFence
	) {
		throw new Error("BROWSER_HANDOFF_BINDING_CONFLICT");
	}
	if (
		request.handoff.kind === "take-over" &&
		(request.handoff.subjectId !== runtime.subjectId ||
			request.handoff.operatorId !== request.principal.id)
	) {
		throw new Error("BROWSER_HANDOFF_OPERATOR_CONFLICT");
	}
	if (
		(request.handoff.kind === "return-to-agent" ||
			request.handoff.kind === "take-over") &&
		request.handoff.operatorId !== request.principal.id
	) {
		throw new Error("BROWSER_HANDOFF_OPERATOR_CONFLICT");
	}
	return {
		subjectId: runtime.subjectId,
		agentId: runtime.agentId,
		conversationId: runtime.conversationId,
		executionId: runtime.executionId,
		sessionGeneration: runtime.sessionGeneration,
		resourceFence: runtime.resourceFence,
		workloadRevision: runtime.workloadRevision,
		imageDigest: runtime.imageDigest,
		capabilityVersion: runtime.capabilityVersion,
		pageRevision: runtime.pageRevision,
	};
}

function safeTerminalReason(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return /^BROWSER_HANDOFF_[A-Z0-9_]+$/u.test(value)
		? value
		: "BROWSER_HANDOFF_UNAVAILABLE";
}

function eventFromResponse(
	request: RuntimeBrowserHandoffRequestV3,
	response: RuntimeBrowserHandoffResponseV3,
): ConversationBrowserHandoffEventV1 {
	const binding = bindingFromRequest(request);
	if (
		response.hostSessionRef !== request.hostSessionRef ||
		response.executionId !== request.executionId
	) {
		throw new Error("BROWSER_HANDOFF_RESPONSE_BINDING_CONFLICT");
	}
	const handoffId =
		response.record?.handoffId ??
		("handoffId" in request.handoff
			? request.handoff.handoffId
			: request.requestId);
	const reason =
		response.record?.reason ??
		(request.handoff.kind === "request"
			? request.handoff.reason
			: "human_judgment");
	const outcomeUnknown = response.outcome !== "accepted";
	// A non-accepted outcome may carry diagnostic record data, but that record
	// is never allowed to project requested/active state.
	const status = outcomeUnknown
		? "unknown"
		: (response.record?.status ?? "unknown");
	const requestedAt = response.record?.requestedAt ?? new Date(0).toISOString();
	const expiresAt = response.record?.expiresAt ?? new Date(0).toISOString();
	const operatorId = response.record?.operatorId;
	const terminalReason = outcomeUnknown
		? "BROWSER_HANDOFF_ACCEPTANCE_UNKNOWN"
		: (response.record?.terminalReason ?? "BROWSER_HANDOFF_RECORD_UNAVAILABLE");
	const addressedHandoff =
		request.handoff.kind === "take-over" ||
		request.handoff.kind === "return-to-agent"
			? request.handoff
			: undefined;
	if (
		(addressedHandoff !== undefined &&
			handoffId !== addressedHandoff.handoffId) ||
		(operatorId !== undefined &&
			addressedHandoff !== undefined &&
			operatorId !== addressedHandoff.operatorId)
	) {
		throw new Error("BROWSER_HANDOFF_RESPONSE_BINDING_CONFLICT");
	}
	return {
		type: "browser.handoff",
		handoffId,
		status: outcomeUnknown ? "unknown" : status,
		reason,
		requestedAt,
		expiresAt,
		...(operatorId === undefined ? {} : { operatorId }),
		...(safeTerminalReason(terminalReason) === undefined
			? {}
			: { terminalReason: safeTerminalReason(terminalReason) }),
		binding,
	};
}

function parseInput(input: BrowserHandoffEventInputV1): {
	readonly request: RuntimeBrowserHandoffRequestV3;
	readonly response: RuntimeBrowserHandoffResponseV3;
	readonly event: ConversationBrowserHandoffEventV1;
} {
	try {
		const request = RuntimeBrowserHandoffRequestV3Schema.parse(input.request);
		const rawOutcome =
			typeof input.response === "object" && input.response !== null
				? (input.response as { readonly outcome?: unknown }).outcome
				: undefined;
		const parsedResponse = RuntimeBrowserHandoffResponseV3Schema.parse({
			...input.response,
			outcome: rawOutcome === "unknown" ? "accepted" : rawOutcome,
		});
		const response = {
			...parsedResponse,
			...(rawOutcome === "unknown" ? { outcome: "unknown" as never } : {}),
		} as RuntimeBrowserHandoffResponseV3;
		if (
			typeof input.occurredAt !== "string" ||
			input.occurredAt.length === 0 ||
			typeof input.adapterEventKeyPrefix !== "string" ||
			input.adapterEventKeyPrefix.length === 0 ||
			typeof input.runtimeCursorPrefix !== "string" ||
			input.runtimeCursorPrefix.length === 0
		)
			return unavailable();
		return { request, response, event: eventFromResponse(request, response) };
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message === "BROWSER_HANDOFF_BINDING_CONFLICT" ||
				error.message === "BROWSER_HANDOFF_OPERATOR_CONFLICT" ||
				error.message === "BROWSER_HANDOFF_RESPONSE_BINDING_CONFLICT")
		)
			throw error;
		return unavailable();
	}
}

/**
 * Receives an authenticated Runtime V3 handoff result and persists the
 * normalized transition through the existing Conversation Event authority.
 * This adapter owns no queue, state store, URL, credential, cursor or ACK.
 */
export function createBrowserHandoffEventAdapterV1(input: {
	readonly runtime?: BrowserHandoffRuntimeClientV1;
	readonly events: ConversationEventUseCaseV1;
}) {
	const persist = async (request: BrowserHandoffEventInputV1) => {
		const parsed = parseInput(request);
		const status = parsed.event.status;
		let decision: ConversationEventDecisionV1;
		try {
			decision = await input.events.persist({
				schemaVersion: 1,
				conversationId: parsed.event.binding.conversationId,
				executionId: parsed.event.binding.executionId,
				sessionGeneration: parsed.event.binding.sessionGeneration,
				deliveryFence: parsed.event.binding.resourceFence,
				adapterEventKey: `${request.adapterEventKeyPrefix}:${status}`,
				runtimeCursor: `${request.runtimeCursorPrefix}:${status}`,
				occurredAt: request.occurredAt,
				event: parsed.event,
			});
		} catch {
			throw new Error("BROWSER_HANDOFF_EVENT_UNAVAILABLE");
		}
		if (decision.outcome === "stale")
			throw new Error("BROWSER_HANDOFF_EVENT_STALE");
		return {
			status,
			outcome: decision.outcome,
			event: decision.event,
		};
	};
	return {
		persist,
		async dispatch(request: BrowserHandoffDispatchInputV1) {
			if (!input.runtime)
				throw new Error("BROWSER_HANDOFF_EVENT_RUNTIME_UNAVAILABLE");
			let response: RuntimeBrowserHandoffResponseV3;
			try {
				response = await input.runtime.browserHandoff(
					request.request,
					request.signal,
				);
			} catch {
				throw new Error("BROWSER_HANDOFF_EVENT_UNAVAILABLE");
			}
			return persist({ ...request, response });
		},
	};
}
