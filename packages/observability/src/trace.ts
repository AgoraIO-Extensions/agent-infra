import { randomBytes } from "node:crypto";
import type { SpanContext } from "@opentelemetry/api";
import { TraceFlags } from "@opentelemetry/api";

const traceParentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/**
 * A bounded W3C traceparent. It is deliberately independent from the
 * platform's opaque business traceId so old records remain readable.
 */
export const traceParentMaxLength = 55;

export function parseTraceParent(value: unknown): SpanContext | undefined {
	if (typeof value !== "string" || value.length !== traceParentMaxLength)
		return undefined;
	const match = traceParentPattern.exec(value);
	if (!match) return undefined;
	const [, traceId, spanId, flags] = match;
	if (
		!traceId ||
		!spanId ||
		!flags ||
		/^0+$/.test(traceId) ||
		/^0+$/.test(spanId)
	)
		return undefined;
	return {
		traceId: traceId.toLowerCase(),
		spanId: spanId.toLowerCase(),
		traceFlags: Number.parseInt(flags, 16),
		isRemote: true,
	};
}

export function formatTraceParent(context: SpanContext): string {
	return `00-${context.traceId}-${context.spanId}-${context.traceFlags
		.toString(16)
		.padStart(2, "0")}`;
}

export function createTraceParent(): string {
	const context: SpanContext = {
		traceId: randomBytes(16).toString("hex"),
		spanId: randomBytes(8).toString("hex"),
		traceFlags: TraceFlags.SAMPLED,
		isRemote: false,
	};
	return formatTraceParent(context);
}

export function isTraceParent(value: unknown): value is string {
	return parseTraceParent(value) !== undefined;
}
