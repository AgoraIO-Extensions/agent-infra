import type { startObservability } from "./index.js";

export interface PlatformQueueResourceSnapshot {
	readonly taskWaiting: number;
	readonly outboxPending: number;
}

export interface PlatformPoolResourceSnapshot {
	readonly active: number;
	readonly idle: number;
	readonly waiting: number;
}

export interface PlatformResourceSamplerOptions {
	readonly telemetry: Pick<
		ReturnType<typeof startObservability>,
		"observeResource" | "record" | "status"
	>;
	readonly readQueue?: (
		signal: AbortSignal,
	) => Promise<PlatformQueueResourceSnapshot>;
	readonly readPool?: (
		signal: AbortSignal,
	) => Promise<PlatformPoolResourceSnapshot>;
	readonly intervalMs?: number;
}

function validCount(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

/** One serial process-owned timer; business dispatch and persisted facts are untouched. */
export function startPlatformResourceSampler(
	options: PlatformResourceSamplerOptions,
): { stop(): void } {
	const { telemetry, readQueue, readPool } = options;
	const interval = options.intervalMs ?? 5000;
	if (
		(!readQueue && !readPool) ||
		!Number.isSafeInteger(interval) ||
		interval < 1000 ||
		interval > 60_000
	)
		throw new TypeError("Platform resource sampler options are invalid");
	if (!telemetry.status().enabled) return { stop() {} };

	const stopped = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const unavailable = () => {
		if (stopped.signal.aborted) return;
		try {
			telemetry.record({
				stage: "dependency",
				outcome: "failed",
				code: "DEPENDENCY_UNAVAILABLE",
			});
		} catch {
			// Telemetry must not affect process work or shutdown.
		}
	};
	const read = async <T>(reader: (signal: AbortSignal) => Promise<T>) => {
		const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(2000)]);
		const result = await reader(signal);
		signal.throwIfAborted();
		return result;
	};
	const sample = async () => {
		if (stopped.signal.aborted) return;
		if (readQueue) {
			try {
				const value = await read(readQueue);
				if (!validCount(value.taskWaiting) || !validCount(value.outboxPending))
					throw new TypeError("Platform queue resource snapshot is invalid");
				telemetry.observeResource({
					kind: "task_waiting",
					value: value.taskWaiting,
				});
				telemetry.observeResource({
					kind: "outbox_pending",
					value: value.outboxPending,
				});
			} catch {
				unavailable();
			}
		}
		if (readPool && !stopped.signal.aborted) {
			try {
				const value = await read(readPool);
				if (
					!validCount(value.active) ||
					!validCount(value.idle) ||
					!validCount(value.waiting)
				)
					throw new TypeError("Platform pool resource snapshot is invalid");
				telemetry.observeResource({
					kind: "postgres_pool_active",
					value: value.active,
				});
				telemetry.observeResource({
					kind: "postgres_pool_idle",
					value: value.idle,
				});
				telemetry.observeResource({
					kind: "postgres_pool_waiting",
					value: value.waiting,
				});
			} catch {
				unavailable();
			}
		}
		if (!stopped.signal.aborted) {
			timer = setTimeout(() => void sample(), interval);
			timer.unref();
		}
	};
	void sample();
	return {
		stop() {
			stopped.abort();
			clearTimeout(timer);
		},
	};
}
