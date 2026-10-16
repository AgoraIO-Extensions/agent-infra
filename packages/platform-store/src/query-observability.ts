import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";

export interface StoreQueryEvent {
	readonly stage: "dependency";
	readonly outcome: "completed" | "failed";
	readonly durationMs: number;
	readonly operationRef: string;
	readonly errorClass?: string;
	readonly sqlState?: string;
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
const operationRefs = new AsyncLocalStorage<string>();

export function runStoreQueryOperation<T>(
	operationRef: string,
	work: () => Promise<T>,
): Promise<T> {
	return operationRefs.run(operationRef, work);
}

function currentOperationRef(defaultRef: string): string {
	return operationRefs.getStore() ?? defaultRef;
}

function errorMetadata(error: unknown): {
	errorClass?: string;
	sqlState?: string;
} {
	let current = error;
	let errorClass: string | undefined;
	let sqlState: string | undefined;
	for (
		let depth = 0;
		depth < 4 && current && typeof current === "object";
		depth++
	) {
		const value = current as {
			constructor?: { name?: unknown };
			code?: unknown;
			cause?: unknown;
		};
		if (
			errorClass === undefined &&
			typeof value.constructor?.name === "string" &&
			/^[A-Za-z][A-Za-z0-9_$.-]{0,63}$/.test(value.constructor.name)
		)
			errorClass = value.constructor.name;
		if (
			sqlState === undefined &&
			typeof value.code === "string" &&
			/^[0-9A-Z]{5}$/.test(value.code)
		)
			sqlState = value.code;
		current = value.cause;
	}
	return {
		...(errorClass === undefined ? {} : { errorClass }),
		...(sqlState === undefined ? {} : { sqlState }),
	};
}

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

function recordFailedQuery(
	observability: StoreQueryObservability | undefined,
	operationRef: string,
	startedAt: number,
	error: unknown,
) {
	if (!observability) return;
	try {
		observability.record({
			stage: "dependency",
			outcome: "failed",
			durationMs: boundedDuration(startedAt),
			operationRef,
			...errorMetadata(error),
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
			recordFailedQuery(options.observability, operationRef, startedAt, error);
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
	return new Proxy(client, {
		apply(target, thisArg, args) {
			const startedAt = performance.now();
			return observePromise(
				Reflect.apply(target, thisArg, args),
				currentOperationRef("store.query"),
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
					currentOperationRef("store.query"),
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
