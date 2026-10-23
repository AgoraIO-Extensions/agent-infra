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
