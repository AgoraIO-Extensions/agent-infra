import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

export function currentExecutionEvents(detail, conversationId, executionId) {
	if (
		!detail ||
		detail.conversation?.conversationId !== conversationId ||
		!Array.isArray(detail.events) ||
		detail.events.length === 0 ||
		typeof executionId !== "string" ||
		executionId.length === 0
	)
		return null;

	const eventIds = new Set();
	const currentEvents = [];
	for (const event of detail.events) {
		if (
			!event ||
			typeof event.eventId !== "string" ||
			event.eventId.length === 0 ||
			eventIds.has(event.eventId) ||
			event.conversationId !== conversationId ||
			typeof event.executionId !== "string" ||
			event.executionId.length === 0
		)
			return null;

		eventIds.add(event.eventId);
		if (event.executionId === executionId) currentEvents.push(event);
	}

	return currentEvents.length > 0 ? currentEvents : null;
}

export function currentExecutionFrames(events, frames) {
	if (!Array.isArray(events) || !Array.isArray(frames)) return [];
	const eventIds = new Set(events.map((event) => event.eventId));
	return frames.filter((frame) => frame && eventIds.has(frame.id));
}

/** Current persisted events identify the first model start; browser time includes delivery latency. */
export function modelStartObservationMs(events, frames, clickedAt) {
	if (
		!Array.isArray(events) ||
		!Array.isArray(frames) ||
		!Number.isFinite(clickedAt) ||
		clickedAt < 0
	)
		return null;
	const started = events.find(
		(event) =>
			event?.type === "execution.operation" &&
			event.payload?.kind === "model" &&
			event.payload.phase === "started",
	);
	if (
		typeof started?.eventId !== "string" ||
		!started.eventId ||
		typeof started.executionId !== "string" ||
		!started.executionId
	)
		return null;
	const observed = frames.filter(
		(frame) =>
			frame?.id === started.eventId &&
			frame.executionId === started.executionId &&
			frame.type === "execution.operation",
	);
	if (
		observed.length === 0 ||
		observed.some((frame) => !Number.isFinite(frame.at) || frame.at < clickedAt)
	)
		return null;
	return Math.min(...observed.map((frame) => frame.at)) - clickedAt;
}

const pageTime = (value) => Number.isFinite(value) && value >= 0;
const pageInterval = (from, to) =>
	pageTime(from) && pageTime(to) && from <= to ? to - from : null;

/**
 * Same-page-clock intervals around one turn (#3923). `requests` are the page's
 * own create/message POSTs; only one 201 create and one 202 message count.
 * These are browser observations, never server queue or preparation facts.
 */
export function turnStageTimings({
	clickedAt,
	firstTurn,
	requests,
	modelStartAt,
	firstTextAt,
}) {
	const only = (kind, status) => {
		if (!pageTime(clickedAt) || !Array.isArray(requests)) return null;
		const matches = requests.filter(
			(request) => request?.kind === kind && request.status === status,
		);
		const [request] = matches;
		return matches.length === 1 &&
			request.sentAt >= clickedAt &&
			pageInterval(request.sentAt, request.respondedAt) !== null
			? request
			: null;
	};
	const message = only("message", 202);
	const create = firstTurn ? only("create", 201) : null;
	return {
		browserClickToConversationCreatedMs: create
			? create.respondedAt - clickedAt
			: null,
		browserConversationCreatedToMessageSentMs:
			create && message
				? pageInterval(create.respondedAt, message.sentAt)
				: null,
		browserMessageSentToAcceptedMs: message
			? message.respondedAt - message.sentAt
			: null,
		browserAcceptedToModelStartObservedMs: message
			? pageInterval(message.respondedAt, modelStartAt)
			: null,
		browserModelStartObservedToFirstTextMs:
			pageTime(clickedAt) && pageTime(modelStartAt) && modelStartAt >= clickedAt
				? pageInterval(modelStartAt, firstTextAt)
				: null,
	};
}

/**
 * Persisted model durations of one execution, folded like Eval model facts:
 * one entry per (operationRef, attemptRef), the latest fact wins, and only
 * observed attempts (started or carrying startedAt) count. Missing is null.
 */
export function modelDurationEvidence(events, executionId) {
	const attempts = new Map();
	for (const event of Array.isArray(events) ? events : []) {
		const fact = event?.payload;
		if (
			event?.type !== "execution.operation" ||
			event.executionId !== executionId ||
			fact?.kind !== "model" ||
			typeof fact.operationRef !== "string" ||
			typeof fact.attemptRef !== "string"
		)
			continue;
		const key = JSON.stringify([fact.operationRef, fact.attemptRef]);
		attempts.set(key, {
			observed:
				attempts.get(key)?.observed === true ||
				fact.phase === "started" ||
				fact.startedAt !== undefined,
			durationMs:
				Number.isSafeInteger(fact.durationMs) && fact.durationMs >= 0
					? fact.durationMs
					: null,
		});
	}
	const observed = [...attempts.values()].filter((attempt) => attempt.observed);
	const measured = observed.filter((attempt) => attempt.durationMs !== null);
	return {
		modelDurationMs: measured.length
			? measured.reduce((sum, attempt) => sum + attempt.durationMs, 0)
			: null,
		modelDurationAttempts: {
			observed: observed.length,
			withDuration: measured.length,
		},
	};
}

/** The observer runs before forwarding a chunk; coalesced frames cannot require an earlier paint. */
export function assistantDeliveryEvidence(frames, renders, baseline = 0) {
	if (!Array.isArray(frames) || !Array.isArray(renders)) return null;
	const textIndex = frames.findIndex(
		(f) => f.type === "text.delta" && f.textLength > 0,
	);
	const terminalIndex = frames.findIndex(
		(f) => f.type === "execution.status" && f.status === "completed",
	);
	if (textIndex < 0 || terminalIndex <= textIndex) return null;
	const text = frames[textIndex];
	const terminal = frames[terminalIndex];
	if (
		!Number.isFinite(text.at) ||
		!Number.isFinite(terminal.at) ||
		text.at > terminal.at ||
		!Number.isSafeInteger(text.chunkSequence) ||
		!Number.isSafeInteger(terminal.chunkSequence) ||
		text.chunkSequence < 1 ||
		text.chunkSequence > terminal.chunkSequence
	)
		return null;
	const coalesced = text.chunkSequence === terminal.chunkSequence;
	const rendered = renders.some(
		(r) =>
			Number.isFinite(r.at) &&
			r.at >= text.at &&
			r.visibleTextLength > baseline &&
			(coalesced || r.at < terminal.at),
	);
	return rendered
		? {
				mode: coalesced ? "coalesced" : "incremental",
				renderedBeforeTerminal: !coalesced,
			}
		: null;
}

export function restoredHistoryPreservesEvents(
	before,
	after,
	conversationId,
	executionId,
) {
	if (
		!currentExecutionEvents(before, conversationId, executionId) ||
		!currentExecutionEvents(after, conversationId, executionId)
	)
		return false;

	return isDeepStrictEqual(
		after.events.slice(0, before.events.length),
		before.events,
	);
}

export function assertAcceptance(
	input,
	events,
	evidence,
	preTerminalNativeMetadata,
) {
	const required = input.acceptance ?? {};
	const reasoningEvents = events.filter(
		(event) => event.type === "reasoning.delta",
	);
	const resultFiles = events.filter((event) => event.type === "result.file");
	const toolOperations = events.filter(
		(event) =>
			event.type === "execution.operation" && event.payload?.kind === "tool",
	);
	const browserOperations = events.filter(
		(event) =>
			event.type === "execution.operation" &&
			event.payload?.kind === "tool" &&
			event.payload.browser !== undefined,
	);
	const browserHandoffs = events.filter(
		(event) => event.type === "browser.handoff",
	);
	if (required.requireThinking)
		assert(reasoningEvents.length > 0, "Expected real reasoning.delta events");
	if (required.requireResultFile)
		assert(resultFiles.length > 0, "Expected a real result.file event");
	if (required.requireToolOperation)
		assert(toolOperations.length > 0, "Expected a real tool operation event");
	if (required.requireBrowserOperation)
		assert(
			browserOperations.length > 0,
			"Expected a real Browser operation event",
		);
	if (required.requireBrowserHandoff)
		assert(browserHandoffs.length > 0, "Expected a real browser.handoff event");
	if (required.requiredToolId !== undefined)
		assert(
			toolOperations.some(
				(event) => event.payload.toolId === required.requiredToolId,
			),
			`Expected tool operation ${required.requiredToolId}`,
		);
	const nativeMetadata = preTerminalNativeMetadata;
	if (
		required.requireSkillMetadata ||
		required.requiredSkillName !== undefined
	) {
		assert(
			Array.isArray(nativeMetadata?.capabilities),
			"Expected Skill metadata from the active Execution",
		);
		if (required.requiredSkillName !== undefined)
			assert(
				nativeMetadata.capabilities.some(
					(entry) =>
						entry &&
						typeof entry === "object" &&
						entry.name === required.requiredSkillName,
				),
				`Expected Skill ${required.requiredSkillName} in native metadata`,
			);
	}
	evidence.acceptance = {
		reasoningDeltaCount: reasoningEvents.length,
		resultFileCount: resultFiles.length,
		toolOperationCount: toolOperations.length,
		browserOperationCount: browserOperations.length,
		browserHandoffCount: browserHandoffs.length,
		...(nativeMetadata === undefined
			? {}
			: { skillMetadataCount: nativeMetadata.capabilities.length }),
	};
}
