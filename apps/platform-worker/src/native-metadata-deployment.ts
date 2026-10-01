import { serve } from "@hono/node-server";
import { createPlatformNativeMetadataAppV1 } from "./native-metadata-app.js";
import { createPlatformNativeMetadataReadWorkerV1 } from "./native-metadata-runtime.js";

export interface PlatformNativeMetadataWorkerOptionsV1 {
	readonly hostname: string;
	readonly port: number;
	readonly apiSources: ReadonlyMap<string, string>;
	readonly hosts: ReadonlyMap<string, string>;
	readonly runtime: Parameters<
		typeof createPlatformNativeMetadataReadWorkerV1
	>[0];
}

/** Starts inside the existing Worker process; the deployment supplies all instance mappings. */
export async function startPlatformNativeMetadataWorkerV1(
	options: PlatformNativeMetadataWorkerOptionsV1,
	signal: AbortSignal,
) {
	if (
		!options.hostname ||
		options.hostname.trim() !== options.hostname ||
		!Number.isSafeInteger(options.port) ||
		options.port < 1 ||
		options.port > 65_535
	)
		throw new TypeError("Metadata listener configuration is invalid");
	signal.throwIfAborted();
	const reads = createPlatformNativeMetadataReadWorkerV1(options.runtime);
	let server: ReturnType<typeof serve> | undefined;
	let stopping: Promise<void> | undefined;
	const onAbort = () => {
		void stop().catch(() => undefined);
	};
	function stop(): Promise<void> {
		stopping ??= (async () => {
			signal.removeEventListener("abort", onAbort);
			reads.close();
			if (!server) return;
			if ("closeAllConnections" in server) server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => {
					if (
						error &&
						(!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING")
					)
						reject(error);
					else resolve();
				});
			});
		})();
		return stopping;
	}
	try {
		const app = createPlatformNativeMetadataAppV1({
			reads,
			apiSources: options.apiSources,
			hosts: options.hosts,
		});
		let interrupted = () => {};
		try {
			await new Promise<void>((resolve, reject) => {
				server = serve(
					{ fetch: app.fetch, hostname: options.hostname, port: options.port },
					() => resolve(),
				);
				server.on("error", () => {
					reads.close();
					reject(new Error("Metadata listener is unavailable"));
				});
				interrupted = () => reject(new Error("Metadata startup interrupted"));
				signal.addEventListener("abort", interrupted, { once: true });
				if (signal.aborted) interrupted();
			});
		} finally {
			signal.removeEventListener("abort", interrupted);
		}
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			await stop();
			signal.throwIfAborted();
		}
		return { stop };
	} catch (error) {
		await stop().catch(() => undefined);
		throw error;
	}
}

export async function startPlatformNativeMetadataWorkerFromDeploymentV1(
	moduleSpecifier = process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE,
	signal: AbortSignal = new AbortController().signal,
) {
	if (!moduleSpecifier)
		throw new Error("PLATFORM_WORKER_DEPLOYMENT_MODULE is required");
	let options: PlatformNativeMetadataWorkerOptionsV1;
	try {
		signal.throwIfAborted();
		const deployment = (await import(moduleSpecifier)) as {
			createPlatformNativeMetadataWorkerOptionsV1(
				signal: AbortSignal,
			):
				| PlatformNativeMetadataWorkerOptionsV1
				| Promise<PlatformNativeMetadataWorkerOptionsV1>;
		};
		signal.throwIfAborted();
		options =
			await deployment.createPlatformNativeMetadataWorkerOptionsV1(signal);
		signal.throwIfAborted();
	} catch {
		throw new Error("Metadata Worker deployment dependencies are unavailable");
	}
	return startPlatformNativeMetadataWorkerV1(options, signal);
}
