import {
	createPlatformApiNativeMetadataCurrentClientV1,
	type PlatformApiNativeMetadataCurrentClientOptionsV1,
} from "./runtime-native-metadata-current-client.js";
import {
	createWorkerRuntimeNativeMetadataGatewayAppV1,
	createWorkerRuntimeNativeMetadataGatewayV1,
	type WorkerRuntimeNativeMetadataBindingResolverV1,
	type WorkerRuntimeNativeMetadataCurrentCheckerV1,
	type WorkerRuntimeNativeMetadataProofIssuerV1,
	type WorkerRuntimeNativeMetadataTransportResolverV1,
} from "./runtime-native-metadata-gateway.js";
import { createWorkerRuntimeNativeMetadataProofIssuerV1 } from "./runtime-native-metadata-proof.js";
import type { PlatformWorkerNativeMetadataGatewayServerOptionsV1 } from "./runtime-native-metadata-server.js";

export interface PlatformWorkerNativeMetadataGatewayPortsV1 {
	readonly binding: WorkerRuntimeNativeMetadataBindingResolverV1;
	/** Explicit test/deployment seam; takes precedence over platformApiCurrent. */
	readonly current?: WorkerRuntimeNativeMetadataCurrentCheckerV1;
	/** Optional production Platform API current-confirmation input. */
	readonly platformApiCurrent?: PlatformApiNativeMetadataCurrentClientOptionsV1;
	/** Optional when deployment uses the same Worker signing key for proof. */
	readonly proofIssuer?: WorkerRuntimeNativeMetadataProofIssuerV1;
	readonly transport: WorkerRuntimeNativeMetadataTransportResolverV1;
	readonly port?: number;
}

export function createPlatformNativeMetadataGatewayAssemblyV1(options: {
	readonly serviceToken: string;
	readonly signing?: {
		readonly issuer: string;
		readonly workerId: string;
		readonly keyId: string;
		readonly privateKey: import("node:crypto").KeyObject;
		readonly now?: () => number;
	};
	readonly ports: PlatformWorkerNativeMetadataGatewayPortsV1;
}): PlatformWorkerNativeMetadataGatewayServerOptionsV1 {
	if (!/^[\x21-\x7e]{1,8192}$/.test(options.serviceToken))
		throw new TypeError("Platform Worker service token is invalid");
	const proofIssuer =
		options.ports.proofIssuer ??
		(options.signing
			? createWorkerRuntimeNativeMetadataProofIssuerV1({
					issuer: options.signing.issuer,
					workerId: options.signing.workerId,
					keyVersion: options.signing.keyId,
					privateKey: options.signing.privateKey,
					...(options.signing.now ? { now: options.signing.now } : {}),
				})
			: undefined);
	if (!proofIssuer)
		throw new TypeError(
			"Platform Worker native metadata proof issuer is unavailable",
		);
	const current =
		options.ports.current ??
		(options.ports.platformApiCurrent
			? createPlatformApiNativeMetadataCurrentClientV1(
					options.ports.platformApiCurrent,
				)
			: { check: async () => ({ outcome: "unavailable" as const }) });
	const gateway = createWorkerRuntimeNativeMetadataGatewayV1({
		...options.ports,
		current,
		proofIssuer,
	});
	return {
		app: createWorkerRuntimeNativeMetadataGatewayAppV1({
			serviceToken: options.serviceToken,
			gateway,
			current,
		}),
		...(options.ports.port === undefined ? {} : { port: options.ports.port }),
	};
}
