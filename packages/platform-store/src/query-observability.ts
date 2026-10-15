import type postgres from "postgres";

export interface StoreQueryEvent {
	readonly stage: "dependency";
	readonly outcome: "completed";
	readonly durationMs: number;
	readonly operationRef: string;
}

export interface StoreQueryObservability {
	record(event: StoreQueryEvent): void;
}

export interface StoreQueryObservabilityOptions {
	readonly observability?: StoreQueryObservability;
	readonly slowQueryThresholdMs?: number;
}

const defaultSlowQueryThresholdMs = 250;
const maximumSlowQueryThresholdMs = 2_000;

export function storeSlowQueryThresholdMs(
	configured = Number(process.env.AGENT_INFRA_SLOW_QUERY_THRESHOLD_MS),
): number {
	return Number.isInteger(configured) &&
		configured >= 1 &&
		configured <= maximumSlowQueryThresholdMs
		? configured
		: defaultSlowQueryThresholdMs;
}

function boundedDuration(startedAt: number): number {
	return Math.min(2_000, Math.max(0, performance.now() - startedAt));
}

function recordSlowQuery(
	observability: StoreQueryObservability | undefined,
	operationRef: string,
	startedAt: number,
) {
	if (!observability) return;
	try {
		observability.record({
			stage: "dependency",
			outcome: "completed",
			durationMs: boundedDuration(startedAt),
			operationRef,
		});
	} catch {
		// Query telemetry must never alter the Store result.
	}
}

function observePromise<T>(
	result: T,
	operationRef: string,
	options: StoreQueryObservabilityOptions,
	startedAt = performance.now(),
): T {
	if (
		!options.observability ||
		!result ||
		typeof (result as { then?: unknown }).then !== "function"
	)
		return result;
	return Promise.resolve(result).then(
		(value) => {
			if (
				boundedDuration(startedAt) >=
				storeSlowQueryThresholdMs(options.slowQueryThresholdMs)
			)
				recordSlowQuery(options.observability, operationRef, startedAt);
			return value;
		},
		(error) => {
			if (
				boundedDuration(startedAt) >=
				storeSlowQueryThresholdMs(options.slowQueryThresholdMs)
			)
				recordSlowQuery(options.observability, operationRef, startedAt);
			throw error;
		},
	) as T;
}

/** Wraps postgres.js tagged queries while keeping SQL, parameters and IDs out of telemetry. */
export function observePostgresClient(
	client: ReturnType<typeof postgres>,
	options: StoreQueryObservabilityOptions,
): ReturnType<typeof postgres> {
	if (!options.observability) return client;
	const operationRef = "store.query";
	return new Proxy(client, {
		apply(target, thisArg, args) {
			const startedAt = performance.now();
			return observePromise(
				Reflect.apply(target, thisArg, args),
				operationRef,
				options,
				startedAt,
			);
		},
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (property !== "begin" || typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const startedAt = performance.now();
				const result = Reflect.apply(value, target, args);
				return observePromise(
					result,
					operationRef,
					{
						...options,
						// The transaction measures the complete Store operation once.
						slowQueryThresholdMs: options.slowQueryThresholdMs,
					},
					startedAt,
				);
			};
		},
	}) as ReturnType<typeof postgres>;
}
