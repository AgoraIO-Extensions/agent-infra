import { randomUUID } from "node:crypto";
import { createWorkloadReconciliationV1 } from "@agent-infra/platform-core";
import { openPostgresWorkloadReconciliationStoreV1 } from "@agent-infra/platform-store";
import {
	createWorkloadRuntimeV1,
	type WorkloadRuntimeOptionsV1,
} from "./workload-runtime.js";

export interface PlatformWorkloadWorkerOptionsV1
	extends Omit<WorkloadRuntimeOptionsV1, "workerId"> {
	readonly databaseUrl: string;
	readonly workerId?: string;
	readonly pollIntervalMs?: number;
	readonly maximumAttempts?: number;
	readonly log?: (message: string) => void;
}

export function createPlatformWorkloadWorkerV1(
	options: PlatformWorkloadWorkerOptionsV1,
) {
	const workerId = options.workerId ?? randomUUID();
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
	let reconciliation: ReturnType<typeof createWorkloadReconciliationV1>;
	try {
		reconciliation = createWorkloadReconciliationV1({
			store,
			runtime,
			maximumAttempts: options.maximumAttempts,
		});
	} catch (error) {
		void store.close().catch(() => undefined);
		throw error;
	}
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	const log = options.log ?? console.info;
	async function poll() {
		try {
			await reconciliation.tick(workerId);
		} catch {
			log(
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
		tick: () => reconciliation.tick(workerId),
		start() {
			if (running || stopped) return;
			log(JSON.stringify({ service: "platform-worker", status: "ready" }));
			running = poll();
		},
		stop() {
			if (closing) return closing;
			stopped = true;
			clearTimeout(timer);
			closing = (async () => {
				await running;
				await store.close();
			})();
			return closing;
		},
	};
}

export async function startPlatformWorkloadWorkerFromDeploymentV1(
	moduleSpecifier = process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE,
) {
	if (!moduleSpecifier)
		throw new Error("PLATFORM_WORKER_DEPLOYMENT_MODULE is required");
	let options: PlatformWorkloadWorkerOptionsV1;
	try {
		const deployment = (await import(moduleSpecifier)) as {
			createPlatformWorkloadWorkerOptionsV1():
				| Promise<PlatformWorkloadWorkerOptionsV1>
				| PlatformWorkloadWorkerOptionsV1;
		};
		options = await deployment.createPlatformWorkloadWorkerOptionsV1();
	} catch {
		throw new Error("Platform Worker deployment dependencies are unavailable");
	}
	const worker = createPlatformWorkloadWorkerV1(options);
	worker.start();
	return worker;
}
