import type { PlatformWorkerNativeMetadataGatewayServerOptionsV1 } from "./runtime-native-metadata-server.js";

export async function createPlatformNativeMetadataGatewayOptionsV1(
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const moduleSpecifier = process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE;
	if (!moduleSpecifier) return undefined;
	const deployment = (await import(moduleSpecifier)) as {
		createPlatformNativeMetadataGatewayOptionsV1?: (
			signal: AbortSignal,
		) =>
			| PlatformWorkerNativeMetadataGatewayServerOptionsV1
			| undefined
			| Promise<PlatformWorkerNativeMetadataGatewayServerOptionsV1 | undefined>;
	};
	if (
		typeof deployment.createPlatformNativeMetadataGatewayOptionsV1 !==
		"function"
	)
		return undefined;
	const options =
		await deployment.createPlatformNativeMetadataGatewayOptionsV1(signal);
	if (options === undefined) return undefined;
	if (typeof options.app?.fetch !== "function")
		throw new Error("PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_INVALID");
	return options;
}
