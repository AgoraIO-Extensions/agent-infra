import type { PlatformWorkerInternalGatewayServerOptionsV1 } from "./runtime-native-metadata-server.js";

/** Load the deployment-owned Worker reader without exposing its decryptor to API. */
export async function createPlatformSavedKeyCandidatesOptionsV1(
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const moduleSpecifier = process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE;
	if (!moduleSpecifier) return undefined;
	const deployment = (await import(moduleSpecifier)) as {
		createPlatformSavedKeyCandidatesOptionsV1?: (
			signal: AbortSignal,
		) =>
			| PlatformWorkerInternalGatewayServerOptionsV1
			| undefined
			| Promise<PlatformWorkerInternalGatewayServerOptionsV1 | undefined>;
	};
	if (
		typeof deployment.createPlatformSavedKeyCandidatesOptionsV1 !== "function"
	)
		return undefined;
	return deployment.createPlatformSavedKeyCandidatesOptionsV1(signal);
}
