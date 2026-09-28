export function persistedEventsMatchExecution(
	events,
	conversationId,
	executionId,
) {
	return (
		Array.isArray(events) &&
		events.length > 0 &&
		typeof executionId === "string" &&
		executionId.length > 0 &&
		events.every(
			(event) =>
				event?.eventId &&
				event.conversationId === conversationId &&
				typeof event.executionId === "string" &&
				event.executionId.length > 0 &&
				event.executionId === executionId,
		) &&
		events.some((event) => event.executionId === executionId)
	);
}
