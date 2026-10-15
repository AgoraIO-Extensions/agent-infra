import { randomUUID } from "node:crypto";
import type { startObservability } from "@agent-infra/observability";
import {
	createWorkloadReconciliationV1,
	type WorkloadReconciliationFailureV1,
	type WorkloadReconciliationStateV1,
	type WorkloadReconciliationStorePortV1,
} from "@agent-infra/platform-core";
import { openPostgresWorkloadReconciliationStoreV1 } from "@agent-infra/platform-store";
import { createPlatformFileReconciliationWorkerV1 } from "./file-worker.js";
import {
	createWorkloadRuntimeV1,
	type WorkloadRuntimeOptionsV1,
} from "./workload-runtime.js";

export interface PlatformWorkloadWorkerOptionsV1
	extends Omit<WorkloadRuntimeOptionsV1, "workerId"> {
	readonly databaseUrl: string;
	readonly files?: Omit<
		Parameters<typeof createPlatformFileReconciliationWorkerV1>[0],
		"databaseUrl"
	>;
	readonly workerId?: string;
	readonly pollIntervalMs?: number;
	readonly maximumAttempts?: number;
	readonly forbiddenFailureThreshold?: number;
	/** Consecutive incomplete monitor probes a serving Workload tolerates (#2046). */
	readonly probeFailureThreshold?: number;
	/** Idle Session Sandbox reclaim threshold; defaults to 30 minutes. */
	readonly idleSandboxReclaimAfterMs?: number | null;
	/** Process-owned telemetry; collection failures never affect reconciliation. */
	readonly observability?: WorkloadTelemetry;
	readonly log?: (message: string) => void;
}

/** 连续推进多少步后休眠一次 `pollIntervalMs`。 */
const maximumConsecutiveStepsV1 = 20;

type WorkloadTelemetry = Pick<ReturnType<typeof startObservability>, "record">;

function workloadFailureCode(
	state: WorkloadReconciliationStateV1,
):
	| "WORKLOAD_RECONCILIATION_FAILED"
	| "WORKLOAD_HEALTH_CHECK_FAILED"
	| undefined {
	if (state.failureCode === "health_check_failed")
		return "WORKLOAD_HEALTH_CHECK_FAILED";
	if (state.failureCode === "reconciliation_failed" || state.phase === "failed")
		return "WORKLOAD_RECONCILIATION_FAILED";
	return undefined;
}

function observeWorkload(
	telemetry: WorkloadTelemetry | undefined,
	event: Parameters<WorkloadTelemetry["record"]>[0],
) {
	try {
		telemetry?.record(event);
	} catch {
		// Telemetry is observational and must not alter Workload reconciliation.
	}
}

const failureLogIntervalMs = 30_000;

export function createWorkloadFailureLoggerV1(
	log: (message: string) => void,
	now: () => number = Date.now,
) {
	const failureLogAt = new Map<string, number>();
	return function logWorkloadFailure(
		failure: WorkloadReconciliationFailureV1 & { readonly agentId: string },
	) {
		const key = `${failure.agentId}:${failure.phase}:${failure.code}`;
		const timestamp = now();
		const previous = failureLogAt.get(key);
		if (previous !== undefined && timestamp - previous < failureLogIntervalMs)
			return;
		failureLogAt.set(key, timestamp);
		try {
			log(
				JSON.stringify({
					service: "platform-worker",
					code: failure.code,
					agentId: failure.agentId,
					phase: failure.phase,
					attempt: failure.attempt,
					...(failure.status === undefined ? {} : { status: failure.status }),
					...(failure.kind === undefined ? {} : { kind: failure.kind }),
					...(failure.verb === undefined ? {} : { verb: failure.verb }),
				}),
			);
		} catch {
			// Logging is observational and must not stop reconciliation.
		}
	};
}

export function createPlatformWorkloadWorkerV1(
	options: PlatformWorkloadWorkerOptionsV1,
) {
	const workerId = options.workerId ?? randomUUID();
	if (!workerId || workerId.includes("\0"))
		throw new TypeError("Invalid Worker identity");
	const pollIntervalMs = options.pollIntervalMs ?? 1000;
	if (
		!Number.isSafeInteger(pollIntervalMs) ||
		pollIntervalMs < 1 ||
		pollIntervalMs > 300_000
	)
		throw new TypeError("Invalid Worker poll interval");
	const log = options.log ?? console.info;
	function logSafely(message: string) {
		try {
			log(message);
		} catch {
			// Logging is observational and must not stop reconciliation.
		}
	}
	const logFailure = createWorkloadFailureLoggerV1(log);
	const runtime = createWorkloadRuntimeV1({
		...options,
		workerId,
		onProbeFailure(failure) {
			options.onProbeFailure?.(failure);
			logSafely(
				JSON.stringify({
					service: "platform-worker",
					code: "WORKLOAD_PROBE_FAILED",
					...failure,
				}),
			);
		},
	});
	const store = openPostgresWorkloadReconciliationStoreV1({
		databaseUrl: options.databaseUrl,
		runtimeModelVersion: options.runtimeModelVersion,
		retryDelayMs: pollIntervalMs,
		idleSandboxReclaimAfterMs: options.idleSandboxReclaimAfterMs,
	});
	let files:
		| ReturnType<typeof createPlatformFileReconciliationWorkerV1>
		| undefined;
	let reconciliation: ReturnType<typeof createWorkloadReconciliationV1>;
	try {
		if (options.files)
			files = createPlatformFileReconciliationWorkerV1({
				...options.files,
				databaseUrl: options.databaseUrl,
			});
		const observedStore: WorkloadReconciliationStorePortV1 = {
			async runNext(workerId, step) {
				const startedAt = performance.now();
				let event: Parameters<WorkloadTelemetry["record"]>[0] | undefined;
				const result = await store.runNext(workerId, async (input) => {
					const next = await step(input);
					const code = workloadFailureCode(next);
					event = {
						stage: "workload",
						outcome: code ? "failed" : "completed",
						...(code ? { code } : {}),
						requestId: input.requestId,
						traceId: input.traceId,
						agentId: input.management.agentId,
					};
					return next;
				});
				if (event)
					observeWorkload(options.observability, {
						...event,
						durationMs: performance.now() - startedAt,
					});
				return result;
			},
		};
		reconciliation = createWorkloadReconciliationV1({
			store: observedStore,
			runtime,
			maximumAttempts: options.maximumAttempts,
			forbiddenFailureThreshold: options.forbiddenFailureThreshold,
			probeFailureThreshold: options.probeFailureThreshold,
			onFailure: logFailure,
		});
	} catch (error) {
		void Promise.allSettled([store.close(), files?.close()]);
		throw error;
	}
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let tickTail: Promise<void> = Promise.resolve();
	// 轮询连续推进的步数，达到上限后休眠一次，防止反复到期的步骤形成热循环。
	let consecutiveSteps = 0;
	function enqueueTick(polling = false) {
		const result = tickTail.then(async () => {
			let outcome: "idle" | "advanced" | undefined;
			const startedAt = performance.now();
			try {
				outcome = await reconciliation.tick(workerId);
				return outcome;
			} catch (error) {
				observeWorkload(options.observability, {
					stage: "workload",
					outcome: "failed",
					code: "WORKLOAD_UNAVAILABLE",
					durationMs: performance.now() - startedAt,
				});
				throw error;
			} finally {
				// 连续推进期间暂缓文件清理，在本轮休眠前运行一次，不随步数放大
				// 存储扫描（#2295）；手动 tick 与失败后照常清理。
				const draining =
					polling &&
					outcome === "advanced" &&
					consecutiveSteps + 1 < maximumConsecutiveStepsV1;
				if (!draining) await files?.runOnce();
			}
		});
		tickTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	async function poll() {
		let advanced = false;
		try {
			advanced = (await enqueueTick(true)) === "advanced";
		} catch {
			logSafely(
				JSON.stringify({
					service: "platform-worker",
					status: "retrying",
					code: "WORKLOAD_RECONCILIATION_UNAVAILABLE",
				}),
			);
		}
		// 刚推进一步时立即处理下一个已到期的 Workload；所有 Agent 共用这条串行
		// 队列，固定休眠会让创建中的步骤排在复核之后（#2295）。单个 Agent 两步之间
		// 的间隔仍由 Store 的重试与复核时间控制。
		consecutiveSteps = advanced ? consecutiveSteps + 1 : 0;
		const drain = advanced && consecutiveSteps < maximumConsecutiveStepsV1;
		if (!drain) consecutiveSteps = 0;
		if (!stopped)
			timer = setTimeout(
				() => {
					running = poll();
				},
				drain ? 0 : pollIntervalMs,
			);
	}
	return {
		tick: () => {
			if (stopped)
				return Promise.reject(new Error("Platform Worker is stopped"));
			return enqueueTick();
		},
		start() {
			if (running || stopped) return;
			logSafely(
				JSON.stringify({ service: "platform-worker", status: "ready" }),
			);
			running = poll();
		},
		stop() {
			if (closing) return closing;
			stopped = true;
			clearTimeout(timer);
			closing = (async () => {
				try {
					await running;
				} finally {
					await tickTail;
					await Promise.all([store.close(), files?.close()]);
				}
			})();
			return closing;
		},
	};
}

export async function startPlatformWorkloadWorkerFromDeploymentV1(
	moduleSpecifier = process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE,
	signal?: AbortSignal,
	observability?: WorkloadTelemetry,
) {
	if (!moduleSpecifier)
		throw new Error("PLATFORM_WORKER_DEPLOYMENT_MODULE is required");
	const assemblySignal = signal ?? new AbortController().signal;
	let options: PlatformWorkloadWorkerOptionsV1;
	try {
		if (assemblySignal.aborted) throw new Error();
		const deployment = (await import(moduleSpecifier)) as {
			createPlatformWorkloadWorkerOptionsV1(
				signal: AbortSignal,
			):
				| Promise<PlatformWorkloadWorkerOptionsV1>
				| PlatformWorkloadWorkerOptionsV1;
		};
		if (assemblySignal.aborted) throw new Error();
		options =
			await deployment.createPlatformWorkloadWorkerOptionsV1(assemblySignal);
	} catch {
		throw new Error("Platform Worker deployment dependencies are unavailable");
	}
	const worker = createPlatformWorkloadWorkerV1({
		...options,
		...(observability ? { observability } : {}),
	});
	if (assemblySignal.aborted) await worker.stop();
	else worker.start();
	return worker;
}
