import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { MiddlewareHandler } from "hono";
import type { startObservability } from "./index.js";

interface RequestMetadata {
	readonly requestId: string;
	readonly traceId: string;
}

const requests = new AsyncLocalStorage<{
	readonly metadata: RequestMetadata;
	active: boolean;
}>();

export function currentRequestMetadata(): RequestMetadata | undefined {
	const request = requests.getStore();
	return request?.active ? request.metadata : undefined;
}

/** Measures response-header readiness, not the lifetime of a streaming body. */
export function createHttpObservability(
	telemetry: Pick<ReturnType<typeof startObservability>, "record">,
): MiddlewareHandler {
	return async (context, next) => {
		const request = {
			metadata: Object.freeze({
				requestId: randomUUID(),
				traceId: randomUUID(),
			}),
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
						...request.metadata,
					});
				} catch {
					// Telemetry cannot change the existing response or exception.
				}
			}
		});
	};
}
