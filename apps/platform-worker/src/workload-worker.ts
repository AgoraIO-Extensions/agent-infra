import { randomUUID } from "node:crypto";
import type { startObservability } from "@agent-infra/observability";
import {
	createWorkloadReconciliationV1,
	type WorkloadReconciliationStateV1,
	type WorkloadReconciliationStorePortV1,
} from "@agent-infra/platform-core";
import { openPostgresWorkloadReconciliationStoreV1 } from "@agent-infra/platform-store";
import { createEvaluationDataWorkerV1 } from "./evaluation-data-worker.js";
import {
	createEvaluationScoringWorkerV1,
	type EvaluationScoringWorkerOptionsV1,
} from "./evaluation-scoring-worker.js";
import { createPlatformFileReconciliationWorkerV1 } from "./file-worker.js";
import type { MultiServiceHealthDiagnosticV1 } from "./multi-service-runtime.js";
import {
	createWorkloadRuntimeV1,
	type WorkloadRuntimeOptionsV1,
} from "./workload-runtime.js";
import { createWorkloadStepFailureLoggerV1 } from "./workload-step-failure.js";

export interface PlatformWorkloadWorkerOptionsV1
	extends Omit<WorkloadRuntimeOptionsV1, "workerId"> {
	readonly databaseUrl: string;
	readonly evaluationScoring?: Omit<
		EvaluationScoringWorkerOptionsV1,
		"databaseUrl"
	>;
	readonly evaluation?: Omit<
		Parameters<typeof createEvaluationDataWorkerV1>[0],
		"databaseUrl"
	>;
	readonly files?: Omit<
		Parameters<typeof createPlatformFileReconciliationWorkerV1>[0],
		"databaseUrl"
	>;
	readonly workerId?: string;
	readonly pollIntervalMs?: number;
	readonly maximumAttempts?: number;
	/** Separate budget for resource creation and image/PVC readiness. */
	readonly maximumApplyAttempts?: number;
	/** Separate budget for health/readiness observation after apply. */
	readonly maximumObserveAttempts?: number;
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
	const runtime = createWorkloadRuntimeV1({
		...options,
		workerId,
		onHealthDiagnostic(diagnostic: MultiServiceHealthDiagnosticV1) {
			try {
				options.onHealthDiagnostic?.(diagnostic);
			} catch {
				// Caller diagnostics are observational and never alter reconciliation.
			}
			try {
				logSafely(
					JSON.stringify({
						service: "platform-worker",
						code: "WORKLOAD_MULTI_SERVICE_HEALTH_DIAGNOSTIC",
						...diagnostic,
					}),
				);
			} catch {
				// Diagnostics never alter reconciliation.
			}
		},
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
		onProbe(observation) {
			options.onProbe?.(observation);
			logSafely(
				JSON.stringify({
					service: "platform-worker",
					code: "WORKLOAD_PROBE_OBSERVED",
					...observation,
				}),
			);
		},
	});
	const store = openPostgresWorkloadReconciliationStoreV1({
		selection: "lifecycle",
		databaseUrl: options.databaseUrl,
		runtimeModelVersion: options.runtimeModelVersion,
		retryDelayMs: pollIntervalMs,
		idleSandboxReclaimAfterMs: options.idleSandboxReclaimAfterMs,
	});
	let monitorStore: typeof store | undefined;
	let files:
		| ReturnType<typeof createPlatformFileReconciliationWorkerV1>
		| undefined;
	let evaluation: ReturnType<typeof createEvaluationDataWorkerV1> | undefined;
	let evaluationScoring:
		| ReturnType<typeof createEvaluationScoringWorkerV1>
		| undefined;
	let reconciliation: ReturnType<typeof createWorkloadReconciliationV1>;
	let monitorReconciliation: typeof reconciliation;
	try {
		monitorStore = openPostgresWorkloadReconciliationStoreV1({
			databaseUrl: options.databaseUrl,
			runtimeModelVersion: options.runtimeModelVersion,
			retryDelayMs: pollIntervalMs,
			idleSandboxReclaimAfterMs: options.idleSandboxReclaimAfterMs,
			selection: "monitor",
		});
		if (options.evaluationScoring)
			evaluationScoring = createEvaluationScoringWorkerV1({
				...options.evaluationScoring,
				databaseUrl: options.databaseUrl,
			});
		if (options.evaluation)
			evaluation = createEvaluationDataWorkerV1({
				...options.evaluation,
				databaseUrl: options.databaseUrl,
			});
		if (options.files)
			files = createPlatformFileReconciliationWorkerV1({
				...options.files,
				databaseUrl: options.databaseUrl,
			});
		function createReconciliation(selectedStore: typeof store) {
			const observedStore: WorkloadReconciliationStorePortV1 = {
				async runNext(workerId, step) {
					const startedAt = performance.now();
					let event: Parameters<WorkloadTelemetry["record"]>[0] | undefined;
					const result = await selectedStore.runNext(
						workerId,
						async (input) => {
							const next = await runtime.runReconciliationStep(
								input.state,
								() => step(input),
							);
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
						},
					);
					if (event)
						observeWorkload(options.observability, {
							...event,
							durationMs: performance.now() - startedAt,
						});
					return result;
				},
			};
			return createWorkloadReconciliationV1({
				store: observedStore,
				runtime,
				maximumAttempts: options.maximumAttempts,
				maximumApplyAttempts: options.maximumApplyAttempts,
				maximumObserveAttempts: options.maximumObserveAttempts,
				probeFailureThreshold: options.probeFailureThreshold,
				// 步骤里的异常被调谐吞掉后只会重试或终止；这里记录有界原因（不含正文）。
				onStepFailure: createWorkloadStepFailureLoggerV1({ log: logSafely }),
			});
		}
		reconciliation = createReconciliation(store);
		monitorReconciliation = createReconciliation(monitorStore);
	} catch (error) {
		void Promise.allSettled([
			store.close(),
			monitorStore?.close(),
			files?.close(),
			evaluation?.close(),
			evaluationScoring?.close(),
		]);
		throw error;
	}
	let stopped = false;
	let closing: Promise<void> | undefined;
	let scorerTimer: ReturnType<typeof setTimeout> | undefined;
	let scorerRunning: Promise<void> | undefined;
	async function pollScorer() {
		try {
			await evaluationScoring?.runOnce();
		} catch {
			logSafely(
				JSON.stringify({
					service: "platform-worker",
					code: "EVALUATION_SCORE_UNAVAILABLE",
				}),
			);
		} finally {
			if (!stopped)
				scorerTimer = setTimeout(() => {
					scorerRunning = pollScorer();
				}, pollIntervalMs);
		}
	}
	function createPoller(current: typeof reconciliation, maintenance: boolean) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let running: Promise<void> | undefined;
		let tickTail: Promise<void> = Promise.resolve();
		// 轮询连续推进的步数，达到上限后休眠一次，防止反复到期的步骤形成热循环。
		let consecutiveSteps = 0;
		function enqueueTick(polling = false) {
			const result = tickTail.then(async () => {
				let outcome: "idle" | "advanced" | undefined;
				const startedAt = performance.now();
				try {
					outcome = await current.tick(workerId);
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
					if (maintenance && !draining) {
						await files?.runOnce();
						await evaluation?.runOnce();
					}
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
			// 每条通道独立、有界地连续推进；同 Agent 的互斥与重试仍由 Store 控制。
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
			tick: () => enqueueTick(),
			start() {
				if (!running) running = poll();
			},
			drain() {
				clearTimeout(timer);
				return Promise.all([running, tickTail]);
			},
		};
	}
	// 独立 Store 持不同 advisory-lock 连接，两个通道仍在同一 Agent 锁下互斥。
	const lifecycle = createPoller(reconciliation, true);
	const monitor = createPoller(monitorReconciliation, false);
	const manualTicks = new Set<Promise<void>>();
	let started = false;
	return {
		tick: () => {
			if (stopped)
				return Promise.reject(new Error("Platform Worker is stopped"));
			const result = lifecycle
				.tick()
				.then((outcome) => (outcome === "advanced" ? outcome : monitor.tick()));
			const completion = result.then(
				() => {
					manualTicks.delete(completion);
				},
				() => {
					manualTicks.delete(completion);
				},
			);
			manualTicks.add(completion);
			return result;
		},
		start() {
			if (started || stopped) return;
			started = true;
			logSafely(
				JSON.stringify({ service: "platform-worker", status: "ready" }),
			);
			lifecycle.start();
			monitor.start();
			if (evaluationScoring) scorerRunning = pollScorer();
		},
		stop() {
			if (closing) return closing;
			stopped = true;
			clearTimeout(scorerTimer);
			const drained = Promise.allSettled([
				evaluationScoring?.close(),
				scorerRunning,
				lifecycle.drain(),
				monitor.drain(),
				...manualTicks,
			]);
			closing = (async () => {
				const outcomes = await drained;
				const cleanup = await Promise.allSettled([
					store.close(),
					monitorStore?.close(),
					files?.close(),
					evaluation?.close(),
				]);
				const failed = [...outcomes, ...cleanup].find(
					(result) => result.status === "rejected",
				);
				if (failed?.status === "rejected") throw failed.reason;
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
