const stages = new Set(["response_headers", "response_body"]);
const classes = new Set([
	"dns",
	"tls",
	"connect_refused",
	"connection_reset",
	"timeout",
	"UNKNOWN",
]);

/** A second whitelist at the common Pino/OTLP boundary, never an exception serializer. */
export function projectModelTransport(value: unknown) {
	if (!value || typeof value !== "object") return undefined;
	const { stage, errorClass, elapsedMs, upstreamStatus } = value as Record<
		string,
		unknown
	>;
	if (
		!stages.has(stage as string) ||
		!classes.has(errorClass as string) ||
		!Number.isSafeInteger(elapsedMs) ||
		(elapsedMs as number) < 0
	)
		return undefined;
	return {
		modelTransportStage: stage as string,
		modelTransportErrorClass: errorClass as string,
		modelTransportElapsedMs: elapsedMs as number,
		...(stage === "response_body" &&
		Number.isInteger(upstreamStatus) &&
		(upstreamStatus as number) >= 100 &&
		(upstreamStatus as number) <= 599
			? { modelTransportHttpStatus: upstreamStatus as number }
			: {}),
	};
}
