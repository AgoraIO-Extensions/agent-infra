import type { KeyObject } from "node:crypto";
import type { RuntimeModelDirectoryDispatchRequestV1 } from "@agent-infra/contracts/runtime";
import { createWorkerRuntimeModelDirectoryGrantSignerV1 } from "./runtime-grant-signer.js";
import type { WorkerRuntimeHostClientV1 } from "./runtime-host-client.js";
import {
	createWorkerRuntimeModelDirectoryApp,
	createWorkerRuntimeModelDirectoryReaderV1,
} from "./runtime-model-directory-service.js";
import type { PlatformWorkerInternalGatewayServerOptionsV1 } from "./runtime-native-metadata-server.js";

export interface PlatformWorkerRuntimeModelDirectoryPortsV1 {
	readonly resolveRuntimeHost: (
		request: RuntimeModelDirectoryDispatchRequestV1,
		signal: AbortSignal,
	) => Promise<WorkerRuntimeHostClientV1>;
	readonly signGrant: Parameters<
		typeof createWorkerRuntimeModelDirectoryReaderV1
	>[0]["signGrant"];
	readonly port?: number;
}

/** Deployment configuration may omit the signer; the Worker supplies it. */
export type PlatformWorkerRuntimeModelDirectoryDeploymentPortsV1 = Omit<
	PlatformWorkerRuntimeModelDirectoryPortsV1,
	"signGrant"
> & {
	readonly signGrant?: PlatformWorkerRuntimeModelDirectoryPortsV1["signGrant"];
};

/**
 * Complete the deployment seam with the Worker-owned Grant signer. The Host
 * resolver remains deployment-owned because only deployment code knows the
 * instance-local RuntimeHost address and Session routing.
 */
export function createPlatformRuntimeModelDirectoryPortsV1(options: {
	readonly resolveRuntimeHost: PlatformWorkerRuntimeModelDirectoryDeploymentPortsV1["resolveRuntimeHost"];
	readonly signing: {
		readonly issuer: string;
		readonly keyId: string;
		readonly privateKey: KeyObject;
		readonly now?: () => number;
		readonly id?: () => string;
	};
	readonly signGrant?: PlatformWorkerRuntimeModelDirectoryDeploymentPortsV1["signGrant"];
	readonly port?: PlatformWorkerRuntimeModelDirectoryDeploymentPortsV1["port"];
}) {
	const signGrant: NonNullable<
		PlatformWorkerRuntimeModelDirectoryPortsV1["signGrant"]
	> =
		options.signGrant ??
		createWorkerRuntimeModelDirectoryGrantSignerV1(options.signing);
	return {
		resolveRuntimeHost: options.resolveRuntimeHost,
		signGrant,
		...(options.port === undefined ? {} : { port: options.port }),
	};
}

export function createPlatformRuntimeModelDirectoryGatewayV1(options: {
	readonly serviceToken: string;
	readonly ports: PlatformWorkerRuntimeModelDirectoryPortsV1;
}): PlatformWorkerInternalGatewayServerOptionsV1 {
	const reader = createWorkerRuntimeModelDirectoryReaderV1({
		resolveRuntimeHost: options.ports.resolveRuntimeHost,
		signGrant: options.ports.signGrant,
	});
	return {
		app: createWorkerRuntimeModelDirectoryApp({
			serviceToken: options.serviceToken,
			reader,
		}),
		port: options.ports.port ?? 3_005,
	};
}

export async function createPlatformRuntimeModelDirectoryOptionsV1(
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const moduleSpecifier = process.env.PLATFORM_WORKER_DEPLOYMENT_MODULE;
	if (!moduleSpecifier) return undefined;
	const deployment = (await import(moduleSpecifier)) as {
		createPlatformRuntimeModelDirectoryOptionsV1?: (
			signal: AbortSignal,
		) =>
			| PlatformWorkerInternalGatewayServerOptionsV1
			| undefined
			| Promise<PlatformWorkerInternalGatewayServerOptionsV1 | undefined>;
	};
	if (
		typeof deployment.createPlatformRuntimeModelDirectoryOptionsV1 !==
		"function"
	)
		return undefined;
	return deployment.createPlatformRuntimeModelDirectoryOptionsV1(signal);
}
