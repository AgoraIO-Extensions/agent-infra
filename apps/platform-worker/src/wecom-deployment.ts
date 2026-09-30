import type { createPlatformWecomWorkerV1 } from "./wecom-worker.js";

type WecomWorker = ReturnType<typeof createPlatformWecomWorkerV1>;
type WecomLoop = Pick<WecomWorker, "reconcile" | "dispatch" | "close">;

export function startPlatformWecomPollingWorkerV1(
	worker: WecomLoop,
	options: {
		readonly intervalMs?: number;
		readonly log?: (code: string) => void;
	} = {},
) {
	const intervalMs = options.intervalMs ?? 1_000;
	if (
		!Number.isSafeInteger(intervalMs) ||
		intervalMs < 1 ||
		intervalMs > 30_000
	)
		throw new TypeError("WeCom Worker polling interval is invalid");
	let stopped = false;
	let closing: Promise<void> | undefined;
	let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
	let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
	let reconciling = Promise.resolve();
	let dispatching = Promise.resolve();
	const log = (code: string) => {
		try {
			(options.log ?? console.info)(code);
		} catch {
			// Observation cannot interrupt the channel loop.
		}
	};
	const reconcile = () => {
		if (stopped) return;
		reconciling = Promise.resolve()
			.then(() => worker.reconcile())
			.catch(() => log("WECOM_RECONCILE_UNAVAILABLE"))
			.finally(() => {
				if (!stopped) reconcileTimer = setTimeout(reconcile, intervalMs);
			});
	};
	const dispatch = () => {
		if (stopped) return;
		dispatching = Promise.resolve()
			.then(() => worker.dispatch())
			.then(() => undefined)
			.catch(() => log("WECOM_DELIVERY_UNAVAILABLE"))
			.finally(() => {
				if (!stopped) dispatchTimer = setTimeout(dispatch, intervalMs);
			});
	};
	reconcileTimer = setTimeout(reconcile, 0);
	dispatchTimer = setTimeout(dispatch, 0);
	return {
		stop() {
			closing ??= (async () => {
				stopped = true;
				clearTimeout(reconcileTimer);
				clearTimeout(dispatchTimer);
				await Promise.allSettled([reconciling, dispatching]);
				await worker.close();
			})();
			return closing;
		},
	};
}

export async function startPlatformWecomWorkerFromDeploymentV1(
	moduleSpecifier = process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE,
	signal: AbortSignal = new AbortController().signal,
) {
	let worker: WecomLoop;
	try {
		if (!moduleSpecifier) throw new Error();
		signal.throwIfAborted();
		const deployment = (await import(moduleSpecifier)) as {
			createPlatformWecomWorkerInstanceV1?: (
				signal: AbortSignal,
			) => WecomLoop | Promise<WecomLoop>;
		};
		if (typeof deployment.createPlatformWecomWorkerInstanceV1 !== "function")
			throw new Error();
		signal.throwIfAborted();
		worker = await deployment.createPlatformWecomWorkerInstanceV1(signal);
		if (
			typeof worker?.reconcile !== "function" ||
			typeof worker.dispatch !== "function" ||
			typeof worker.close !== "function"
		)
			throw new Error();
	} catch {
		throw new Error("WeCom Worker deployment dependencies are unavailable");
	}
	if (signal.aborted) {
		try {
			await worker.close();
		} catch {
			throw new Error("WeCom Worker deployment dependencies are unavailable");
		}
		return { stop: async () => {} };
	}
	return startPlatformWecomPollingWorkerV1(worker);
}
