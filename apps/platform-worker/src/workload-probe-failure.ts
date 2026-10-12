/**
 * A Workload probe that did not complete within its bound or could not reach
 * the Agent Pod, as opposed to one that answered unhealthy (#2046). A ready
 * Workload tolerates a bounded run of these before it closes its route.
 */
export type WorkloadProbeIncompleteReasonV1 = "timeout" | "connection";

export class WorkloadProbeIncompleteErrorV1 extends Error {
	constructor(
		readonly stage: "health" | "readiness",
		readonly reason: WorkloadProbeIncompleteReasonV1,
	) {
		super("Workload probe did not complete");
	}
}

// Transport failures before any response. A redirect, oversize, malformed or
// non-2xx answer is a response, never one of these.
const timeoutCodes = new Set([
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);
const connectionCodes = new Set([
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"UND_ERR_CLOSED",
	"UND_ERR_SOCKET",
]);

/** Follows the `cause` chain; anything unrecognised is not incomplete. */
export function workloadProbeIncompleteReasonV1(
	error: unknown,
): WorkloadProbeIncompleteReasonV1 | undefined {
	let current = error;
	for (let depth = 0; depth < 4 && current; depth++) {
		if (current instanceof WorkloadProbeIncompleteErrorV1)
			return current.reason;
		if (
			current instanceof Error &&
			(current.name === "TimeoutError" || current.name === "AbortError")
		)
			return "timeout";
		const code =
			typeof current === "object" &&
			"code" in current &&
			typeof current.code === "string"
				? current.code
				: undefined;
		if (code && timeoutCodes.has(code)) return "timeout";
		if (code && connectionCodes.has(code)) return "connection";
		current = current instanceof Error ? current.cause : undefined;
	}
	return undefined;
}
