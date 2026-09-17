import { randomUUID } from "node:crypto";
import { createWorkloadReconciliationV1 } from "@agent-infra/platform-core";
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
	readonly log?: (message: string) => void;
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
	const runtime = createWorkloadRuntimeV1({ ...options, workerId });
	const store = openPostgresWorkloadReconciliationStoreV1({
		databaseUrl: options.databaseUrl,
		retryDelayMs: pollIntervalMs,
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
		reconciliation = createWorkloadReconciliationV1({
			store,
			runtime,
			maximumAttempts: options.maximumAttempts,
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
	const log = options.log ?? console.info;
	function logSafely(message: string) {
		try {
			log(message);
		} catch {
			// Logging is observational and must not stop reconciliation.
		}
	}
	function enqueueTick() {
		const result = tickTail.then(async () => {
			try {
				return await reconciliation.tick(workerId);
			} finally {
				await files?.runOnce();
			}
		});
		tickTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	async function poll() {
		try {
			await enqueueTick();
		} catch {
			logSafely(
				JSON.stringify({
					service: "platform-worker",
					status: "retrying",
					code: "WORKLOAD_RECONCILIATION_UNAVAILABLE",
				}),
			);
		}
		if (!stopped)
			timer = setTimeout(() => {
				running = poll();
			}, pollIntervalMs);
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
	const worker = createPlatformWorkloadWorkerV1(options);
	if (assemblySignal.aborted) await worker.stop();
	else worker.start();
	return worker;
}
