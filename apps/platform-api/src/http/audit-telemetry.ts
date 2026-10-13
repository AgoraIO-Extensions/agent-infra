import type {
	OperationalCode,
	OperationalEvent,
	OperationalOutcome,
	OperationalStage,
} from "@agent-infra/observability";

/** The API process owns the exporter; audit adapters only emit bounded facts. */
export interface AuditTelemetry {
	record(event: OperationalEvent): void;
}

export type AuditOperation = "list" | "detail" | "denied";

function codeFor(error: unknown): OperationalCode | undefined {
	if (error && typeof error === "object") {
		const value = error as {
			code?: unknown;
			body?: { code?: unknown };
		};
		const code = value.code ?? value.body?.code;
		if (
			code === "access_denied" ||
			code === "authentication_required" ||
			code === "forbidden" ||
			code === "AUTHENTICATION_REQUIRED" ||
			code === "FORBIDDEN" ||
			code === "AUTHORIZATION_REVOKED" ||
			code === "RESOURCE_UNAVAILABLE"
		)
			return "AUTHORIZATION_DENIED";
		if (code === "unavailable" || code === "DEPENDENCY_UNAVAILABLE")
			return "DEPENDENCY_UNAVAILABLE";
	}
	return undefined;
}

export function auditOperationRef(operation: AuditOperation): string {
	return operation === "denied"
		? "platform.audit.denied"
		: `platform.audit.${operation}`;
}

export function auditOutcome(error: unknown): {
	outcome: OperationalOutcome;
	code?: OperationalCode;
} {
	if (error && typeof error === "object") {
		const value = error as {
			code?: unknown;
			body?: { code?: unknown };
		};
		const rawCode = value.code ?? value.body?.code;
		const status = (error as { status?: unknown }).status;
		if (typeof status === "number" && status >= 400 && status < 500)
			return {
				outcome: "rejected",
				...(codeFor(error) ? { code: codeFor(error) } : {}),
			};
		if (rawCode === "invalid_request") return { outcome: "rejected" };
	}
	const code = codeFor(error);
	return error === undefined
		? { outcome: "completed" }
		: {
				outcome: code === "AUTHORIZATION_DENIED" ? "rejected" : "failed",
				code: code ?? "DEPENDENCY_UNAVAILABLE",
			};
}

/** Telemetry is best-effort and must never alter an audit response or transaction. */
export function recordAuditStage(
	telemetry: AuditTelemetry | undefined,
	stage: Extract<OperationalStage, "audit_query" | "audit_write">,
	operation: AuditOperation,
	startedAt: number,
	result: ReturnType<typeof auditOutcome>,
	metadata: { requestId: string; traceId: string },
): void {
	if (!telemetry) return;
	try {
		const code =
			stage === "audit_write" && result.outcome === "failed"
				? "AUDIT_UNAVAILABLE"
				: result.code;
		telemetry.record({
			stage,
			outcome: result.outcome,
			durationMs: Math.max(
				0,
				Math.min(86_400_000, performance.now() - startedAt),
			),
			...(code ? { code } : {}),
			requestId: metadata.requestId,
			traceId: metadata.traceId,
			operationRef: auditOperationRef(operation),
		});
	} catch {
		// `record` is intentionally non-throwing; keep the boundary defensive so a
		// replacement adapter cannot make audit reads or writes fail open.
	}
}

export async function observeAuditQuery<T>(input: {
	telemetry: AuditTelemetry | undefined;
	operation: Exclude<AuditOperation, "denied">;
	metadata: { requestId: string; traceId: string };
	work: () => Promise<T>;
}): Promise<T> {
	const startedAt = performance.now();
	try {
		const result = await input.work();
		recordAuditStage(
			input.telemetry,
			"audit_query",
			input.operation,
			startedAt,
			auditOutcome(undefined),
			input.metadata,
		);
		return result;
	} catch (error) {
		recordAuditStage(
			input.telemetry,
			"audit_query",
			input.operation,
			startedAt,
			auditOutcome(error),
			input.metadata,
		);
		throw error;
	}
}
