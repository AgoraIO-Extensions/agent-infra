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

	return before.events.every(
		(event, index) =>
			after.events[index]?.eventId === event.eventId &&
			after.events[index]?.executionId === event.executionId,
	);
}
