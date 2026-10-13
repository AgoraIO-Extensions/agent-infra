import {
	createWorkerRuntimeNativeMetadataGatewayAppV1,
	createWorkerRuntimeNativeMetadataGatewayV1,
	type WorkerRuntimeNativeMetadataBindingResolverV1,
	type WorkerRuntimeNativeMetadataCurrentCheckerV1,
	type WorkerRuntimeNativeMetadataProofIssuerV1,
	type WorkerRuntimeNativeMetadataTransportResolverV1,
} from "./runtime-native-metadata-gateway.js";
import type { PlatformWorkerNativeMetadataGatewayServerOptionsV1 } from "./runtime-native-metadata-server.js";

export interface PlatformWorkerNativeMetadataGatewayPortsV1 {
	readonly binding: WorkerRuntimeNativeMetadataBindingResolverV1;
	readonly current: WorkerRuntimeNativeMetadataCurrentCheckerV1;
	readonly proofIssuer: WorkerRuntimeNativeMetadataProofIssuerV1;
	readonly transport: WorkerRuntimeNativeMetadataTransportResolverV1;
	readonly port?: number;
}

export function createPlatformNativeMetadataGatewayAssemblyV1(options: {
	readonly serviceToken: string;
	readonly ports: PlatformWorkerNativeMetadataGatewayPortsV1;
}): PlatformWorkerNativeMetadataGatewayServerOptionsV1 {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("Platform Worker service token is invalid");
	const gateway = createWorkerRuntimeNativeMetadataGatewayV1(options.ports);
	return {
		app: createWorkerRuntimeNativeMetadataGatewayAppV1({
			serviceToken: options.serviceToken,
			gateway,
		}),
		...(options.ports.port === undefined ? {} : { port: options.ports.port }),
	};
}
