export function persistedEventsMatchExecution(
	events,
	conversationId,
	executionId,
) {
	if (
		!Array.isArray(events) ||
		events.length === 0 ||
		typeof executionId !== "string" ||
		executionId.length === 0
	)
		return false;

	let currentExecutionEvents = 0;
	for (const event of events) {
		if (
			!event ||
			typeof event.eventId !== "string" ||
			event.eventId.length === 0 ||
			event.conversationId !== conversationId
		)
			return false;

		if (event.executionId === null) continue;
		if (typeof event.executionId !== "string" || event.executionId.length === 0)
			return false;
		if (event.executionId === executionId) currentExecutionEvents += 1;
	}

	return currentExecutionEvents > 0;
}
