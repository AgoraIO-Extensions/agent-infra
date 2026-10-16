import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { MiddlewareHandler } from "hono";
import {
	operationalCodes,
	createTraceParent,
	type ObservabilitySpan,
	type OperationalCode,
	type startObservability,
} from "./index.js";

interface RequestMetadata {
	readonly requestId: string;
	readonly traceId: string;
	/** Internal W3C context; non-enumerable on the returned object. */
	readonly traceParent?: string;
}

const requests = new AsyncLocalStorage<{
	readonly metadata: RequestMetadata;
	active: boolean;
	failureCode?: OperationalCode;
}>();

const httpFailureCodes = new Set<string>(operationalCodes);

export function currentRequestMetadata(): RequestMetadata | undefined {
	const request = requests.getStore();
	return request?.active ? request.metadata : undefined;
}

export function recordHttpFailure(code: string): void {
	const request = requests.getStore();
	if (
		!request?.active ||
		!/^[A-Z][A-Z0-9_]{0,63}$/.test(code) ||
		!httpFailureCodes.has(code)
	)
		return;
	request.failureCode = code as OperationalCode;
}

/** Measures response-header readiness, not the lifetime of a streaming body. */
export function createHttpObservability(
	telemetry: Pick<ReturnType<typeof startObservability>, "record"> &
		Partial<Pick<ReturnType<typeof startObservability>, "startSpan">>,
): MiddlewareHandler {
	return async (context, next) => {
		let span: ObservabilitySpan | undefined;
		try {
			span = telemetry.startSpan?.("platform.http.server");
		} catch {
			// Trace setup cannot change the existing response or exception.
		}
		const traceParent =
			span?.traceParent ??
			(telemetry.startSpan === undefined ? undefined : createTraceParent());
		const metadata = {
			requestId: randomUUID(),
			traceId: randomUUID(),
		};
		if (traceParent !== undefined)
			Object.defineProperty(metadata, "traceParent", {
				value: traceParent,
				enumerable: false,
				writable: false,
			});
		const request: {
			readonly metadata: RequestMetadata;
			active: boolean;
			failureCode?: OperationalCode;
		} = {
			metadata: Object.freeze(metadata) as RequestMetadata,
			active: true,
		};
		return requests.run(request, async () => {
			const began = performance.now();
			let threw = false;
			try {
				await next();
			} catch (error) {
				threw = true;
				throw error;
			} finally {
				request.active = false;
				try {
					telemetry.record({
						stage: "http",
						outcome:
							threw || context.res.status >= 500
								? "failed"
								: context.res.status >= 400
									? "rejected"
									: "completed",
						durationMs: performance.now() - began,
						method: context.req.method,
						...(context.req.routePath
							? { routeTemplate: context.req.routePath }
							: {}),
						statusCode: context.res.status,
						...(request.failureCode ? { code: request.failureCode } : {}),
						...request.metadata,
						...(traceParent === undefined ? {} : { traceParent }),
					});
				} catch {
					// Telemetry cannot change the existing response or exception.
				}
				span?.end();
			}
		});
	};
}
