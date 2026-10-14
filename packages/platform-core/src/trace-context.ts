const traceParentPattern = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;

/** Bounded W3C traceparent validation for durable platform contracts. */
export function isTraceParentV1(value: unknown): value is string {
	if (typeof value !== "string" || value.length !== 55) return false;
	if (!traceParentPattern.test(value)) return false;
	const [, traceId, spanId] = value.split("-");
	return Boolean(
		traceId && spanId && !/^[0]+$/.test(traceId) && !/^[0]+$/.test(spanId),
	);
}
