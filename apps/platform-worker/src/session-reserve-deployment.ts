import { createPlatformSessionReserveWorkerV1 } from "./session-reserve-worker.js";

type ReserveOptions = Parameters<
	typeof createPlatformSessionReserveWorkerV1
>[0];

/** Optional trusted deployment module seam; absence keeps pre-reserve deployments unchanged. */
export async function startPlatformSessionReserveWorkerFromDeploymentV1(
	moduleSpecifier = process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE,
	signal?: AbortSignal,
) {
	if (!moduleSpecifier) return undefined;
	const assemblySignal = signal ?? new AbortController().signal;
	assemblySignal.throwIfAborted();
	let worker:
		| ReturnType<typeof createPlatformSessionReserveWorkerV1>
		| undefined;
	try {
		const deployment = (await import(moduleSpecifier)) as {
			createPlatformSessionReserveWorkerOptionsV1?: (
				signal: AbortSignal,
			) => Promise<ReserveOptions | undefined> | ReserveOptions | undefined;
		};
		const factory = deployment.createPlatformSessionReserveWorkerOptionsV1;
		if (factory === undefined) return undefined;
		if (typeof factory !== "function") throw new Error();
		const options = await factory(assemblySignal);
		assemblySignal.throwIfAborted();
		if (options === undefined) return undefined;
		worker = createPlatformSessionReserveWorkerV1({
			...options,
			signal: assemblySignal,
		});
		worker.start();
		return worker;
	} catch {
		await worker?.stop().catch(() => undefined);
		throw new Error("SESSION_RESERVE_DEPLOYMENT_UNAVAILABLE");
	}
}
